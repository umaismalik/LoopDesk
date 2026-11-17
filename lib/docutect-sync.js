// Two-way ticket sync with DocuTect (the product DocuTect's customers raise support tickets in).
//
// DocuTect → LoopDesk: DocuTect posts every new ticket, ticket change and thread message to
//   POST /api/integrations/docutect. The ticket appears in the LoopDesk project DOCUTECT_PROJECT_ID,
//   labelled with the DocuTect organization that raised it; customer messages join its history.
// LoopDesk → DocuTect: status / priority changes, the resolution and "Reply to customer" messages on
//   those tickets are queued in integration_outbox and posted to DocuTect's
//   /api/integrations/loopdesk/events. A delivery that fails stays queued and is retried with backoff
//   (on the next change and by /api/cron), so nothing is lost while DocuTect is unreachable.
//
// Both directions are signed with HMAC-SHA256 over "<unix seconds>.<raw body>" using the shared secret
// DOCUTECT_SYNC_SECRET (LOOPDESK_SYNC_SECRET on DocuTect's side); requests older than 5 minutes are
// refused. Changes that arrive from DocuTect are written straight to the database and never queued back,
// so the two systems cannot echo a change between them.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { remote, loadProjectTicketIds, putFile } from "./store";
import { sendEmail } from "./email";
import { bumpProjectVersion } from "./live-store";
import { DESCRIPTION_CHAR_LIMIT } from "./limits";
import { publicErrorMessage } from "./http-error";

const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
const H = (x = {}) => ({ apikey: K, ...(String(K).startsWith("sb_") ? {} : { Authorization: "Bearer " + K }), ...x });
const DATA = path.join(process.cwd(), "data"), DB = path.join(DATA, "db.json"), OUTBOX = path.join(DATA, "integration-outbox.json");
const J = (o, s = 200) => Response.json(o, { status: s, headers: { "Cache-Control": "no-store" } });
const enc = encodeURIComponent;
const uid = () => crypto.randomBytes(16).toString("hex");
const today = () => new Date().toISOString().slice(0, 10);
const clean = (value, max) => String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);

export const SIGNATURE_HEADER = "x-sync-signature";
export const TIMESTAMP_HEADER = "x-sync-timestamp";
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
// A screenshot (≈3 MB as base64) plus the ticket; Vercel's own request limit is 4.5 MB.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const MAX_MESSAGE = 20000;
const TARGET = "docutect";
const DELIVERY_TIMEOUT_MS = 8000;

const secret = () => process.env.DOCUTECT_SYNC_SECRET || "";
export const docutectProjectId = () => process.env.DOCUTECT_PROJECT_ID || "";
const docutectEventsUrl = () => (process.env.DOCUTECT_API_URL || "https://api.docutect.com").replace(/\/+$/, "") + "/api/integrations/loopdesk/events";
export const docutectSyncEnabled = () => !!(secret() && docutectProjectId());
const siteLink = () => { try { return new URL(process.env.APP_URL || "").origin; } catch { return ""; } };

// ---- Signing -----------------------------------------------------------------------------------

export const signBody = (key, timestamp, body) =>
  "sha256=" + crypto.createHmac("sha256", key).update(`${timestamp}.`).update(body).digest("hex");

export function signatureValid(key, timestamp, signature, body, now = Date.now()) {
  if (!key || !/^\d{1,12}$/.test(String(timestamp || "")) || !signature) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > MAX_CLOCK_SKEW_MS) return false;
  const expected = Buffer.from(signBody(key, timestamp, body)), given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// ---- Mapping DocuTect → LoopDesk ---------------------------------------------------------------

const TYPES = { issue: "issue", feature_request: "feature", question: "issue", support: "issue" };
// DocuTect question / support tickets become LoopDesk issues with a label.
const LABELS = { question: "Question", support: "Support" };
const PRIORITIES = { critical: "High", high: "High", medium: "Medium", low: "Low" };
// LoopDesk has finer steps than DocuTect; a step inside the same group is kept.
const STATUS_GROUPS = { open: ["Open", "Reopened"], in_progress: ["In Progress", "Testing"], resolved: ["Completed"], archived: ["Completed"] };

export function statusFromDocutect(docutectStatus, current) {
  const group = STATUS_GROUPS[docutectStatus];
  if (!group) return current || "Open";
  if (group.includes(current)) return current;
  if (docutectStatus === "open" && current === "Completed") return "Reopened";
  return group[0];
}

const dayOf = (iso) => /^\d{4}-\d{2}-\d{2}/.test(String(iso || "")) ? String(iso).slice(0, 10) : today();
const shortHash = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

// Applies one DocuTect event to the LoopDesk ticket (`current`, or null when it does not exist yet).
// Pure: returns the new ticket, the field changes for the activity log and the notes it added.
// A DocuTect status or priority only overrides LoopDesk's when it changed in DocuTect since the last
// sync, so a later customer message does not undo what the support team set in LoopDesk.
export function mergeDocutectEvent(current, event, now = new Date()) {
  const source = event.ticket || {};
  const link = {
    id: clean(source.id, 64),
    org: clean(source.organization?.name, 120),
    orgId: clean(source.organization?.id, 64),
    user: clean(source.user?.name, 120),
    email: clean(source.user?.email, 200),
    type: clean(source.type, 30),
    label: LABELS[source.type] || "",
    priority: clean(source.priority, 20),
    blocking: !!source.is_blocking,
    status: clean(source.status, 20),
    adminResponse: clean(source.admin_response, MAX_MESSAGE),
    adminNotes: clean(source.admin_notes, MAX_MESSAGE),
    createdAt: clean(source.created_at, 40),
  };
  const changes = [], added = [];
  let ticket;
  if (!current) {
    const status = statusFromDocutect(link.status, "Open");
    ticket = {
      id: "", type: TYPES[link.type] || "issue", date: dayOf(link.createdAt), by: "Client",
      title: clean(source.title, 200) || "DocuTect ticket", priority: PRIORITIES[link.priority] || "Medium", assignees: [],
      details: clean(source.description, DESCRIPTION_CHAR_LIMIT), version: "", deployed: "", status,
      closed: status === "Completed" ? today() : "", createdBy: "", notes: [], resolution: "", docutect: link,
    };
  } else {
    ticket = JSON.parse(JSON.stringify(current));
    const previous = current.docutect || {};
    if (link.status && link.status !== previous.status) {
      const next = statusFromDocutect(link.status, ticket.status);
      if (next !== ticket.status) {
        changes.push({ field: "Status", old: ticket.status || "—", new: next });
        ticket.status = next;
        ticket.closed = next === "Completed" ? ticket.closed || today() : "";
      }
    }
    if (link.priority && link.priority !== previous.priority) {
      const next = PRIORITIES[link.priority];
      if (next && next !== ticket.priority) {
        changes.push({ field: "Priority", old: ticket.priority || "—", new: next });
        ticket.priority = next;
      }
    }
    if (link.adminNotes !== (previous.adminNotes || "")) changes.push({ field: "DocuTect internal note", old: previous.adminNotes || "—", new: link.adminNotes || "—" });
    ticket.docutect = { ...previous, ...link };
  }
  const notes = ticket.notes = [...(ticket.notes || [])];
  const supportTexts = new Set(notes.filter((n) => n.role === "support").map((n) => n.text));
  const addNote = (note) => {
    if (notes.some((n) => n.id === note.id)) return;
    notes.push(note); added.push(note);
    if (note.role === "support") supportTexts.add(note.text);
  };
  const message = event.type === "message" ? event.message : null;
  if (message?.id) {
    const role = message.role === "support" ? "support" : "customer";
    const text = clean(message.content, MAX_MESSAGE);
    // A support reply sent from LoopDesk is already in the history; DocuTect's copy is not added again.
    if (text && !(role === "support" && supportTexts.has(text))) {
      addNote({
        id: "dt-" + clean(message.id, 64), at: dayOf(message.created_at), time: clean(message.created_at, 40) || now.toISOString(),
        by: role === "support" ? "DocuTect Support" : `${clean(message.author, 120) || "Customer"} (customer)`, text, role, source: "docutect",
      });
    }
  }
  // A response written in DocuTect's admin panel without a thread message.
  if (link.adminResponse && link.adminResponse !== (current?.docutect?.adminResponse || "") && !supportTexts.has(link.adminResponse)) {
    addNote({ id: "dt-r-" + shortHash(link.adminResponse), at: today(), time: now.toISOString(), by: "DocuTect Support", text: link.adminResponse, role: "support", source: "docutect" });
  }
  return { ticket, created: !current, changes, added };
}

// ---- Mapping LoopDesk → DocuTect ---------------------------------------------------------------

// A LoopDesk edit of a DocuTect ticket: what DocuTect needs to hear about.
export function docutectEventsForEdit(before, after) {
  if (!before?.docutect?.id) return [];
  const base = { docutect_ticket_id: before.docutect.id, loopdesk_ticket_id: after.id, status: after.status, priority: after.priority || "" };
  const events = [];
  if (before.status !== after.status || (before.priority || "") !== (after.priority || "")) events.push({ id: "ld-" + uid(), type: "ticket", ...base });
  const resolution = clean(after.resolution, MAX_MESSAGE);
  if (resolution && resolution !== clean(before.resolution, MAX_MESSAGE)) {
    events.push({ id: "ld-" + uid(), type: "message", ...base, message: { id: uid(), content: "Resolution: " + resolution } });
  }
  return events;
}

// The browser posts the whole ticket list it holds. Keep the DocuTect link as the server has it (a browser
// cannot create or change one) and keep customer messages that arrived after the browser loaded the ticket.
export function keepDocutectFields(before, after) {
  if (!before?.docutect) { delete after.docutect; return; }
  after.docutect = before.docutect;
  const have = new Set((after.notes || []).map((n) => n.id).filter(Boolean));
  const missing = (before.notes || []).filter((n) => n.id && n.role && !have.has(n.id));
  if (missing.length) after.notes = [...(after.notes || []), ...missing];
}

// ---- Storage -------------------------------------------------------------------------------------

async function rest(pathAndQuery, init = {}) {
  const response = await fetch(`${U}/rest/v1/${pathAndQuery}`, { cache: "no-store", ...init, headers: H(init.headers || {}) });
  if (!response.ok) throw new Error(`Database request failed: ${response.status} ${await response.text()}`);
  return response.status === 204 || init.method === "DELETE" || init.method === "PATCH" ? null : response.json().catch(() => null);
}
const applyChanges = (changes) => rest("rpc/apply_workspace_changes", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ changes }) });
const isConflict = (error) => /Concurrent update detected|created by another request/.test(String(error?.message || error));
const withoutAssignees = ({ assignees, ...rest }) => rest;
const ticketRow = (projectId, t) => ({
  project_id: projectId, id: t.id, type: t.type || "", status: t.status || "", created_by: t.createdBy || "", title: t.title || "",
  date: t.date || null, due_date: t.deadline || null, payload: withoutAssignees(t),
});
const auditEvent = (who, act, detail) => ({ id: uid(), at: new Date().toISOString(), who, act, detail: detail || "" });
const readLocal = () => JSON.parse(fs.readFileSync(DB, "utf8"));
const writeLocal = (d) => { fs.writeFileSync(DB + ".tmp", JSON.stringify(d, null, 1)); fs.renameSync(DB + ".tmp", DB); };
const nextTicketId = (ids, type) => {
  const prefix = type === "feature" ? "FTR-" : "ISS-";
  const n = Math.max(0, ...ids.filter((id) => String(id).startsWith(prefix)).map((id) => parseInt(String(id).split("-").pop(), 10) || 0)) + 1;
  return prefix + String(n).padStart(2, "0");
};

// The ticket (with its database row, for the concurrency check) found by LoopDesk id or DocuTect id.
async function findTicket(projectId, { id, docutectId }) {
  if (!remote) {
    const project = (readLocal().projects || []).find((p) => p.id === projectId);
    const ticket = project?.tickets.find((t) => id ? t.id === id : t.docutect?.id === docutectId);
    return ticket ? { ticket: JSON.parse(JSON.stringify(ticket)), row: ticket } : null;
  }
  const filter = id ? `id=eq.${enc(id)}` : `payload->docutect->>id=eq.${enc(docutectId)}`;
  const [row] = (await rest(`tickets?project_id=eq.${enc(projectId)}&${filter}&select=*&limit=1`)) || [];
  if (!row) return null;
  const assignees = (await rest(`ticket_assignees?project_id=eq.${enc(projectId)}&ticket_id=eq.${enc(row.id)}&select=member_id`)) || [];
  return { ticket: { ...row.payload, id: row.id, assignees: assignees.map((a) => a.member_id) }, row };
}

// Saves a ticket with its activity-log entries. Fails with a conflict when the ticket changed since it
// was read (or, for a new ticket, when its id was taken meanwhile); the caller reads again and retries.
async function saveTicket(projectId, found, ticket, events, file) {
  if (!remote) {
    const d = readLocal();
    const project = d.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("The DocuTect project does not exist");
    const index = project.tickets.findIndex((t) => t.id === ticket.id);
    if (found ? index < 0 || JSON.stringify(project.tickets[index]) !== JSON.stringify(found.row) : index >= 0) throw new Error("Concurrent update detected");
    if (index >= 0) project.tickets[index] = ticket; else project.tickets.push(ticket);
    project.audit = [...events.slice().reverse(), ...(project.audit || [])].slice(0, 1000);
    if (file) project.files = [file, ...(project.files || [])];
    writeLocal(d);
    return;
  }
  await applyChanges({
    upserts: {
      tickets: [ticketRow(projectId, ticket)],
      project_audit: events.map((e) => ({ project_id: projectId, event_id: e.id, position: Date.parse(e.at), payload: e })),
      ...(file ? { project_files: [{ project_id: projectId, id: file.id, ticket_id: file.ticket, payload: file }] } : {}),
    },
    ...(found ? { expected: { tickets: [found.row] } } : { absent: { tickets: [{ project_id: projectId, id: ticket.id }] } }),
  });
}

// Reads, changes and saves one ticket, retrying when another request changed it in between.
async function updateTicket(projectId, key, change) {
  for (let attempt = 0; ; attempt += 1) {
    const found = await findTicket(projectId, key);
    const result = await change(found);
    if (!result || result.unchanged) return result;
    try {
      await saveTicket(projectId, found, result.ticket, result.events || [], result.file);
      return result;
    } catch (error) {
      if (!isConflict(error) || attempt >= 4) throw error;
    }
  }
}

async function projectPeople(projectId) {
  if (!remote) {
    const d = readLocal();
    const project = (d.projects || []).find((p) => p.id === projectId);
    if (!project) return null;
    const people = project.members.filter((m) => m.status !== "disabled").map((m) => {
      const member = d.members.find((x) => x.id === m.memberId);
      return member && member.status !== "disabled" ? { id: member.id, name: member.name, email: member.email, role: m.role } : null;
    }).filter(Boolean);
    return { name: project.name, people };
  }
  const [[project], rows] = await Promise.all([
    rest(`projects?id=eq.${enc(projectId)}&select=name&limit=1`),
    rest(`project_members?project_id=eq.${enc(projectId)}&status=neq.disabled&select=role,members(id,name,email,status)`),
  ]);
  if (!project) return null;
  return { name: project.name, people: (rows || []).filter((r) => r.members && r.members.status !== "disabled").map((r) => ({ ...r.members, role: r.role })) };
}

// The screenshot DocuTect sends with a new ticket, saved as an attachment. Only genuine PNG/JPEG data.
async function storeScreenshot(base64, ticketId) {
  const data = String(base64 || "").replace(/^data:image\/[a-z]+;base64,/i, "");
  if (!data || data.length > MAX_SCREENSHOT_BYTES * 1.4) return null;
  const buffer = Buffer.from(data, "base64");
  const hex = buffer.subarray(0, 8).toString("hex");
  const ext = hex.startsWith("89504e470d0a1a0a") ? "png" : hex.startsWith("ffd8ff") ? "jpg" : "";
  if (!ext || buffer.length > MAX_SCREENSHOT_BYTES) return null;
  const id = uid() + "." + ext;
  await putFile(id, buffer, ext === "png" ? "image/png" : "image/jpeg");
  return { id, name: `docutect-screenshot.${ext}`, size: buffer.length, cat: "Other", by: "DocuTect", at: today(), ticket: ticketId };
}

// ---- DocuTect → LoopDesk -----------------------------------------------------------------------

const html = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Applies one DocuTect event; returns the LoopDesk ticket id.
export async function applyDocutectEvent(event) {
  const projectId = docutectProjectId();
  const docutectId = clean(event?.ticket?.id, 64);
  if (!docutectId || !["ticket", "message"].includes(event?.type)) throw Object.assign(new Error("Invalid event"), { status: 400 });
  const project = await projectPeople(projectId);
  if (!project) throw new Error("DOCUTECT_PROJECT_ID does not name an existing LoopDesk project");
  let screenshot = null;
  const result = await updateTicket(projectId, { docutectId }, async (found) => {
    const merged = mergeDocutectEvent(found?.ticket || null, event);
    const { ticket } = merged;
    if (merged.created) ticket.id = nextTicketId((await loadProjectTicketIds(projectId)) || [], ticket.type);
    const who = "DocuTect" + (ticket.docutect.org ? " · " + ticket.docutect.org : "");
    const events = [];
    if (merged.created) events.push(auditEvent(who, "Created " + ticket.id, ticket.title));
    else if (merged.changes.length) events.push(auditEvent(who, "Updated " + ticket.id, merged.changes));
    merged.added.filter((n) => n.role === "customer").forEach((n) => events.push(auditEvent(who, "Customer replied on " + ticket.id, n.text.slice(0, 300))));
    merged.added.filter((n) => n.role === "support").forEach((n) => events.push(auditEvent(who, "DocuTect Support replied on " + ticket.id, n.text.slice(0, 300))));
    if (found && !merged.changes.length && !merged.added.length && JSON.stringify(found.ticket.docutect) === JSON.stringify(ticket.docutect)) return { ticket, merged, unchanged: true };
    return { ticket, merged, events };
  });
  if (!result) throw new Error("Could not save the DocuTect ticket");
  const { ticket, merged } = result;
  if (merged.created && event.ticket.screenshot) {
    // Saved after the ticket so a failed upload never loses the ticket itself.
    try {
      screenshot = await storeScreenshot(event.ticket.screenshot, ticket.id);
      if (screenshot) {
        if (remote) await applyChanges({ upserts: { project_files: [{ project_id: projectId, id: screenshot.id, ticket_id: ticket.id, payload: screenshot }] } });
        else { const d = readLocal(); const p = d.projects.find((x) => x.id === projectId); p.files = [screenshot, ...(p.files || [])]; writeLocal(d); }
      }
    } catch (error) {
      console.warn("DocuTect sync: could not save the screenshot of", ticket.id, error?.message || error);
    }
  }
  if (!result.unchanged) await bumpProjectVersion(projectId);
  await notifyTeam(project, ticket, merged).catch((error) => console.warn("DocuTect sync: notification failed:", error?.message || error));
  return ticket.id;
}

// New ticket → project admins. Customer message → the assignees (or the admins while nobody is assigned).
async function notifyTeam(project, ticket, merged) {
  const admins = project.people.filter((p) => p.role === "Admin");
  const link = siteLink();
  const open = link ? `<p><a href="${html(link)}">Open LoopDesk</a></p>` : "";
  const org = ticket.docutect.org || "a DocuTect customer";
  const sends = [];
  if (merged.created) {
    admins.forEach((p) => sends.push(sendEmail({
      to: p.email, subject: `New DocuTect ticket ${ticket.id} from ${org}`,
      html: `<p>Hello ${html(p.name)},</p><p><b>${html(ticket.docutect.user || ticket.docutect.email || "A customer")}</b> of <b>${html(org)}</b> raised <b>${html(ticket.id)}</b> — ${html(ticket.title)} in DocuTect. It is now in <b>${html(project.name)}</b>${ticket.docutect.label ? ` (${html(ticket.docutect.label)})` : ""}${ticket.docutect.blocking ? ", marked as blocking" : ""}.</p>${open}`,
    })));
  }
  const customer = merged.added.filter((n) => n.role === "customer");
  if (customer.length && !merged.created) {
    const assigned = project.people.filter((p) => (ticket.assignees || []).includes(p.id));
    (assigned.length ? assigned : admins).forEach((p) => sends.push(sendEmail({
      to: p.email, subject: `Customer replied on ${ticket.id} - ${ticket.title}`,
      html: `<p>Hello ${html(p.name)},</p><p>The customer (${html(org)}) replied on <b>${html(ticket.id)}</b>:</p><div style="white-space:pre-wrap;padding:10px 12px;border-left:3px solid #2563eb;background:#f8fafc">${html(customer.map((n) => n.text).join("\n\n"))}</div>${open}`,
    })));
  }
  await Promise.all(sends);
}

// POST /api/integrations/docutect
export async function docutectWebhook(req) {
  if (!docutectSyncEnabled()) return J({ error: "DocuTect sync is not configured" }, 503);
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return J({ error: "Request too large" }, 413);
  if (!signatureValid(secret(), req.headers.get(TIMESTAMP_HEADER), req.headers.get(SIGNATURE_HEADER), raw)) return J({ error: "Invalid signature" }, 401);
  let event;
  try { event = JSON.parse(raw); } catch { return J({ error: "Invalid JSON" }, 400); }
  try {
    return J({ ok: true, ticketId: await applyDocutectEvent(event) });
  } catch (error) {
    if (error?.status === 400) return J({ error: error.message }, 400);
    return J({ error: publicErrorMessage(error, "DocuTect sync") }, 500);
  }
}

// ---- LoopDesk → DocuTect -----------------------------------------------------------------------

// "Reply to customer": the message goes to the ticket's DocuTect thread and emails the customer there.
export async function replyToDocutectCustomer(projectId, ticketId, me, text) {
  const body = clean(text, 5000);
  const result = await updateTicket(projectId, { id: ticketId }, async (found) => {
    if (!found?.ticket.docutect?.id) return null;
    const ticket = JSON.parse(JSON.stringify(found.ticket));
    const now = new Date().toISOString();
    ticket.notes = [...(ticket.notes || []), { id: "ld-" + uid(), at: today(), time: now, by: me.name, text: body, role: "support", source: "loopdesk" }];
    ticket.docutect = { ...ticket.docutect, adminResponse: body };
    return { ticket, events: [auditEvent(me.name, "Replied to customer on " + ticket.id, body.slice(0, 300))] };
  });
  if (!result) return null;
  const { ticket } = result;
  await queueDocutectEvents([{ id: "ld-" + uid(), type: "message", docutect_ticket_id: ticket.docutect.id, loopdesk_ticket_id: ticket.id, status: ticket.status, priority: ticket.priority || "", message: { id: ticket.notes[ticket.notes.length - 1].id, author: me.name, content: body } }]);
  return ticket;
}

async function outboxInsert(rows) {
  if (!remote) {
    const list = fs.existsSync(OUTBOX) ? JSON.parse(fs.readFileSync(OUTBOX, "utf8")) : [];
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(OUTBOX, JSON.stringify([...list, ...rows], null, 1));
    return;
  }
  await rest("integration_outbox", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(rows) });
}
async function outboxDue(limit) {
  const now = Date.now();
  if (!remote) {
    const list = fs.existsSync(OUTBOX) ? JSON.parse(fs.readFileSync(OUTBOX, "utf8")) : [];
    return list.filter((r) => r.target === TARGET && r.next_attempt_at <= now).sort((a, b) => a.created_at - b.created_at).slice(0, limit);
  }
  return (await rest(`integration_outbox?target=eq.${TARGET}&next_attempt_at=lte.${now}&order=created_at.asc,id.asc&limit=${limit}`)) || [];
}
async function outboxDone(id) {
  if (!remote) {
    const list = fs.existsSync(OUTBOX) ? JSON.parse(fs.readFileSync(OUTBOX, "utf8")) : [];
    fs.writeFileSync(OUTBOX, JSON.stringify(list.filter((r) => r.id !== id), null, 1));
    return;
  }
  await rest(`integration_outbox?id=eq.${enc(id)}`, { method: "DELETE" });
}
async function outboxRetry(row, error) {
  const attempts = row.attempts + 1;
  const patch = { attempts, next_attempt_at: Date.now() + Math.min(30000 * 2 ** Math.min(attempts - 1, 7), 3600000), last_error: String(error).slice(0, 500) };
  if (!remote) {
    const list = fs.existsSync(OUTBOX) ? JSON.parse(fs.readFileSync(OUTBOX, "utf8")) : [];
    fs.writeFileSync(OUTBOX, JSON.stringify(list.map((r) => r.id === row.id ? { ...r, ...patch } : r), null, 1));
    return;
  }
  await rest(`integration_outbox?id=eq.${enc(row.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(patch) });
}

// Queues events for DocuTect and delivers them (with anything still waiting) right away.
export async function queueDocutectEvents(events) {
  if (!docutectSyncEnabled() || !events.length) return;
  const now = Date.now();
  await outboxInsert(events.map((payload, index) => ({
    id: payload.id, target: TARGET, ticket_ref: payload.docutect_ticket_id, payload, attempts: 0, next_attempt_at: now, last_error: "", created_at: now + index,
  })));
  await deliverDocutectOutbox();
}

async function post(payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    const response = await fetch(docutectEventsUrl(), {
      method: "POST", body, cache: "no-store", signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signBody(secret(), timestamp, body) },
    });
    if (response.ok) return { ok: true };
    // The ticket is gone or the event is malformed: retrying cannot help.
    const permanent = [400, 404, 413, 422].includes(response.status);
    return { ok: false, permanent, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}` };
  } catch (error) {
    return { ok: false, error: `${error?.name || "Error"}: ${error?.message || error}` };
  }
}

// Sends every due event in order. When one event of a ticket fails, that ticket's later events wait.
export async function deliverDocutectOutbox({ limit = 25 } = {}) {
  if (!docutectSyncEnabled()) return { delivered: 0 };
  const rows = await outboxDue(limit);
  const blocked = new Set();
  let delivered = 0;
  for (const row of rows) {
    if (blocked.has(row.ticket_ref)) continue;
    const result = await post(row.payload);
    if (result.ok || result.permanent) {
      if (!result.ok) console.warn("DocuTect sync: dropped event", row.id, "-", result.error);
      else delivered += 1;
      await outboxDone(row.id);
    } else {
      blocked.add(row.ticket_ref);
      console.warn("DocuTect sync: delivery failed, will retry:", result.error);
      await outboxRetry(row, result.error);
    }
  }
  return { delivered };
}
