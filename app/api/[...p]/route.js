import path from "path";
import crypto from "crypto";
import { SEED } from "../../../lib/seed";
import { sendEmail, emailStatus } from "../../../lib/email";
import { getWorkspaceMemberCount, loadDb, loadLoginDb, loadPublicFlowDb, saveDb, createLoginSession, putFile, getFile, delFile, remote } from "../../../lib/store";
import { check } from "../../../lib/reminders";

export const dynamic = "force-dynamic";
const load = (scope) => loadDb(() => ({ tickets: SEED, members: [], invites: [], meetings: [] }), scope);
const save = async (d) => {
  const activeProject = d._activeProject;
  const data = { ...d };
  delete data._activeProject;
  delete data._activeProjectId;
  if (activeProject) {
    activeProject.tickets = d.tickets; activeProject.files = d.files; activeProject.audit = d.audit;
    delete data.tickets; delete data.files; delete data.audit;
  }
  await saveDb(data, d);
};
const uid = () => crypto.randomBytes(16).toString("hex");
const J = (o, s = 200, headers = {}) => Response.json(o, { status: s, headers });
const isWorkspaceWriteBusy = (error) => {
  const message = String(error?.message || error);
  return /"code"\s*:\s*"55P03"/.test(message) || message.includes("Workspace write is busy; retry shortly.");
};
const googleOAuthConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const googleRedirectUri = (origin) => new URL("/api/google-meet?action=callback", siteUrl(origin)).toString();
const sealGoogleToken = (token) => {
  const key = crypto.createHash("sha256").update(process.env.GOOGLE_CLIENT_SECRET || "").digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
};
const openGoogleToken = (sealed) => {
  const [iv, tag, encrypted] = String(sealed || "").split(".").map((part) => Buffer.from(part, "base64url"));
  const key = crypto.createHash("sha256").update(process.env.GOOGLE_CLIENT_SECRET || "").digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
};
const googleCalendarForOrganization = (d, organizationId) => d.googleCalendars?.[organizationId];
async function googleAccessToken(d, organizationId) {
  const calendar = googleCalendarForOrganization(d, organizationId);
  if (!googleOAuthConfigured() || !calendar?.refreshToken) {
    throw new Error("Connect a Google Calendar account first. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: openGoogleToken(calendar.refreshToken),
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error("Google Calendar authorization expired. Disconnect and reconnect the Google account.");
  }
  return result.access_token;
}
async function createGoogleMeetEvent(d, meeting, timeZone, organizationId) {
  const accessToken = await googleAccessToken(d, organizationId);
  const [year, month, day] = meeting.date.split("-").map(Number);
  const [hour, minute] = meeting.time.split(":").map(Number);
  const endDateTime = new Date(Date.UTC(year, month - 1, day, hour, minute + meeting.duration)).toISOString().slice(0, 19);
  const eventsUrl = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const eventUrl = `${eventsUrl}/${meeting.id}`;
  let response = await fetch(`${eventsUrl}?conferenceDataVersion=1&sendUpdates=none`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: meeting.id,
      summary: meeting.title,
      description: meeting.agenda,
      start: { dateTime: `${meeting.date}T${meeting.time}:00`, timeZone },
      end: { dateTime: endDateTime, timeZone },
      conferenceData: {
        createRequest: {
          requestId: `${meeting.id}-${uid()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    }),
    cache: "no-store",
  });
  let event = await response.json();
  if (response.status === 409) {
    response = await fetch(eventUrl, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    event = await response.json();
  }
  if (!response.ok) {
    const message = event.error?.message || "Google Calendar could not create the meeting";
    if (response.status === 401) throw new Error("Google Calendar authorization expired. Disconnect and reconnect the Google account.");
    throw new Error(message);
  }
  let meetLink = event.hangoutLink || event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri;
  for (let attempt = 0; !meetLink && attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    response = await fetch(eventUrl, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    if (!response.ok) break;
    event = await response.json();
    meetLink = event.hangoutLink || event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri;
  }
  if (!meetLink) {
    const cleanup = await fetch(eventUrl, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    if (!cleanup.ok && cleanup.status !== 404) throw new Error("Google did not return a Meet link and the temporary calendar event could not be removed. Check Google Calendar before retrying.");
    throw new Error("Google created the calendar event but did not return a Meet link yet. The temporary event was removed; please try again in a moment.");
  }
  return { meetLink, eventId: event.id };
}
const pub = (m) => ({ id: m.id, name: m.name, email: m.email, phone: m.phone || "", role: m.role, hasPw: !!m.pw, status: m.status || "active" });
const ROLES = ["Admin", "Developer", "Collaborator", "Client"];
const td = () => new Date().toISOString().slice(0, 10);
const esc = (v) => String(v).replace(/[<>&"]/g, "");
const emailHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const emails = (d, ids) => d.members.filter((m) => ids.includes(m.id) && m.status !== "disabled" && d._activeProject.members.some((x) => x.memberId === m.id && x.status !== "disabled")).map((m) => m.email);
const CATS = ["Requirements & Design", "Reports & Releases", "Guides & Communication", "Other"];
const claim = (d, m) => (d.projects || [{ tickets: d.tickets || [] }]).forEach((project) => project.tickets.forEach((t) => {
  const tk = String(t.owner || "").toLowerCase().split(/[;&,\n]/).map((x) => x.replace(/\(.*?\)/g, "").trim()).filter((x) => x.length > 2);
  if (tk.some((x) => m.name.toLowerCase().startsWith(x)) && !(t.assignees || []).includes(m.id)) t.assignees = [...(t.assignees || []), m.id];
}));
async function migrate(d) {
  const sd = Object.fromEntries(SEED.map((t) => [t.id, t]));
  d.tickets.forEach((t) => {
    (t.attachments || []).forEach((a) => d.files.push({ id: a.file, name: a.name, size: a.size, cat: a.cat, by: a.by, at: a.at }));
    delete t.attachments;
    const o = sd[t.id];
    if (o) { if (o.details.length > (t.details || "").length) t.details = o.details; t.owner = o.owner; }
    t.assignees = t.assignees || (t.assignee ? [t.assignee] : []); delete t.assignee;
  });
  d.members.forEach((m) => claim(d, m));
  d.v2 = true; await save(d);
}
const np = (v) => String(v || "").replace(/[^\d+]/g, "");
const hash = (p) => { const s = crypto.randomBytes(16).toString("hex"); return s + ":" + crypto.scryptSync(p, s, 64).toString("hex"); };
const verify = (p, h) => { if (!h) return false; const [s, x] = h.split(":"); return crypto.timingSafeEqual(crypto.scryptSync(p, s, 64), Buffer.from(x, "hex")); };
const fails = new Map();
const SESSION = 30 * 864e5, CONFIGURED_SITE = process.env.APP_URL || "";
const siteUrl = (origin) => {
  if (!CONFIGURED_SITE || CONFIGURED_SITE.toLowerCase().includes("your-project.vercel.app")) return origin;
  try { return new URL(CONFIGURED_SITE).origin; } catch { return origin; }
};
// Links that a person opens from an email point back to the site the request came from, so a stale
// or mistyped APP_URL cannot send invitees to a deployment without this API. APP_URL is only the fallback.
const browserSiteUrl = (origin) => {
  try { const parsed = new URL(origin); if (/^https?:$/.test(parsed.protocol) && parsed.hostname) return parsed.origin; } catch {}
  return siteUrl(origin);
};
const live = (x) => { const t = +String(x).split(".")[1]; return !t || Date.now() - t < SESSION; };
const pwOk = (p) => p && p.length >= 8 && /[a-z]/i.test(p) && /\d/.test(p);
const PWMSG = "Password must be 8+ characters with at least one letter and one number";
const log = (d, who, act, detail) => { d.audit.unshift({ id: uid(), at: new Date().toISOString(), who, act, detail: detail || "" }); d.audit.length = Math.min(d.audit.length, 1000); };
const TICKET_AUDIT_FIELDS = [
  ["title", "Title"], ["type", "Type"], ["status", "Status"], ["priority", "Priority"],
  ["by", "Raised by"], ["date", "Raised date"], ["closed", "Completed date"],
  ["version", "Version"], ["deployed", "Deployed date"], ["deadline", "Deadline"],
  ["details", "Description"], ["resolution", "Resolution"], ["assignees", "Assignees"],
  ["createdBy", "Client"], ["notes", "History"],
];
const auditValue = (field, value, members) => {
  if (value === undefined || value === null || value === "") return "—";
  if (field === "assignees") return (Array.isArray(value) ? value : []).map((id) => memberName(members, id)).join(", ") || "Unassigned";
  if (field === "createdBy") return memberName(members, value);
  if (field === "notes") return JSON.stringify(value);
  return String(value);
};
const memberName = (members, id) => members.find((member) => member.id === id)?.name || String(id);
const deadlineLabel = (value) => {
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? `${date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC` : text;
};
const ticketChanges = (oldTicket, newTicket, members) => TICKET_AUDIT_FIELDS.flatMap(([field, label]) =>
  JSON.stringify(oldTicket[field]) === JSON.stringify(newTicket[field]) ? [] : [{
    field: label,
    old: auditValue(field, oldTicket[field], members),
    new: auditValue(field, newTicket[field], members),
  }]
);

async function send(to, subject, html) {
  const result = await sendEmail({ to, subject, html });
  if (!result.sent) console.error(`Email delivery failed for ${to} (${subject}): ${result.error}`);
  return result;
}
async function emailAssignedTasks(d, { tasks, previousTasks = [], title, projectName }) {
  const previousById = new Map(previousTasks.map((task) => [task.id, task]));
  const assignedByMember = new Map();
  tasks.filter((task) => {
    if (!task.assigneeId) return false;
    const previous = previousById.get(task.id);
    return !previous || previous.assigneeId !== task.assigneeId || previous.title !== task.title || previous.description !== task.description || previous.priority !== task.priority || previous.dueDate !== task.dueDate;
  }).forEach((task) => {
    const assigned = assignedByMember.get(task.assigneeId) || [];
    assigned.push(task);
    assignedByMember.set(task.assigneeId, assigned);
  });
  return Promise.all([...assignedByMember.entries()].map(async ([memberId, assignedTasks]) => {
    const member = d.members.find((item) => item.id === memberId && item.status !== "disabled");
    if (!member) return { sent: false, skipped: true };
    const lines = assignedTasks.map((task) => `<li>${emailHtml(task.title)} · ${emailHtml(task.priority || "Medium")} priority${task.description ? `<br>${emailHtml(task.description).replace(/\n/g, "<br>")}` : ""}${task.dueDate ? ` — due ${emailHtml(deadlineLabel(task.dueDate))}` : ""}</li>`).join("");
    const result = await send(member.email, `Action items assigned: ${title}`, `<p>Hello ${emailHtml(member.name)},</p><p>These action items from <b>${emailHtml(title)}</b>${projectName ? ` in <b>${emailHtml(projectName)}</b>` : ""} were assigned to you:</p><ul>${lines}</ul><p>Open the project portal → Meeting Notes to manage deadlines, status, and comments.</p>`);
    return { sent: result.sent, error: result.error, skipped: false };
  }));
}
const mail = (to, link, role, projectName) => send(to, "Project invitation: " + projectName, `<p>You have been invited as <b>${emailHtml(role)}</b> to the <b>${emailHtml(projectName)}</b> project on LoopDesk.</p><p><a href="${link}">Accept invitation</a></p>`);
async function resetLink(d, m, origin) {
  const token = uid();
  d.resets = d.resets.filter((x) => x.id !== m.id).concat({ id: m.id, token, at: Date.now() });
  const link = browserSiteUrl(origin) + "/?reset=" + token;
  const result = await send(m.email, "Reset your LoopDesk password", `<p>Hello ${emailHtml(m.name)},</p><p>Use this link to set a new password. It expires in 1 hour and works once.</p><p><a href="${link}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`);
  log(d, m.name, "Password reset link issued");
  return { link, sent: result.sent, emailError: result.error };
}

async function h(req, p, m) {
  const u = new URL(req.url), r = p[0];
  if (r === "cron") {
    if (!process.env.CRON_SECRET || req.headers.get("authorization") !== "Bearer " + process.env.CRON_SECRET) return J({ error: "denied" }, 401);
    await check(); return J({ ok: true });
  }
  const key = req.headers.get("x-key");
  if (remote && r === "login" && m === "POST") {
    const body = await req.json();
    const id = String(body.id || "").trim().toLowerCase();
    const failure = fails.get(id) || { n: 0, t: 0 };
    if (failure.n >= 5 && Date.now() - failure.t < 300000) return J({ error: "Too many attempts. Try again in 5 minutes." }, 429);
    const phone = id.includes("@") ? "" : np(id);
    const d = await loadLoginDb(id.includes("@") ? id : "", phone, () => ({ tickets: SEED, members: [], invites: [], meetings: [] }));
    const member = d.members.find((item) => item.email === id || (phone && np(item.phone) === phone));
    if (!member || !verify(String(body.password || ""), member.pw)) {
      fails.set(id, { n: failure.n + 1, t: Date.now() });
      return J({ error: "Invalid email/phone or password" }, 401);
    }
    if (member.status === "disabled") return J({ error: "This account is disabled. Please contact an admin." }, 403);
    fails.delete(id);
    const sessionToken = uid() + "." + Date.now();
    await createLoginSession(member.id, sessionToken);
    return J({ key: sessionToken });
  }
  if (remote && !key && r === "db" && m === "GET") {
    let memberCount;
    try {
      memberCount = await getWorkspaceMemberCount();
    } catch (error) {
      if (!/"code"\s*:\s*"PGRST002"/.test(String(error?.message || error))) throw error;
      console.warn("Supabase schema cache is temporarily unavailable; showing sign-in while it recovers.");
      return J({ loginRequired: true });
    }
    if (memberCount > 0) return J({ loginRequired: true });
    if (!process.env.ADMIN_EMAIL || !pwOk(process.env.ADMIN_PASSWORD)) return J({ setup: true });
  }
  let publicFlow = "";
  let publicBody = {};
  let publicToken = "";
  if (remote && !key) {
    if (r === "invite" && m === "GET") {
      publicFlow = "invite";
      publicToken = u.searchParams.get("t") || "";
    } else if (r === "accept" && m === "POST") {
      publicFlow = "accept";
      publicBody = await req.clone().json();
      publicToken = String(publicBody.token || "");
    } else if (r === "forgot" && m === "POST") {
      publicFlow = "forgot";
      publicBody = await req.clone().json();
    } else if (r === "reset" && m === "POST") {
      publicFlow = "reset";
      publicBody = await req.clone().json();
      publicToken = String(publicBody.token || "");
    } else if (r === "google-meet" && m === "GET" && u.searchParams.get("action") === "callback") {
      publicFlow = "oauth";
      publicToken = u.searchParams.get("state") || "";
    } else if (r !== "db" || m !== "GET") {
      return J({ error: "denied" }, 401);
    }
  }
  const requestedProject = u.searchParams.get("project");
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(u.searchParams.get("limit") || "100", 10) || 100));
  const boundedOffset = (value) => Math.min(2147483647, Math.max(0, Number.parseInt(value || "0", 10) || 0));
  const safePageOffset = boundedOffset(
    (r === "tickets" ? u.searchParams.get("offset") : u.searchParams.get("ticketOffset")) || "0",
  );
  const collectionLimit = Math.min(200, Math.max(1, Number.parseInt(u.searchParams.get("limit") || "100", 10) || 100));
  const collectionOffset = boundedOffset(u.searchParams.get("offset"));
  let scopedBody = publicBody;
  if (remote && key && m === "POST" && !["upload", "meeting-recording"].includes(r)) {
    scopedBody = await req.clone().json();
  }
  let collection = "";
  let rangeStart = "";
  let rangeEnd = "";
  let recordId = "";
  if (r === "db" && m === "GET") collection = "overview";
  if (r === "files" && m === "GET") collection = "files";
  if (r === "activity" && m === "GET") collection = "audit";
  if (r === "meetings") {
    collection = "meetings";
    if (m === "GET") {
      const month = u.searchParams.get("month") || "";
      if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        const [year, monthNumber] = month.split("-").map(Number);
        rangeStart = `${month}-01`;
        rangeEnd = `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, "0")}`;
      }
    } else {
      recordId = String(scopedBody.id || "");
      if (scopedBody.action === "notes") rangeStart = String(scopedBody.occurrenceDate || "");
    }
  }
  if (r === "meeting-notes") {
    collection = "meeting-notes";
    if (m === "GET") {
      rangeStart = u.searchParams.get("from") || "";
      rangeEnd = u.searchParams.get("to") || "";
      if (!rangeStart && !rangeEnd) {
        const month = u.searchParams.get("month") || "";
        if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
          const [year, monthNumber] = month.split("-").map(Number);
          rangeStart = `${month}-01`;
          rangeEnd = `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, "0")}`;
        }
      } else {
        const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
        if (!validDate(rangeStart) || !validDate(rangeEnd) || rangeStart > rangeEnd || (new Date(`${rangeEnd}T00:00:00Z`) - new Date(`${rangeStart}T00:00:00Z`)) / 864e5 > 366) {
          return J({ error: "Enter a valid report range of no more than one year" }, 400);
        }
      }
    } else recordId = String(scopedBody.noteId || scopedBody.id || scopedBody.meetingId || "");
  }
  if (r === "meeting-recording") {
    collection = "meeting-notes";
    if (m === "GET") recordId = u.searchParams.get("id") || "";
    else if (m === "POST") {
      const formData = await req.clone().formData();
      recordId = String(formData.get("noteId") || "");
    }
  }
  if (r === "file" && m === "GET") {
    collection = "files";
    recordId = path.basename(u.searchParams.get("f") || "");
  }
  if (r === "filedel" && m === "POST") {
    collection = "files";
    recordId = String(scopedBody.id || "");
  }
  if (["upload", "addlink"].includes(r) && m === "POST") collection = "files";
  let d;
  if (publicFlow) {
    const id = String(publicBody.id || "").trim().toLowerCase();
    const phone = id.includes("@") ? "" : np(id);
    d = await loadPublicFlowDb(publicFlow, publicToken, id.includes("@") ? id : "", phone);
    d._publicFlow = publicFlow;
    if (!d._publicFlowFound) {
      if (publicFlow === "forgot") return J({ ok: true });
      if (publicFlow === "reset") return J({ error: "This reset link is invalid or has expired." }, 400);
      if (publicFlow === "oauth") {
        const destination = new URL("/", siteUrl(u.origin));
        destination.searchParams.set("google-meet", "error");
        destination.searchParams.set("reason", "state");
        return Response.redirect(destination);
      }
      return J({ error: "Invalid or expired invite" }, 404);
    }
  } else {
    d = await load(key ? {
      sessionToken: key,
      projectId: requestedProject,
      ticketOffset: safePageOffset,
      ticketLimit: pageSize,
      collection,
      rangeStart,
      rangeEnd,
      collectionOffset,
      collectionLimit: r === "meeting-notes" ? Math.min(collectionLimit, 50) : collectionLimit,
      recordId,
    } : undefined);
  }
  if (d._scopeUnauthorized) return J({ error: "denied" }, 401);
  if (d._scopeForbidden) return J({ error: "You are not a member of this project" }, 403);
  d.audit = d.audit || []; d.resets = d.resets || []; d.files = d.files || []; d.meetings = d.meetings || []; d.meetingNotes = d.meetingNotes || [];
  d.meetingEditRequests = d.meetingEditRequests || [];
  d.meetings.forEach((meeting) => { if (!meeting.projectId) meeting.projectId = "rewaldo"; });
  if (!d.v2) await migrate(d);
  if (!d.v3) {
    const cm = { "Version Chain Management Docs": "Release & Version Docs", "Issue Report Docs": "Bug & Issue Reports" };
    d.tickets.forEach((t) => { if (t.status === "Done") t.status = "Completed"; });
    d.files.forEach((x) => { x.cat = cm[x.cat] || x.cat; });
    d.v3 = true; await save(d);
  }
  if (!d.v4) {
    const cm = {
      "Requirements & Specifications": "Requirements & Design",
      "Architecture & Design": "Requirements & Design",
      "Bug & Issue Reports": "Reports & Releases",
      "Test Cases & QA Reports": "Reports & Releases",
      "Release & Version Docs": "Reports & Releases",
      "Deployment & Runbooks": "Reports & Releases",
      "User Manuals & Guides": "Guides & Communication",
      "Client Communication": "Guides & Communication",
      "Other Docs": "Other",
    };
    d.files.forEach((x) => { x.cat = cm[x.cat] || (CATS.includes(x.cat) ? x.cat : "Other"); });
    d.v4 = true; await save(d);
  }
  if (!Array.isArray(d.projects)) {
    const legacy = {
      id: "rewaldo",
      name: "Rewaldo",
      tickets: d.tickets || SEED,
      files: d.files || [],
      audit: d.audit || [],
      members: d.members.map((member) => ({ memberId: member.id, role: member.role || "Developer", status: "active" })),
    };
    d.projects = [legacy];
    delete d.tickets; delete d.files; delete d.audit;
    d.projects.push({ id: "docutect", name: "DocuTect", tickets: [], files: [], audit: [], members: d.members.filter((member) => member.role === "Admin").map((member) => ({ memberId: member.id, role: "Admin", status: "active" })) });
    await save(d);
  }
  d.projects.forEach((x) => {
    x.tickets = x.tickets || []; x.files = x.files || []; x.audit = x.audit || [];
    if (!Array.isArray(x.members)) {
      const existingTeam = x.id === "rewaldo" ? d.members : d.members.filter((member) => member.role === "Admin");
      x.members = existingTeam.map((member) => ({ memberId: member.id, role: member.role || "Admin", status: "active" }));
    }
  });
  d.organizations = d.organizations || [];
  let defaultOrganization = d.organizations.find((item) => item.id === "solexes")
    || (d._publicFlow ? d.organizations[0] : null);
  if (!defaultOrganization) {
    defaultOrganization = {
      id: "solexes",
      name: "My Company",
      adminIds: [...new Set(d.projects.flatMap((item) => item.members.filter((entry) => entry.role === "Admin" && entry.status !== "disabled").map((entry) => entry.memberId)))],
    };
    if (!d._publicFlow) d.organizations.push(defaultOrganization);
  }
  d.projects.forEach((item) => {
    if (!item.organizationId) item.organizationId = defaultOrganization.id;
    const organization = d.organizations.find((entry) => entry.id === item.organizationId);
    if (organization) {
      organization.adminIds = [...new Set([...(organization.adminIds || []), ...item.members.filter((entry) => entry.role === "Admin" && entry.status !== "disabled").map((entry) => entry.memberId)])];
    }
  });
  if (!d.v6) { d.v6 = true; await save(d); }
  d.invites = d.invites || [];
  d.invites.forEach((invite) => { invite.projectId = invite.projectId || "rewaldo"; });
  if (!d.v5) { d.v5 = true; await save(d); }
  let project = d.projects.find((x) => x.id === requestedProject) || d.projects[0];
  if (requestedProject && !d.projects.some((x) => x.id === requestedProject)) return J({ error: "Project not found" }, 404);
  // Public flows (forgot password, reset, invite) load only the rows they need, so they may have no project.
  if (!project) project = { id: "", name: "", members: [], tickets: [], files: [], audit: [] };
  d.resets = d.resets || [];
  // Bootstrap the first admin only from a full, unscoped workspace load. A scoped public-flow load (for
  // example "forgot password" for an unknown email) also has zero members but the workspace is not empty.
  if (!d._publicFlow && !key && !d.members.length && process.env.ADMIN_EMAIL && pwOk(process.env.ADMIN_PASSWORD)) {
    const m = { id: uid().slice(0, 8), name: process.env.ADMIN_NAME || "Admin", email: process.env.ADMIN_EMAIL.trim().toLowerCase(), phone: "", pw: hash(process.env.ADMIN_PASSWORD), role: "Admin", sessions: [] };
    d.members.push(m);
    d.projects.forEach((x) => { x.members.push({ memberId: m.id, role: "Admin", status: "active" }); });
    d.organizations.forEach((organization) => { organization.adminIds = [...new Set([...(organization.adminIds || []), m.id])]; });
    claim(d, m); await save(d);
  }
  // `key` is "" when the browser sends an empty x-key header; keep account strictly an object or null.
  const account = (key && d.members.find((x) => x.status !== "disabled" && (x.key === key || (x.sessions || []).some((v) => v === key && live(v))))) || null;
  if (!requestedProject && account) project = d.projects.find((x) => x.members.some((entry) => entry.memberId === account.id && entry.status !== "disabled")) || project;
  d._activeProject = project; d._activeProjectId = project.id;
  d.tickets = project.tickets; d.files = project.files; d.audit = project.audit;
  const membership = account && project.members.find((x) => x.memberId === account.id && x.status !== "disabled");
  const me = membership ? { ...account, role: membership.role } : null;
  const meetingMemberships = account ? project.members
    .filter((entry) => entry.memberId === account.id && entry.status !== "disabled") : [];
  const canUseMeetings = !!meetingMemberships?.some((entry) => entry.role !== "Client");
  const canManageMeetings = !!meetingMemberships?.some((entry) => entry.role === "Admin");
  try {
    if (r === "google-meet" && m === "GET" && u.searchParams.get("action") === "callback") {
      const state = u.searchParams.get("state") || "";
      const pendingStates = Array.isArray(d.googleOAuthStates) ? d.googleOAuthStates : [];
      const pending = pendingStates.find((item) => item.state === state && item.expiresAt > Date.now());
      const pendingProject = pending && d.projects.find((item) => item.id === pending.projectId);
      const pendingMembership = pendingProject?.members.find((entry) => entry.memberId === pending.memberId && entry.role === "Admin" && entry.status !== "disabled");
      const pendingMember = d.members.find((member) => member.id === pending?.memberId && member.status !== "disabled");
      d.googleOAuthStates = pendingStates.filter((item) => item.state !== state);
      await save(d);
      const destination = new URL("/", siteUrl(u.origin));
      if (!pending || !pendingMembership || !pendingMember || u.searchParams.has("error") || !u.searchParams.get("code")) {
        destination.searchParams.set("google-meet", "error");
        destination.searchParams.set("reason", pending ? pendingMembership ? "consent" : "permission" : "state");
        return Response.redirect(destination);
      }
      if (!googleOAuthConfigured()) {
        destination.searchParams.set("google-meet", "error");
        destination.searchParams.set("reason", "configuration");
        return Response.redirect(destination);
      }
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          code: u.searchParams.get("code"),
          grant_type: "authorization_code",
          redirect_uri: googleRedirectUri(u.origin),
        }),
        cache: "no-store",
      });
      const tokens = await tokenResponse.json();
      if (!tokenResponse.ok || !tokens.access_token) {
        destination.searchParams.set("google-meet", "error");
        destination.searchParams.set("reason", "token");
        return Response.redirect(destination);
      }
      const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        cache: "no-store",
      });
      const profile = profileResponse.ok ? await profileResponse.json() : {};
      if (!profile.email) {
        destination.searchParams.set("google-meet", "error");
        destination.searchParams.set("reason", "profile");
        return Response.redirect(destination);
      }
      const currentCalendar = googleCalendarForOrganization(d, pendingProject.organizationId);
      const previousToken = String(profile.email || "").toLowerCase() === String(currentCalendar?.email || "").toLowerCase()
        ? currentCalendar?.refreshToken
        : "";
      if (!tokens.refresh_token && !previousToken) {
        destination.searchParams.set("google-meet", "error");
        destination.searchParams.set("reason", "refresh-token");
        return Response.redirect(destination);
      }
      d.googleCalendars = {
        ...(d.googleCalendars || {}),
        [pendingProject.organizationId]: {
          organizationId: pendingProject.organizationId,
          refreshToken: tokens.refresh_token ? sealGoogleToken(tokens.refresh_token) : previousToken,
          email: String(profile.email || ""),
          connectedBy: pending.memberId,
          connectedAt: new Date().toISOString(),
        },
      };
      await save(d);
      destination.searchParams.set("google-meet", "connected");
      return Response.redirect(destination);
    }
    if (m === "GET" && r === "db") {
      if (!d.members.length) return J({ setup: true });
      if (!me) return J({ error: account ? "You are not a member of this project" : "denied" }, account ? 403 : 401);
      const projects = d.projects.filter((x) => x.members.some((entry) => entry.memberId === account.id && entry.status !== "disabled")).map(({ id, name, organizationId }) => ({ id, name, organizationId: organizationId || defaultOrganization.id }));
      const organizations = d.organizations
        .filter((organization) => (organization.adminIds || []).includes(account.id) || projects.some((item) => d.projects.find((projectItem) => projectItem.id === item.id)?.organizationId === organization.id))
        .map(({ id, name, adminIds }) => ({ id, name, canCreateProject: (adminIds || []).includes(account.id) }));
      const elevatedMeetingRole = ["Admin", "Collaborator"].includes(me.role);
      const editGrant = d.meetingEditRequests.find((item) => item.projectId === project.id && item.memberId === account.id && item.status === "approved" && item.expiresAt > Date.now());
      const meetingEditRequests = d.meetingEditRequests.filter((item) => item.projectId === project.id && (me.role === "Admin" ? true : item.memberId === account.id));
      const meetingEditAccess = elevatedMeetingRole || !!editGrant;
      const meetingEditAccessExpiresAt = editGrant ? editGrant.expiresAt : null;
      if (me.role === "Client") {
        const mine = d.tickets.filter((t) => t.createdBy === me.id);
        return J({ me: pub(me), projects, organizations, projectId: project.id, canUseMeetings, canManageMeetings, meetingEditAccess, meetingEditAccessExpiresAt, meetingEditRequests, tickets: mine.map((t) => ({ id: t.id, type: t.type, date: t.date, by: t.by, title: t.title, details: t.details, resolution: t.resolution, notes: t.notes, closed: t.closed, createdBy: t.createdBy, status: ["Completed", "Reopened"].includes(t.status) ? t.status : "In Progress" })), ticketPagination: { offset: d._scope?.ticket_offset || 0, limit: d._scope?.ticket_limit || d.tickets.length, total: d._scope?.ticket_total ?? d.tickets.length, hasMore: (d._scope?.ticket_offset || 0) + d.tickets.length < (d._scope?.ticket_total ?? d.tickets.length) }, members: [], invites: [], audit: [], files: d.files.filter((x) => mine.some((t) => t.id === x.ticket)) });
      }
      const members = project.members.map((entry) => {
        const member = d.members.find((x) => x.id === entry.memberId);
        return member ? { ...pub(member), role: entry.role, status: entry.status === "disabled" || member.status === "disabled" ? "disabled" : "active" } : null;
      }).filter(Boolean);
      const googleCalendar = googleCalendarForOrganization(d, project.organizationId);
      return J({ me: pub(me), projects: projects.map((item) => { const projectItem = d.projects.find((entry) => entry.id === item.id); return { ...item, organizationId: projectItem?.organizationId || defaultOrganization.id }; }), organizations, projectId: project.id, canUseMeetings, canManageMeetings, meetingEditAccess, meetingEditAccessExpiresAt, meetingEditRequests, googleCalendarConfigured: googleOAuthConfigured(), googleCalendarConnected: !!googleCalendar?.refreshToken, googleCalendarEmail: me.role === "Admin" ? googleCalendar?.email || "" : "", tickets: d.tickets, ticketPagination: { offset: d._scope?.ticket_offset || 0, limit: d._scope?.ticket_limit || d.tickets.length, total: d._scope?.ticket_total ?? d.tickets.length, hasMore: (d._scope?.ticket_offset || 0) + d.tickets.length < (d._scope?.ticket_total ?? d.tickets.length) }, members, invites: me.role === "Admin" ? d.invites.filter((x) => x.projectId === project.id) : [], audit: me.role === "Admin" ? d.audit.slice(0, 300) : [], files: d.files });
    }
    if (m === "GET" && r === "invite") {
      const i = d.invites.find((x) => x.token === u.searchParams.get("t"));
      const inviteProject = i && d.projects.find((x) => x.id === i.projectId);
      return i && inviteProject ? J({ email: i.email, role: i.role, projectId: inviteProject.id, projectName: inviteProject.name, existing: d.members.some((x) => x.email === i.email) }) : J({ error: "Invalid or expired invite" }, 404);
    }
    if (m === "GET" && r === "file") {
      if (!me) return J({ error: account ? "You are not a member of this project" : "denied" }, account ? 403 : 401);
      const f = path.basename(u.searchParams.get("f") || "");
      if (!d.files.some((x) => x.id === f)) return J({ error: "missing" }, 404);
      const ownsFileTicket = d._scope?.file_authorized ?? d.files.some((item) =>
        item.id === f && d.tickets.some((ticket) => ticket.id === item.ticket && ticket.createdBy === me.id));
      if (me.role === "Client" && !ownsFileTicket) return J({ error: "denied" }, 403);
      const buf = await getFile(f);
      if (!buf) return J({ error: "missing" }, 404);
      return new Response(buf, { headers: { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(u.searchParams.get("n") || f)}` } });
    }
    if (r === "meetings" && m === "GET") {
      if (!canUseMeetings) return J({ error: "Team access required" }, account ? 403 : 401);
      const month = u.searchParams.get("month") || "";
      if (!/^\d{4}-\d{2}$/.test(month)) return J({ error: "Invalid calendar month" }, 400);
      const [year, monthNumber] = month.split("-").map(Number);
      if (monthNumber < 1 || monthNumber > 12) return J({ error: "Invalid calendar month" }, 400);
      const from = `${month}-01`, lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
      const to = `${month}-${String(lastDay).padStart(2, "0")}`;
      const results = [];
      d.meetings.filter((meeting) => meeting.projectId === project.id).forEach((meeting) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(meeting.date) || !Number.isFinite(new Date(`${meeting.date}T00:00:00Z`).getTime())) return;
        const { occurrences = {}, ...base } = meeting;
        if (meeting.date >= from && meeting.date <= to) {
          const saved = occurrences[meeting.date] || {};
          results.push({ ...base, weekly: false, occurrenceDate: meeting.date, notes: saved.notes || "", participantSummaries: saved.participantSummaries || [], notesUpdatedAt: saved.updatedAt || "" });
        }
      });
      return J({
        meetings: results.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)),
        pagination: {
          offset: d._scope?.collection_offset || 0,
          limit: d._scope?.collection_limit || results.length,
          total: d._scope?.collection_total ?? results.length,
          hasMore: (d._scope?.collection_offset || 0) + results.length < (d._scope?.collection_total ?? results.length),
        },
      });
    }
    if (r === "google-meet" && m === "GET" && u.searchParams.get("action") === "status") {
      if (!canManageMeetings) return J({ error: "Project admin access required" }, 403);
      return J({
        configured: googleOAuthConfigured(),
        connected: !!googleCalendarForOrganization(d, project.organizationId)?.refreshToken,
        email: googleCalendarForOrganization(d, project.organizationId)?.email || "",
      });
    }
    if (r === "meeting-notes" && m === "GET") {
      if (!canUseMeetings || me.role === "Client") return J({ error: "Team access required" }, 403);
      const elevatedMeetingRole = ["Admin", "Collaborator"].includes(me.role);
      const editGrant = d.meetingEditRequests.find((item) => item.projectId === project.id && item.memberId === account.id && item.status === "approved" && item.expiresAt > Date.now());
      const access = {
        canEdit: elevatedMeetingRole || !!editGrant,
        expiresAt: editGrant?.expiresAt || null,
        requests: d.meetingEditRequests.filter((item) => item.projectId === project.id && (me.role === "Admin" || item.memberId === account.id)),
      };
      const month = u.searchParams.get("month") || "";
      const from = u.searchParams.get("from") || "", to = u.searchParams.get("to") || "";
      if (from || to) {
        const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
        if (!validDate(from) || !validDate(to) || from > to || (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 864e5 > 366) return J({ error: "Enter a valid report range of no more than one year" }, 400);
        return J({
          ...access,
          notes: d.meetingNotes.filter((note) => note.projectId === project.id && note.date >= from && note.date <= to).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
          pagination: {
            offset: d._scope?.collection_offset || 0,
            limit: d._scope?.collection_limit || d.meetingNotes.length,
            total: d._scope?.collection_total ?? d.meetingNotes.length,
            hasMore: (d._scope?.collection_offset || 0) + d.meetingNotes.length < (d._scope?.collection_total ?? d.meetingNotes.length),
          },
        });
      }
      if (!/^\d{4}-\d{2}$/.test(month) || Number(month.slice(5)) < 1 || Number(month.slice(5)) > 12) return J({ error: "Invalid notes month" }, 400);
      return J({
        ...access,
        notes: d.meetingNotes.filter((note) => note.projectId === project.id && note.date.startsWith(month)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        pagination: {
          offset: d._scope?.collection_offset || 0,
          limit: d._scope?.collection_limit || d.meetingNotes.length,
          total: d._scope?.collection_total ?? d.meetingNotes.length,
          hasMore: (d._scope?.collection_offset || 0) + d.meetingNotes.length < (d._scope?.collection_total ?? d.meetingNotes.length),
        },
      });
    }
    if (r === "files" && m === "GET") {
      return J({
        files: d.files,
        pagination: {
          offset: d._scope?.collection_offset || 0,
          limit: d._scope?.collection_limit || d.files.length,
          total: d._scope?.collection_total ?? d.files.length,
          hasMore: (d._scope?.collection_offset || 0) + d.files.length < (d._scope?.collection_total ?? d.files.length),
        },
      });
    }
    if (r === "activity" && m === "GET") {
      if (me.role !== "Admin") return J({ error: "Admin only" }, 403);
      return J({
        audit: d.audit,
        pagination: {
          offset: d._scope?.collection_offset || 0,
          limit: d._scope?.collection_limit || d.audit.length,
          total: d._scope?.collection_total ?? d.audit.length,
          hasMore: (d._scope?.collection_offset || 0) + d.audit.length < (d._scope?.collection_total ?? d.audit.length),
        },
      });
    }
    if (r === "meeting-recording" && m === "GET") {
      if (!canUseMeetings || me.role === "Client") return J({ error: "Team access required" }, 403);
      const note = d.meetingNotes.find((item) => item.id === u.searchParams.get("id") && item.projectId === project.id);
      const clipIndex = Number(u.searchParams.get("clip") || 0);
      if (!Number.isInteger(clipIndex) || clipIndex < 0) return J({ error: "Invalid recording clip" }, 400);
      const clip = note?.audioFiles?.[clipIndex] || (clipIndex === 0 ? note?.audioFile : null);
      if (!clip) return J({ error: "Recording not found" }, 404);
      const audio = await getFile(clip.id);
      if (!audio) return J({ error: "Recording file is missing" }, 404);
      return new Response(audio, { headers: { "Content-Type": clip.type || "audio/webm", "Content-Disposition": `inline; filename="${clip.name}"`, "Cache-Control": "private, no-store" } });
    }
    if (r === "tickets" && m === "GET") {
      return J({
        tickets: d.tickets,
        pagination: {
          offset: d._scope?.ticket_offset || 0,
          limit: d._scope?.ticket_limit || d.tickets.length,
          total: d._scope?.ticket_total ?? d.tickets.length,
          hasMore: (d._scope?.ticket_offset || 0) + d.tickets.length < (d._scope?.ticket_total ?? d.tickets.length),
        },
      });
    }
    if (m !== "POST") return J({ error: "not found" }, 404);
    if (r === "google-meet") {
      if (!canManageMeetings) return J({ error: "Project admin access required" }, 403);
      const b = await req.json();
      if (b.action === "disconnect") {
        const calendars = { ...(d.googleCalendars || {}) };
        delete calendars[project.organizationId];
        d.googleCalendars = calendars;
        await save(d);
        return J({ ok: true });
      }
      if (b.action !== "connect") return J({ error: "Invalid Google Meet action" }, 400);
      if (!googleOAuthConfigured()) return J({ error: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the server environment before connecting Google Calendar." }, 400);
      const state = uid();
      d.googleOAuthStates = (d.googleOAuthStates || []).filter((item) => item.expiresAt > Date.now()).slice(-9);
      d.googleOAuthStates.push({ state, memberId: account.id, projectId: project.id, expiresAt: Date.now() + 10 * 60 * 1000 });
      await save(d);
      const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorizationUrl.search = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: googleRedirectUri(u.origin),
        response_type: "code",
        scope: "openid email https://www.googleapis.com/auth/calendar.events",
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();
      return J({ ok: true, authorizationUrl: authorizationUrl.toString() });
    }
    const chk = (b) => {
      if (!b.name) return "Name is required";
      if (!pwOk(b.password)) return PWMSG;
      if (d.members.some((x) => np(x.phone) && np(x.phone) === np(b.phone))) return "Phone number already in use";
      return "";
    };
    if (r === "accept") {
      const b = await req.json(), i = d.invites.find((x) => x.token === b.token);
      if (!i) return J({ error: "Invalid invite" }, 404);
      const inviteProject = d.projects.find((x) => x.id === i.projectId);
      if (!inviteProject) return J({ error: "The invited project no longer exists" }, 404);
      if (inviteProject.members.some((x) => d.members.find((member) => member.id === x.memberId)?.email === i.email)) return J({ error: "This account is already a member of the project" }, 400);
      let member = d.members.find((x) => x.email === i.email);
      if (member) {
        if (member.status === "disabled") return J({ error: "This account is disabled. Contact an administrator." }, 403);
        if (!verify(String(b.password || ""), member.pw)) return J({ error: "Incorrect account password" }, 403);
      } else {
        const e = chk(b); if (e) return J({ error: e }, 400);
        member = { id: uid().slice(0, 8), name: String(b.name).trim(), email: i.email.toLowerCase(), phone: np(b.phone), pw: hash(b.password), role: i.role, sessions: [] };
        d.members.push(member);
      }
      inviteProject.members.push({ memberId: member.id, role: i.role, status: "active" });
      const k = uid() + "." + Date.now(); member.sessions = [...(member.sessions || []), k].slice(-5);
      if (inviteProject === project && !d._publicFlow) claim(d, member);
      d.invites = d.invites.filter((x) => x !== i); await save(d);
      return J({ key: k, projectId: inviteProject.id });
    }
    if (r === "forgot") {
      const b = await req.json(), id = String(b.id || "").trim().toLowerCase(), f = fails.get("f" + id) || { n: 0, t: 0 };
      if (f.n >= 3 && Date.now() - f.t < 900000) return J({ ok: true });
      fails.set("f" + id, { n: f.n + 1, t: Date.now() });
      const m = d.members.find((x) => x.email === id || (!id.includes("@") && np(x.phone) && np(x.phone) === np(id)));
      if (m && m.status !== "disabled") { await resetLink(d, m, u.origin); await save(d); }
      return J({ ok: true });
    }
    if (r === "reset") {
      const b = await req.json(), i = d.resets.find((x) => x.token === b.token && Date.now() - x.at < 3600000);
      if (!i) return J({ error: "This reset link is invalid or has expired." }, 400);
      if (!pwOk(b.password)) return J({ error: PWMSG }, 400);
      const m = d.members.find((x) => x.id === i.id);
      m.pw = hash(b.password); m.sessions = []; delete m.key;
      d.resets = d.resets.filter((x) => x.id !== i.id); log(d, m.name, "Password reset completed"); await save(d);
      return J({ ok: true });
    }
    if (r === "login") {
      const b = await req.json(), id = String(b.id || "").trim().toLowerCase(), f = fails.get(id) || { n: 0, t: 0 };
      if (f.n >= 5 && Date.now() - f.t < 300000) return J({ error: "Too many attempts. Try again in 5 minutes." }, 429);
      const m = d.members.find((x) => x.email === id || (!id.includes("@") && np(x.phone) && np(x.phone) === np(id)));
      if (!m || !verify(String(b.password || ""), m.pw)) { fails.set(id, { n: f.n + 1, t: Date.now() }); log(d, id, "Failed sign-in"); await save(d); return J({ error: "Invalid email/phone or password" }, 401); }
      if (m.status === "disabled") return J({ error: "This account is disabled. Please contact an admin." }, 403);
      fails.delete(id); log(d, m.name, "Signed in");
      const k = uid() + "." + Date.now(); m.sessions = [...(m.sessions || []), k].slice(-5); await save(d);
      return J({ key: k });
    }
    if (!me) return J({ error: "denied" }, 401);
    if (r === "meetings") {
      if (!canUseMeetings) return J({ error: "Team access required" }, 403);
      const activeMembers = project.members
        .filter((entry) => entry.status !== "disabled")
        .map((entry) => d.members.find((member) => member.id === entry.memberId && member.status !== "disabled"))
        .filter(Boolean);
      const b = await req.json();
      const activeMeetingGrant = d.meetingEditRequests.some((item) => item.projectId === project.id && item.memberId === account.id && item.status === "approved" && item.expiresAt > Date.now());
      const canEditMeetingContent = ["Admin", "Collaborator"].includes(me.role) || activeMeetingGrant;
      const canManageAllMeetingContent = ["Admin", "Collaborator"].includes(me.role);
      const canEditMemberContent = (memberId) => canManageAllMeetingContent || (activeMeetingGrant && String(memberId) === account.id);
      if (b.action === "create") {
        const title = String(b.title || "").trim().slice(0, 120), agenda = String(b.agenda || "").trim().slice(0, 3000);
        const date = String(b.date || ""), time = String(b.time || ""), duration = Number(b.duration || 60);
        const timeZone = String(b.timeZone || "UTC");
        const attendeeIds = Array.isArray(b.attendeeIds) ? [...new Set(b.attendeeIds.map(String))] : [];
        const parsedDate = new Date(`${date}T00:00:00Z`);
        try { new Intl.DateTimeFormat("en-US", { timeZone }); }
        catch { return J({ error: "Select a valid meeting time zone" }, 400); }
        if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date ||
          !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || !Number.isInteger(duration) || duration < 15 || duration > 60) {
          return J({ error: "Enter a title, valid date and time, and a duration between 15 and 60 minutes" }, 400);
        }
        if (attendeeIds.length > 100) return J({ error: "A meeting can have at most 100 invitees" }, 400);
        const eligibleMembers = project.members
          .filter((entry) => entry.status !== "disabled" && entry.role !== "Client")
          .map((entry) => d.members.find((member) => member.id === entry.memberId && member.status !== "disabled"))
          .filter(Boolean);
        const attendees = attendeeIds.map((id) => eligibleMembers.find((member) => member.id === id));
        if (attendees.some((member) => !member)) return J({ error: "One or more selected invitees are not active team members in this project" }, 400);
        const online = b.online === true;
        const roomProvider = online ? String(b.roomProvider || "google-meet") : "";
        let roomName = "", roomUrl = "";
        if (online) {
          if (!["google-meet", "zoom"].includes(roomProvider)) return J({ error: "Select Google Meet or Zoom" }, 400);
          if (b.roomUrl) {
            try {
              const parsedRoomUrl = new URL(String(b.roomUrl));
              const validHost = roomProvider === "google-meet" ? parsedRoomUrl.hostname === "meet.google.com"
                : parsedRoomUrl.hostname === "zoom.us" || parsedRoomUrl.hostname.endsWith(".zoom.us");
              if (parsedRoomUrl.protocol !== "https:" || parsedRoomUrl.username || parsedRoomUrl.password || !validHost) return J({ error: "Paste a valid HTTPS meeting link from the selected conference service" }, 400);
              roomUrl = parsedRoomUrl.toString();
            } catch {
              return J({ error: "Paste a valid HTTPS meeting link from the selected conference service" }, 400);
            }
          }
        }
        const meeting = { id: uid().slice(0, 12), projectId: project.id, title, date, time, duration, agenda, weekly: false, online, roomProvider, roomName, roomUrl, attendees: attendees.map((member) => ({ id: member.id, name: member.name, email: member.email })), roster: eligibleMembers.map((member) => ({ id: member.id, name: member.name, email: member.email })), createdBy: account.id, createdByName: me.name, occurrences: {} };
        if (online && roomProvider === "google-meet" && googleCalendarForOrganization(d, project.organizationId)?.refreshToken) {
          try {
            const googleEvent = await createGoogleMeetEvent(d, meeting, timeZone, project.organizationId);
            meeting.roomUrl = googleEvent.meetLink;
            meeting.googleCalendarEventId = googleEvent.eventId;
          } catch (error) {
            return J({ error: `Could not create Google Meet room: ${error.message}` }, 502);
          }
        } else if (online && roomProvider === "google-meet" && !roomUrl) {
          return J({ error: "Connect Google Calendar as a project admin to create a Meet room automatically, or paste a Google Meet link." }, 400);
        }
        d.meetings.push(meeting); await save(d);
        const invitationResults = await Promise.all(attendees.map((member) => send(
          member.email,
          `Meeting invitation: ${title}`,
          `<p>Hello ${emailHtml(member.name)},</p><p>${emailHtml(me.name)} invited you to the <b>${emailHtml(project.name)}</b> meeting <b>${emailHtml(title)}</b>.</p><p><b>Date:</b> ${emailHtml(date)}<br><b>Time:</b> ${emailHtml(time)}<br><b>Duration:</b> ${duration} minutes</p>${roomUrl ? `<p><b>Join the online meeting:</b> <a href="${emailHtml(roomUrl)}">${emailHtml(roomUrl)}</a></p>` : online ? "<p>The organizer has not added the online meeting link yet. Please contact them for the join link.</p>" : "<p>This meeting is in person.</p>"}${agenda ? `<p><b>Agenda:</b><br>${emailHtml(agenda).replace(/\n/g, "<br>")}</p>` : ""}`
        )));
        const sent = invitationResults.filter((result) => result.sent).length;
        const emailErrors = [...new Set(invitationResults.filter((result) => !result.sent).map((result) => result.error))];
        return J({ ok: true, meeting: { ...meeting, occurrenceDate: date, notes: "", participantSummaries: [] }, inviteEmailsSent: sent, inviteEmailsTotal: attendees.length, emailErrors });
      }
      if (b.action === "participant-tasks") {
        if (!canManageAllMeetingContent) return J({ error: "Only an Admin or Collaborator can email meeting action items" }, 403);
        if (!canEditMeetingContent) return J({ error: "Admin or Collaborator access, or a current one-hour admin approval, is required to email meeting action items" }, 403);
        const meeting = d.meetings.find((item) => item.id === String(b.id || "") && item.projectId === project.id);
        const occurrenceDate = String(b.occurrenceDate || "");
        const occurrence = new Date(`${occurrenceDate}T00:00:00Z`);
        if (!meeting || occurrenceDate !== meeting.date || !Number.isFinite(occurrence.getTime()) || occurrence.toISOString().slice(0, 10) !== occurrenceDate) {
          return J({ error: "Meeting occurrence not found" }, 404);
        }
        const attendee = d.members.find((member) => member.id === String(b.memberId || "") && member.status !== "disabled" && project.members.some((entry) => entry.memberId === member.id && entry.status !== "disabled"));
        if (!attendee?.email) return J({ error: "The identified team member is not on this meeting roster" }, 400);
        const tasks = Array.isArray(b.tasks)
          ? [...new Set(b.tasks.slice(0, 10).map((task) => String(task).trim().slice(0, 500)).filter(Boolean))]
          : [];
        if (!tasks.length) return J({ ok: true, sent: false, skipped: true });

        meeting.occurrences = meeting.occurrences || {};
        const previous = meeting.occurrences[occurrenceDate] || {};
        const emailedTasks = previous.emailedTasks || {};
        const alreadySent = new Set(emailedTasks[attendee.id] || []);
        const newTasks = tasks.filter((task) => !alreadySent.has(task.toLowerCase()));
        if (!newTasks.length) return J({ ok: true, sent: false, skipped: true });

        const taskList = newTasks.map((task) => `<li>${emailHtml(task)}</li>`).join("");
        const result = await send(
          attendee.email,
          `Action items for you: ${meeting.title}`,
          `<p>Hello ${emailHtml(attendee.name)},</p><p>These action items were identified for you during <b>${emailHtml(meeting.title)}</b> on ${emailHtml(occurrenceDate)}:</p><ul>${taskList}</ul><p>Please review and correct these items in the project portal if needed.</p>`
        );
        if (!result.sent) return J({ ok: false, error: result.error || "Could not email the identified member's action items" }, 502);
        emailedTasks[attendee.id] = [...new Set([...alreadySent, ...newTasks.map((task) => task.toLowerCase())])].slice(-50);
        meeting.occurrences[occurrenceDate] = { ...previous, emailedTasks };
        await save(d);
        return J({ ok: true, sent: true, memberName: attendee.name, taskCount: newTasks.length });
      }
      if (b.action === "participant-summary") {
        if (!canEditMemberContent(b.memberId)) return J({ error: "Temporary edit access only allows changes to your own member card" }, 403);
        if (!canEditMeetingContent) return J({ error: "Admin or Collaborator access, or a current one-hour admin approval, is required to edit meeting cards" }, 403);
        const meeting = d.meetings.find((item) => item.id === String(b.id || "") && item.projectId === project.id);
        const occurrenceDate = String(b.occurrenceDate || "");
        const occurrence = new Date(`${occurrenceDate}T00:00:00Z`);
        if (!meeting || occurrenceDate !== meeting.date || !Number.isFinite(occurrence.getTime()) || occurrence.toISOString().slice(0, 10) !== occurrenceDate) {
          return J({ error: "Meeting occurrence not found" }, 404);
        }
        const attendee = d.members.find((member) => member.id === String(b.memberId || "") && member.status !== "disabled" && project.members.some((entry) => entry.memberId === member.id && entry.status !== "disabled"));
        if (!attendee?.email) return J({ error: "The identified team member is not on this meeting roster" }, 400);
        const cleanLines = (value, limit) => Array.isArray(value)
          ? [...new Set(value.slice(0, limit).map((line) => String(line).trim().slice(0, 500)).filter(Boolean))]
          : [];
        const points = cleanLines(b.points, 10);
        const tasks = cleanLines(b.tasks, 10);
        if (!points.length && !tasks.length) return J({ error: "Add at least one key point or action item before sharing" }, 400);
        const priority = ["High", "Medium", "Low"].includes(b.priority) ? b.priority : "Medium";
        const content = JSON.stringify({ points, tasks, priority });
        meeting.occurrences = meeting.occurrences || {};
        const previous = meeting.occurrences[occurrenceDate] || {};
        const sentSummaries = previous.sentSummaries || {};
        if (sentSummaries[attendee.id] === content) return J({ ok: true, sent: false, skipped: true, memberName: attendee.name });
        const lines = [
          ...points.map((line) => `<li>${emailHtml(line)}</li>`),
          ...tasks.map((line) => `<li><b>${emailHtml(priority)} priority action:</b> ${emailHtml(line)}</li>`),
        ].join("");
        const result = await send(
          attendee.email,
          `Meeting notes for you: ${meeting.title}`,
          `<p>Hello ${emailHtml(attendee.name)},</p><p>Here are your reviewed notes from <b>${emailHtml(meeting.title)}</b> on ${emailHtml(occurrenceDate)}:</p><ul>${lines}</ul><p>These notes were shared with you by ${emailHtml(me.name)}.</p>`
        );
        if (!result.sent) return J({ ok: false, error: result.error || "Could not email the participant's notes" }, 502);
        const participantSummaries = previous.participantSummaries || [];
        const card = { memberId: attendee.id, name: attendee.name, points, tasks, priority };
        meeting.occurrences[occurrenceDate] = {
          ...previous,
          participantSummaries: [...participantSummaries.filter((summary) => summary.memberId !== attendee.id), card],
          sentSummaries: { ...sentSummaries, [attendee.id]: content },
          updatedAt: new Date().toISOString(),
          updatedBy: me.name,
        };
        await save(d);
        return J({ ok: true, sent: true, memberName: attendee.name });
      }
      if (b.action === "notes") {
        if (!canEditMeetingContent) return J({ error: "Admin or Collaborator access, or a current one-hour admin approval, is required to edit meeting notes" }, 403);
        const meeting = d.meetings.find((item) => item.id === b.id && item.projectId === project.id), occurrenceDate = String(b.occurrenceDate || "");
        const occurrence = new Date(`${occurrenceDate}T00:00:00Z`);
        if (!meeting || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate) || !Number.isFinite(occurrence.getTime()) || occurrence.toISOString().slice(0, 10) !== occurrenceDate) return J({ error: "Meeting not found" }, 404);
        if (occurrenceDate !== meeting.date) return J({ error: "Invalid meeting occurrence" }, 400);
        const notes = String(b.notes || "").trim();
        if (notes.length > 20000) return J({ error: "Meeting notes must be 20,000 characters or fewer" }, 400);
        meeting.occurrences = meeting.occurrences || {};
        const submitted = Array.isArray(b.participantSummaries) ? b.participantSummaries : [];
        if (submitted.length > 100) return J({ error: "Too many participant summaries" }, 400);
        const attendees = activeMembers.filter((member) => member.role !== "Client");
        let participantSummaries = submitted.map((summary) => {
          const attendee = attendees.find((member) => member.id === String(summary.memberId));
          if (!attendee) return null;
          const cleanLines = (value, maximum) => Array.isArray(value)
            ? [...new Set(value.slice(0, maximum).map((line) => String(line).trim().slice(0, 500)).filter(Boolean))]
            : [];
          return {
            memberId: attendee.id,
            name: attendee.name,
            points: cleanLines(summary.points, 10),
            tasks: cleanLines(summary.tasks, 10),
            description: String(summary.description || "").trim().slice(0, 2000),
            priority: ["High", "Medium", "Low"].includes(summary.priority) ? summary.priority : "Medium",
          };
        });
        if (participantSummaries.some((summary) => !summary)) return J({ error: "A participant summary does not belong to this meeting's invitees" }, 400);
        const summaryLength = participantSummaries.reduce((total, summary) => total + summary.points.concat(summary.tasks).reduce((length, line) => length + line.length, 0) + summary.description.length, 0);
        if (summaryLength > 50000) return J({ error: "Participant summaries must contain 50,000 characters or fewer" }, 400);
        const previous = meeting.occurrences[occurrenceDate] || {};
        if (!canManageAllMeetingContent) {
          if (notes !== String(previous.notes || "")) return J({ error: "Temporary edit access only allows changes to your own member card, not shared meeting notes" }, 403);
          const previousCards = previous.participantSummaries || [];
          const signature = (card) => JSON.stringify({
            name: card.name, points: card.points || [], tasks: card.tasks || [],
            description: card.description || "", priority: card.priority || "Medium",
          });
          const blank = (card) => !(card.points || []).length && !(card.tasks || []).length && !card.description && (!card.priority || card.priority === "Medium");
          const oldCardsValid = previousCards.every((oldCard) => {
            const submittedCard = participantSummaries.find((card) => card.memberId === oldCard.memberId);
            return submittedCard && (canEditMemberContent(oldCard.memberId) || signature(submittedCard) === signature(oldCard));
          });
          const newCardsValid = participantSummaries.every((card) => {
            if (canEditMemberContent(card.memberId)) return true;
            const oldCard = previousCards.find((item) => item.memberId === card.memberId);
            return oldCard ? signature(card) === signature(oldCard) : blank(card);
          });
          if (!oldCardsValid || !newCardsValid) return J({ error: "Temporary edit access only allows changes to your own member card" }, 403);
          const ownCard = participantSummaries.find((card) => card.memberId === account.id);
          participantSummaries = ownCard && !blank(ownCard)
            ? [...previousCards.filter((card) => card.memberId !== account.id), ownCard]
            : previousCards;
        }
        const sentSummaries = previous.sentSummaries || {};
        const mailResults = await Promise.all(participantSummaries.map(async (summary) => {
          const lines = summary.points.map((line) => `<li>${emailHtml(line)}</li>`);
          if (!lines.length) return { id: summary.memberId, sent: false, skipped: true };
          const content = JSON.stringify({ points: summary.points });
          if (sentSummaries[summary.memberId] === content) return { id: summary.memberId, sent: false, skipped: true };
          const attendee = attendees.find((member) => member.id === summary.memberId);
          const result = await send(attendee.email, `Meeting notes: ${meeting.title}`, `<p>Hello ${emailHtml(attendee.name)},</p><p>Here are your key points and action items from <b>${emailHtml(meeting.title)}</b> on ${emailHtml(occurrenceDate)}:</p><ul>${lines.join("")}</ul><p>Please reply to the meeting organizer if anything needs correcting.</p>`);
          if (result.sent) sentSummaries[summary.memberId] = content;
          return { id: summary.memberId, sent: result.sent, error: result.error, skipped: false };
        }));
        meeting.occurrences[occurrenceDate] = {
          ...previous,
          notes,
          participantSummaries,
          sentSummaries,
          updatedAt: new Date().toISOString(),
          updatedBy: me.name,
        };
        const managedNote = d.meetingNotes.find((item) => item.projectId === project.id && item.meetingId === meeting.id && item.date === occurrenceDate && item.entryType === "meeting");
        const generatedTasks = participantSummaries.flatMap((summary) => summary.tasks.map((title) => {
          const existing = (managedNote?.tasks || []).find((task) => task.title.toLowerCase() === title.toLowerCase() && task.assigneeId === summary.memberId);
          const description = (summary.description || "").slice(0, 2000);
          return existing
            ? { ...existing, description: description || existing.description || "", priority: summary.priority || "Medium" }
            : { id: uid().slice(0, 12), title, description, assigneeId: summary.memberId, dueDate: "", status: "Open", comments: [], priority: summary.priority || "Medium", remindersSent: [] };
        }));
        const taskMap = new Map((managedNote?.tasks || []).map((task) => [task.id, task]));
        generatedTasks.forEach((task) => taskMap.set(task.id, task));
        const nextTasks = [...taskMap.values()].slice(0, 200);
        const savedNote = managedNote || {
          id: uid().slice(0, 12), projectId: project.id, meetingId: meeting.id, entryType: "meeting",
          date: occurrenceDate, createdBy: account.id, createdByName: me.name, createdAt: new Date().toISOString(),
        };
        savedNote.entryType = "meeting";
        savedNote.title = meeting.title;
        savedNote.summary = notes;
        savedNote.transcript = savedNote.transcript || "";
        savedNote.participantSummaries = participantSummaries;
        savedNote.tasks = nextTasks;
        savedNote.updatedAt = new Date().toISOString();
        if (!managedNote) d.meetingNotes.push(savedNote);
        await save(d);
        const taskEmailResults = await emailAssignedTasks(d, {
          tasks: generatedTasks,
          previousTasks: managedNote?.tasks || [],
          title: meeting.title,
          projectName: project.name,
        });
        return J({
          ok: true,
          note: savedNote,
          summaryEmailsSent: mailResults.filter((result) => result.sent).length,
          summaryEmailsFailed: mailResults.filter((result) => !result.sent && !result.skipped).length,
          taskEmailsSent: taskEmailResults.filter((result) => result.sent).length,
          taskEmailsFailed: taskEmailResults.filter((result) => !result.sent && !result.skipped).length,
          emailErrors: [...new Set([...mailResults, ...taskEmailResults].filter((result) => result.error).map((result) => result.error))],
        });
      }
      if (b.action === "delete") {
        const index = d.meetings.findIndex((item) => item.id === b.id && item.projectId === project.id), meeting = d.meetings[index];
        const isAdmin = meetingMemberships.some((entry) => entry.role === "Admin");
        if (!meeting) return J({ error: "Meeting not found" }, 404);
        if (meeting.createdBy !== account.id && !isAdmin) return J({ error: "Only the meeting creator or a team admin can delete it" }, 403);
        d.meetings.splice(index, 1); await save(d);
        return J({ ok: true });
      }
      return J({ error: "Invalid meeting action" }, 400);
    }
    if (r === "meeting-recording") {
      if (!canUseMeetings || me.role === "Client") return J({ error: "Team access required" }, 403);
      const activeMeetingGrant = d.meetingEditRequests.some((item) => item.projectId === project.id && item.memberId === account.id && item.status === "approved" && item.expiresAt > Date.now());
      if (!["Admin", "Collaborator"].includes(me.role)) return J({ error: "Only an Admin or Collaborator can change shared meeting recordings" }, 403);
      const formData = await req.formData();
      const noteId = String(formData.get("noteId") || "");
      const clipIndex = Number(formData.get("clipIndex") || 0);
      const file = formData.get("file");
      const note = d.meetingNotes.find((item) => item.id === noteId && item.projectId === project.id);
      if (!note || !file || typeof file.arrayBuffer !== "function") return J({ error: "Meeting note or recording file is missing" }, 400);
      if (!Number.isInteger(clipIndex) || clipIndex < 0 || clipIndex >= 20) return J({ error: "Recording clip index is invalid" }, 400);
      if (!String(file.type || "").startsWith("audio/")) return J({ error: "The uploaded recording must be an audio file" }, 400);
      const maxBytes = remote ? 4e6 : 25e6;
      if (file.size < 1 || file.size > maxBytes) return J({ error: `Recording must be smaller than ${maxBytes / 1e6} MB` }, 413);
      const extension = file.type.includes("ogg") ? ".ogg" : file.type.includes("mp4") ? ".mp4" : ".webm";
      const name = uid() + extension;
      await putFile(name, Buffer.from(await file.arrayBuffer()), file.type || "audio/webm");
      const audioFiles = note.audioFiles || (note.audioFile ? [note.audioFile] : []);
      const previousClip = audioFiles[clipIndex];
      audioFiles[clipIndex] = { id: name, name: `${note.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}-${clipIndex + 1}${extension}`, type: file.type || "audio/webm", size: file.size };
      note.audioFiles = audioFiles;
      note.audioFile = audioFiles[0];
      if (previousClip?.id && previousClip.id !== name) await delFile(previousClip.id);
      note.updatedAt = new Date().toISOString();
      await save(d);
      return J({ ok: true, note });
    }
    if (r === "meeting-notes") {
      if (!canUseMeetings || me.role === "Client") return J({ error: "Team access required" }, 403);
      const b = await req.json();
      const activeMembers = project.members
        .filter((entry) => entry.status !== "disabled")
        .map((entry) => d.members.find((member) => member.id === entry.memberId && member.status !== "disabled"))
        .filter(Boolean);
      const cleanLines = (value, limit, lineLimit) => Array.isArray(value)
        ? value.slice(0, limit).map((line) => String(line).trim().slice(0, lineLimit)).filter(Boolean)
        : [];
      const cleanCards = (value) => {
        if (!Array.isArray(value) || value.length > 100) return null;
        const cards = value.map((card) => {
          const member = activeMembers.find((item) => item.id === String(card.memberId));
          if (!member) return null;
          return {
            memberId: member.id,
            name: member.name,
            points: cleanLines(card.points, 10, 500),
            tasks: cleanLines(card.tasks, 20, 500),
            description: String(card.description || "").trim().slice(0, 2000),
            priority: ["High", "Medium", "Low"].includes(card.priority) ? card.priority : "Medium",
          };
        });
        return cards.some((card) => !card) ? null : cards;
      };
      const activeMeetingGrant = d.meetingEditRequests.some((item) => item.projectId === project.id && item.memberId === account.id && item.status === "approved" && item.expiresAt > Date.now());
      const canEditMeetingContent = ["Admin", "Collaborator"].includes(me.role) || activeMeetingGrant;
      const canManageAllMeetingContent = ["Admin", "Collaborator"].includes(me.role);
      const canEditMemberContent = (memberId) => canManageAllMeetingContent || (activeMeetingGrant && String(memberId) === account.id);
      if (b.action === "request-edit-access") {
        if (["Admin", "Collaborator"].includes(me.role)) return J({ ok: true, canEdit: true });
        const existing = d.meetingEditRequests.find((item) => item.projectId === project.id && item.memberId === account.id && (item.status === "pending" || (item.status === "approved" && item.expiresAt > Date.now())));
        if (existing) return J({ ok: true, request: existing, canEdit: existing.status === "approved" });
        const request = { id: uid().slice(0, 12), projectId: project.id, memberId: account.id, memberName: me.name, status: "pending", requestedAt: new Date().toISOString() };
        d.meetingEditRequests = [...d.meetingEditRequests.filter((item) => !(item.projectId === project.id && item.memberId === account.id && item.status !== "pending" && !(item.status === "approved" && item.expiresAt > Date.now()))), request].slice(-1000);
        await save(d);
        const admins = project.members
          .filter((entry) => entry.role === "Admin" && entry.status !== "disabled")
          .map((entry) => d.members.find((member) => member.id === entry.memberId && member.status !== "disabled" && member.email))
          .filter(Boolean);
        const origin = u.origin;
        const notificationResults = await Promise.all(admins.map((admin) => send(
          admin.email,
          `Meeting edit approval requested: ${project.name}`,
          `<p>Hello ${emailHtml(admin.name)},</p><p><b>${emailHtml(me.name)}</b> requested temporary meeting edit access for <b>${emailHtml(project.name)}</b>.</p><p>Approval grants edit access for one hour. Open the project dashboard and review the pending request.</p><p><a href="${emailHtml(origin)}">Open dashboard</a></p>`
        )));
        return J({
          ok: true,
          request,
          adminNotificationsSent: notificationResults.filter((item) => item.sent).length,
          adminNotificationsFailed: notificationResults.filter((item) => !item.sent).length,
          emailErrors: [...new Set(notificationResults.filter((item) => !item.sent).map((item) => item.error).filter(Boolean))],
        });
      }
      if (b.action === "review-edit-access") {
        if (me.role !== "Admin") return J({ error: "Only a project admin can approve temporary meeting edit access" }, 403);
        const accessRequest = d.meetingEditRequests.find((item) => item.id === String(b.requestId || "") && item.projectId === project.id && item.status === "pending");
        if (!accessRequest) return J({ error: "Pending access request not found" }, 404);
        if (!["approve", "deny"].includes(b.decision)) return J({ error: "Select approve or deny" }, 400);
        accessRequest.status = b.decision === "approve" ? "approved" : "denied";
        accessRequest.reviewedAt = new Date().toISOString();
        accessRequest.reviewedBy = me.name;
        if (b.decision === "approve") accessRequest.expiresAt = Date.now() + 60 * 60 * 1000;
        await save(d);
        return J({ ok: true, request: accessRequest });
      }
      if (b.action === "create" && !canManageAllMeetingContent) return J({ error: "Only an Admin or Collaborator can create a shared meeting note" }, 403);
      const cleanTasks = (value, previousTasks = []) => {
        if (!Array.isArray(value) || value.length > 200) return null;
        const ids = new Set();
        const tasks = value.map((task) => {
          const id = String(task.id || uid().slice(0, 12));
          if (ids.has(id)) return null;
          ids.add(id);
          const assigneeId = String(task.assigneeId || "");
          if (assigneeId && !activeMembers.some((member) => member.id === assigneeId && member.role !== "Client")) return null;
          const dueDate = String(task.dueDate || "");
          const parsedDueDate = dueDate ? new Date(dueDate) : null;
          const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(dueDate);
          if (dueDate && (!Number.isFinite(parsedDueDate.getTime()) || (dateOnly && parsedDueDate.toISOString().slice(0, 10) !== dueDate) || (!dateOnly && !/^\d{4}-\d{2}-\d{2}T/.test(dueDate)))) return null;
          const previous = previousTasks.find((item) => item.id === id);
          const comments = previous?.comments || [];
          const status = ["Open", "In Progress", "Completed"].includes(task.status) ? task.status : "Open";
          const title = String(task.title || "").trim().slice(0, 300);
          const description = String(task.description || "").trim().slice(0, 2000);
          if (!title) return null;
          return { id, title, description, assigneeId, dueDate, status, comments, priority: ["High", "Medium", "Low"].includes(task.priority) ? task.priority : "Medium", remindersSent: previous?.dueDate === dueDate ? previous.remindersSent || [] : [] };
        });
        return tasks.some((task) => !task) ? null : tasks;
      };
      if (b.action === "create") {
        const title = String(b.title || "").trim().slice(0, 160), date = String(b.date || ""), summary = String(b.summary || ""), transcript = String(b.transcript || "");
        const meeting = b.meetingId ? d.meetings.find((item) => item.id === b.meetingId && item.projectId === project.id) : null;
        if (b.meetingId && !meeting) return J({ error: "Meeting not found in this project" }, 404);
        const parsedDate = new Date(`${date}T00:00:00Z`);
        if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date || (meeting && meeting.date !== date) || summary.length > 20000 || transcript.length > 50000) {
          return J({ error: "Enter a title, valid date, and notes within the allowed length" }, 400);
        }
        let participantSummaries = cleanCards(b.participantSummaries || []);
        const tasks = cleanTasks(b.tasks || []);
        if (!participantSummaries || !tasks) return J({ error: "Invalid member-specific notes or action items" }, 400);
        const note = {
          id: uid().slice(0, 12), projectId: project.id, meetingId: meeting?.id || "",
          date, title, summary, transcript, participantSummaries, tasks,
          createdBy: account.id, createdByName: me.name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        d.meetingNotes.push(note); await save(d);
        const summaryResults = b.deferEmails ? [] : await Promise.all(participantSummaries.map(async (card) => {
          const member = activeMembers.find((item) => item.id === card.memberId);
          const lines = card.points.map((line) => `<li>${emailHtml(line)}</li>`);
          if (!member || !lines.length) return { sent: false, skipped: true };
          const result = await send(member.email, `Meeting notes for you: ${title}`, `<p>Hello ${emailHtml(member.name)},</p><p>Here are the notes assigned to you from <b>${emailHtml(project.name)}</b> on ${emailHtml(date)}.</p><p><b>Shared key points:</b><br>${emailHtml(summary).replace(/\n/g, "<br>")}</p><ul>${lines.join("")}</ul><p>Open the project portal and select Meeting Notes to review or comment on action items.</p>`);
          return { sent: result.sent, error: result.error, skipped: false };
        }));
        const alreadyEmailedTasks = meeting?.occurrences?.[date]?.emailedTasks || {};
        const emailedTaskKeys = new Set(Object.entries(alreadyEmailedTasks).flatMap(([memberId, titles]) => titles.map((taskTitle) => `${memberId}:${taskTitle}`)));
        const taskEmailResults = b.deferEmails ? [] : await emailAssignedTasks(d, {
          tasks: tasks.filter((task) => !emailedTaskKeys.has(`${task.assigneeId}:${task.title.toLowerCase()}`)),
          title,
          projectName: project.name,
        });
        return J({
          ok: true, note,
          summaryEmailsSent: summaryResults.filter((result) => result.sent).length,
          summaryEmailsFailed: summaryResults.filter((result) => !result.sent && !result.skipped).length,
          taskEmailsSent: taskEmailResults.filter((result) => result.sent).length,
          taskEmailsFailed: taskEmailResults.filter((result) => !result.sent && !result.skipped).length,
          emailErrors: [...new Set([...summaryResults, ...taskEmailResults].filter((result) => result.error).map((result) => result.error))],
        });
      }
      const note = d.meetingNotes.find((item) => item.id === String(b.noteId || "") && item.projectId === project.id);
      if (!note) return J({ error: "Meeting note not found" }, 404);
      if (b.action === "task-status") {
        if (!["Open", "In Progress", "Completed"].includes(b.status)) return J({ error: "Choose Open, In Progress, or Completed" }, 400);
        const task = (note.tasks || []).find((item) => item.id === String(b.taskId || ""));
        if (!task) return J({ error: "Task not found" }, 404);
        if (task.assigneeId !== account.id) return J({ error: "You can only update the status of tasks assigned to you" }, 403);
        task.status = b.status;
        note.updatedAt = new Date().toISOString();
        await save(d);
        return J({ ok: true, note });
      }
      if (!canEditMeetingContent) return J({ error: "Admin or Collaborator access, or a current one-hour admin approval, is required to edit meeting notes and tasks" }, 403);
      if (b.action === "update") {
        const title = String(b.title || "").trim().slice(0, 160), summary = String(b.summary || ""), transcript = String(b.transcript || "");
        const participantSummaries = cleanCards(b.participantSummaries || []);
        const tasks = cleanTasks(b.tasks || [], note.tasks || []);
        if (!title || summary.length > 20000 || transcript.length > 50000 || !participantSummaries || !tasks) return J({ error: "Invalid note or action item data" }, 400);
        const previousTasks = note.tasks || [];
        if (!canManageAllMeetingContent) {
          if (title !== note.title || summary !== note.summary || transcript !== note.transcript) return J({ error: "Temporary edit access only allows changes to your member card and your assigned tasks" }, 403);
          const previousCards = note.participantSummaries || [];
          if (participantSummaries.length !== previousCards.length || previousCards.some((previous) => {
            const submitted = participantSummaries.find((card) => card.memberId === previous.memberId);
            return !submitted || (!canEditMemberContent(previous.memberId) && JSON.stringify(submitted) !== JSON.stringify(previous));
          })) return J({ error: "Temporary edit access only allows changes to your own member card" }, 403);
          const taskSignature = (task) => JSON.stringify({
            title: task.title, description: task.description || "", assigneeId: task.assigneeId || "",
            dueDate: task.dueDate || "", status: task.status || "Open", priority: task.priority || "Medium",
            comments: task.comments || [], remindersSent: task.remindersSent || [],
          });
          if (tasks.length !== previousTasks.length || previousTasks.some((previous) => {
            const submitted = tasks.find((task) => task.id === previous.id);
            return !submitted || (previous.assigneeId === account.id
              ? submitted.assigneeId !== account.id || JSON.stringify(submitted.comments || []) !== JSON.stringify(previous.comments || [])
              : taskSignature(submitted) !== taskSignature(previous));
          })) return J({ error: "Temporary edit access only allows changes to tasks assigned to you; you cannot add, remove, reassign, or edit another member's tasks" }, 403);
        }
        note.title = title; note.summary = summary; note.transcript = transcript;
        note.participantSummaries = participantSummaries; note.tasks = tasks; note.updatedAt = new Date().toISOString();
        await save(d);
        const taskEmailResults = await emailAssignedTasks(d, { tasks, previousTasks, title, projectName: project.name });
        return J({
          ok: true, note,
          taskEmailsSent: taskEmailResults.filter((result) => result.sent).length,
          taskEmailsFailed: taskEmailResults.filter((result) => !result.sent && !result.skipped).length,
          emailErrors: [...new Set(taskEmailResults.filter((result) => result.error).map((result) => result.error))],
        });
      }
      if (b.action === "comment") {
        const task = note.tasks.find((item) => item.id === String(b.taskId || ""));
        const text = String(b.text || "").trim().slice(0, 2000);
        if (!task || !text) return J({ error: "Task or comment is missing" }, 400);
        if (!canManageAllMeetingContent && (!activeMeetingGrant || task.assigneeId !== account.id)) return J({ error: "Temporary edit access only allows comments on your own assigned tasks" }, 403);
        task.comments.push({ id: uid().slice(0, 12), by: me.name, text, createdAt: new Date().toISOString() });
        task.comments = task.comments.slice(-100);
        note.updatedAt = new Date().toISOString();
        await save(d);
        return J({ ok: true, note });
      }
      if (b.action === "delete") {
        if (me.role !== "Admin") return J({ error: "Only an admin can delete meeting notes" }, 403);
        const audioIds = new Set([...(note.audioFiles || []), note.audioFile].filter(Boolean).map((clip) => clip.id));
        for (const audioId of audioIds) await delFile(audioId);
        d.meetingNotes = d.meetingNotes.filter((item) => item.id !== note.id); await save(d);
        return J({ ok: true });
      }
      return J({ error: "Invalid meeting note action" }, 400);
    }
    if (r === "logoutall") { account.sessions = []; delete account.key; log(d, me.name, "Signed out of all devices"); await save(d); return J({ ok: true }); }
    if (r === "logout") { account.sessions = (account.sessions || []).filter((x) => x !== key); await save(d); return J({ ok: true }); }
    if (r === "account") {
      const b = await req.json();
      if (b.password && me.pw && !verify(String(b.current || ""), me.pw)) return J({ error: "Current password is incorrect" }, 403);
      if (b.phone) {
        if (d.members.some((x) => x !== account && np(x.phone) === np(b.phone))) return J({ error: "Phone number already in use" }, 400);
        account.phone = np(b.phone);
      }
      if (b.name) account.name = String(b.name).trim().slice(0, 80);
      if (b.password) {
        if (!pwOk(b.password)) return J({ error: PWMSG }, 400);
        account.pw = hash(b.password); account.sessions = [key]; delete account.key;
      }
      account.email = account.email.toLowerCase(); log(d, account.name, b.password ? "Changed password" : "Updated account"); await save(d);
      return J({ ok: true });
    }
    if (r === "organization") {
      if (me.role !== "Admin") return J({ error: "Admin only" }, 403);
      const body = await req.json();
      const name = String(body.name || "").trim().slice(0, 80);
      if (!name) return J({ error: "Company name is required" }, 400);
      if (d.organizations.some((item) => item.name.toLowerCase() === name.toLowerCase())) return J({ error: "A company with this name already exists" }, 400);
      const organization = { id: uid().slice(0, 12), name, adminIds: [account.id] };
      d.organizations.push(organization);
      await save(d);
      return J({ ok: true, organization });
    }
    if (r === "project") {
      if (me.role !== "Admin") return J({ error: "Admin only" }, 403);
      const body = await req.json();
      const name = String(body.name || "").trim().slice(0, 60);
      if (!name) return J({ error: "Project name is required" }, 400);
      const organizationId = String(body.organizationId || project.organizationId || defaultOrganization.id);
      const organization = d.organizations.find((item) => item.id === organizationId);
      if (!organization || !(organization.adminIds || []).includes(account.id)) return J({ error: "Only an admin of this company can create a project in it" }, 403);
      if (d.projects.some((x) => x.organizationId === organizationId && x.name.toLowerCase() === name.toLowerCase())) return J({ error: "A project with this name already exists in this company" }, 400);
      const created = { id: uid().slice(0, 12), organizationId, name, tickets: [], files: [], audit: [], members: [{ memberId: account.id, role: "Admin", status: "active" }] };
      organization.adminIds = [...new Set([...(organization.adminIds || []), account.id])];
      created.audit.unshift({ at: new Date().toISOString(), who: me.name, act: "Created project", detail: name });
      d.projects.push(created); await save(d);
      return J({ ok: true, project: { id: created.id, name: created.name, organizationId: created.organizationId } });
    }
    if (r === "tickets") {
      if (me.role === "Client") return J({ error: "Not allowed" }, 403);
      const b = await req.json();
      const gone = d.tickets.filter((t) => !b.tickets.some((x) => x.id === t.id));
      if (gone.some((t) => me.role !== "Admin" || (t.assignees || []).includes(me.id))) return J({ error: "Not allowed to delete" }, 403);
      const old = Object.fromEntries(d.tickets.map((t) => [t.id, t]));
      if (me.role === "Collaborator" && b.tickets.some((t) => old[t.id] && JSON.stringify({ ...old[t.id], attachments: 0 }) !== JSON.stringify({ ...t, attachments: 0 }))) return J({ error: "Not allowed" }, 403);
      const jobs = [];
      b.tickets.forEach((t) => {
        const o = old[t.id];
        if (o) t.rem = o.deadline !== t.deadline ? [] : (o.rem || []);
        if (!o) log(d, me.name, "Created " + t.id, t.title);
        else if (JSON.stringify(o) !== JSON.stringify(t)) {
          const changes = ticketChanges(o, t, d.members);
          log(d, me.name, "Updated " + t.id, changes.length ? changes : t.title);
          const c = d.members.find((m) => m.id === t.createdBy);
          if (c && o.status !== "Completed" && t.status === "Completed") jobs.push(send(c.email, "Your ticket " + t.id + " has been resolved",
            `<p>Hello ${emailHtml(c.name)},</p><p>Your ticket <b>${emailHtml(t.id)}</b> - ${emailHtml(t.title)} has been marked as resolved.</p><p>Please <a href="${emailHtml(browserSiteUrl(u.origin))}">sign in to the portal</a> to review the solution and check the fix in your product. If you are not satisfied, you can reopen the ticket from the portal.</p>`));
        }
      });
      gone.forEach((t) => log(d, me.name, "Deleted " + t.id, t.title));
      d.tickets = b.tickets; await save(d); await Promise.all(jobs);
      return J({ ok: true });
    }
    if (r === "client") {
      if (me.role !== "Client") return J({ error: "Not allowed" }, 403);
      const b = await req.json();
      if (b.action === "reopen") {
        const t = d.tickets.find((x) => x.id === b.id && x.createdBy === me.id), why = String(b.reason || "").trim().slice(0, 500);
        if (!t || t.status !== "Completed" || !why) return J({ error: "This ticket cannot be reopened" }, 400);
        const previousStatus = t.status;
        t.status = "Reopened"; t.closed = ""; t.notes = [...(t.notes || []), { at: td(), by: me.name, text: "Reopened: " + why }];
        log(d, me.name, "Reopened " + t.id, [
          { field: "Status", old: previousStatus, new: t.status },
          { field: "Reopen reason", old: "—", new: why },
        ]); await save(d);
        await Promise.all(emails(d, t.assignees || []).map((e) => send(e, "Ticket reopened: " + t.id, `<p>${esc(me.name)} reopened <b>${t.id}</b> - ${esc(t.title)}.</p><p>Reason: ${esc(why)}</p>`)));
        return J({ ok: true });
      }
      const x = b.ticket || {}, title = String(x.title || "").trim().slice(0, 150), details = String(x.details || "").trim().slice(0, 3000);
      if (!title) return J({ error: "Title is required" }, 400);
      if (x.id) {
        const t = d.tickets.find((y) => y.id === x.id && y.createdBy === me.id);
        if (!t || t.status === "Completed") return J({ error: "This ticket cannot be edited" }, 400);
        const previous = { ...t };
        t.title = title; t.details = details;
        const changes = ticketChanges(previous, t, d.members);
        if (changes.length) log(d, me.name, "Updated " + t.id, changes);
        await save(d);
        return J({ id: t.id });
      }
      const type = x.type === "feature" ? "feature" : "issue";
      const n = Math.max(0, ...d.tickets.filter((y) => y.type === type).map((y) => parseInt(y.id.split("-").pop()) || 0)) + 1;
      const t = { id: (type === "issue" ? "ISS-" : "FTR-") + String(n).padStart(2, "0"), type, date: td(), by: "Client", title, priority: "", assignees: [], details, version: "", deployed: "", status: "Open", closed: "", createdBy: me.id };
      d.tickets.push(t); log(d, me.name, "Created " + t.id, title); await save(d);
      await Promise.all(d.members.filter((m) => m.role === "Admin").map((m) => send(m.email, "New client ticket " + t.id, `<p>${esc(me.name)} raised <b>${t.id}</b>: ${esc(title)}</p>`)));
      return J({ id: t.id });
    }
    if (r === "addlink") {
      const b = await req.json(), tk = String(b.ticket || "");
      if (!/^https?:\/\//i.test(b.url || "") || !CATS.includes(b.cat)) return J({ error: "Enter a valid http(s) link" }, 400);
      if (me.role === "Client" && !d.tickets.some((t) => t.id === tk && t.createdBy === me.id)) return J({ error: "Not allowed" }, 403);
      d.files.unshift({ id: uid().slice(0, 12), name: String(b.name || b.url).slice(0, 120), url: b.url, cat: b.cat, by: me.name, at: td(), ticket: tk });
      log(d, me.name, "Added document link", String(b.name || b.url)); await save(d);
      return J({ ok: true });
    }
    if (r === "upload") {
      const fd = await req.formData(), f = fd.get("file"), cat = String(fd.get("cat") || ""), tk = String(fd.get("ticket") || "");
      if (me.role === "Client" && !d.tickets.some((t) => t.id === tk && t.createdBy === me.id)) return J({ error: "Not allowed" }, 403);
      if (!CATS.includes(cat)) return J({ error: "Invalid category" }, 400);
      const MAX = remote ? 4e6 : 25e6;
      if (!f || f.size > MAX) return J({ error: "File missing or larger than " + MAX / 1e6 + " MB. For bigger files use Add link." }, 400);
      const n = uid() + path.extname(f.name || "").slice(0, 10);
      await putFile(n, Buffer.from(await f.arrayBuffer()), f.type);
      d.files.unshift({ id: n, name: f.name, size: f.size, cat, by: me.name, at: td(), ticket: tk });
      log(d, me.name, "Uploaded file", f.name + " (" + cat + ")"); await save(d);
      return J({ ok: true });
    }
    if (r === "filedel") {
      const b = await req.json(), x = d.files.find((y) => y.id === b.id);
      if (me.role === "Collaborator" || me.role === "Client") return J({ error: "Not allowed" }, 403);
      if (x) { if (!x.url) await delFile(path.basename(x.id)); d.files = d.files.filter((y) => y !== x); log(d, me.name, "Deleted file", x.name); await save(d); }
      return J({ ok: true });
    }
    if (me.role !== "Admin") return J({ error: "Admin only" }, 403);
    const b = await req.json();
    if (r === "invite") {
      b.email = String(b.email || "").trim().toLowerCase();
      if (!ROLES.includes(b.role) || !b.email) return J({ error: "Invalid input" }, 400);
      const existing = d.members.find((x) => x.email === b.email);
      if (existing && project.members.some((x) => x.memberId === existing.id)) return J({ error: "Already a member of " + project.name }, 400);
      if (d.invites.some((x) => x.projectId === project.id && x.email === b.email)) return J({ error: "An invitation is already pending for this project" }, 400);
      const token = uid(), link = browserSiteUrl(u.origin) + "/?invite=" + token;
      d.invites.push({ token, email: b.email, role: b.role, projectId: project.id }); await save(d);
      log(d, me.name, "Invited member", b.email + " to " + project.name + " as " + b.role); await save(d);
      const result = await mail(b.email, link, b.role, project.name);
      return J({ link, sent: result.sent, emailError: result.error });
    }
    if (r === "testmail") {
      const st = emailStatus();
      const result = await sendEmail({ to: account.email, subject: "Test email from LoopDesk", html: "<p>Your email setup works. This message was sent from LoopDesk Team & Project Management.</p>" });
      return J({ ...result, to: account.email, from: st.from, replyTo: st.replyTo });
    }
    if (r === "adminreset") {
      const x = d.members.find((y) => y.id === b.id);
      if (!x) return J({ error: "Not found" }, 404);
      const o = await resetLink(d, x, u.origin); log(d, me.name, "Sent password reset to", x.name); await save(d);
      return J(o);
    }
    if (r === "status") {
      const x = d.members.find((y) => y.id === b.id), entry = project.members.find((y) => y.memberId === b.id);
      if (x && entry && x.id !== account.id) {
        if (b.disabled && entry.role === "Admin" && entry.status !== "disabled" && project.members.filter((y) => y.role === "Admin" && y.status !== "disabled").length < 2) return J({ error: "A project must have at least one active admin" }, 400);
        entry.status = b.disabled ? "disabled" : "active"; log(d, me.name, b.disabled ? "Disabled project member" : "Enabled project member", x.name + " in " + project.name); await save(d);
      }
      return J({ ok: true });
    }
    if (r === "role") {
      const x = d.members.find((x) => x.id === b.id), entry = project.members.find((y) => y.memberId === b.id);
      if (!ROLES.includes(b.role)) return J({ error: "Invalid role" }, 400);
      if (x && entry && x.id !== account.id) {
        if (entry.role === "Admin" && b.role !== "Admin" && entry.status !== "disabled" && project.members.filter((y) => y.role === "Admin" && y.status !== "disabled").length < 2) return J({ error: "A project must have at least one active admin" }, 400);
        entry.role = b.role; log(d, me.name, "Changed project role", x.name + " to " + b.role + " in " + project.name); await save(d);
      }
      return J({ ok: true });
    }
    if (r === "remove") {
      if (b.token) d.invites = d.invites.filter((x) => x.token !== b.token || x.projectId !== project.id);
      else if (b.id !== account.id) {
        const removed = d.members.find((x) => x.id === b.id);
        const entry = project.members.find((x) => x.memberId === b.id);
        if (entry && entry.role === "Admin" && entry.status !== "disabled" && project.members.filter((x) => x.role === "Admin" && x.status !== "disabled").length < 2) return J({ error: "A project must have at least one active admin" }, 400);
        project.members = project.members.filter((x) => x.memberId !== b.id);
        project.tickets.forEach((t) => { t.assignees = (t.assignees || []).filter((id) => id !== b.id); });
        log(d, me.name, "Removed project member", (removed || {}).name + " from " + project.name);
      }
      await save(d);
      return J({ ok: true });
    }
  } catch (e) {
    const message = String(e);
    if (isWorkspaceWriteBusy(e)) {
      return J({ error: "Another workspace update is being processed. Please retry shortly." }, 503, { "Retry-After": "1" });
    }
    const conflict = message.includes("Concurrent update detected") || message.includes("A record was created by another request");
    return J({ error: conflict ? "This record changed in another request. Reload the page and retry." : message }, conflict ? 409 : 500);
  }
  return J({ error: "not found" }, 404);
}
const handle = async (req, { params }, method) => {
  try {
    return await h(req, params.p, method);
  } catch (error) {
    console.error("API request failed:", error);
    if (isWorkspaceWriteBusy(error)) {
      return J({ error: "Another workspace update is being processed. Please retry shortly." }, 503, { "Retry-After": "1" });
    }
    const conflict = String(error.message).includes("Concurrent update detected") || String(error.message).includes("A record was created by another request");
    return J({ error: conflict ? "This record changed in another request. Reload the page and retry." : `API request failed: ${error.message}` }, conflict ? 409 : 500);
  }
};
export const GET = (req, context) => handle(req, context, "GET");
export const POST = (req, context) => handle(req, context, "POST");
