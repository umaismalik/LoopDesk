import fs from "fs";
import path from "path";
import normalizedStore from "./normalized-store.cjs";

const {
  attachSnapshot,
  hydrateNormalizedState,
  loadAuthorizedCollection,
  loadAuthorizedWorkspace,
  loadLoginState,
  createMemberSession: createMemberSessionRpc,
  loadWorkspaceMemberCount,
  loadPublicFlowState,
  loadReminderState,
  acquireWorkerLease,
  releaseWorkerLease,
  loadLegacyState,
  loadNormalizedState,
  saveNormalizedState,
  schemaIsCurrent,
  snapshotFor,
  updateSnapshot,
} = normalizedStore;

const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
const supabasePlaceholder = U?.toLowerCase().includes("your-project.supabase.co");
export const remote = !!(U && K && !supabasePlaceholder);
let workspaceMemberCountRequest;
if (supabasePlaceholder) console.warn("Supabase URL is still a placeholder; using local file storage.");
const DIR = path.join(process.cwd(), "data"), DB = path.join(DIR, "db.json"), UP = path.join(DIR, "uploads");
const H = (x = {}) => ({ apikey: K, ...(String(K).startsWith("sb_") ? {} : { Authorization: "Bearer " + K }), ...x });
const fail = async (what, r) => { throw new Error(what + " failed: " + r.status + " " + (await r.text())); };

export async function loadDb(seed, scope = {}) {
  if (remote) {
    if (scope.sessionToken) {
      const readCollection = (projectId) => scope.collection
        ? loadAuthorizedCollection(U, K, scope.sessionToken, projectId, scope.collection, scope.rangeStart,
          scope.rangeEnd, scope.collectionOffset, scope.collectionLimit, scope.recordId)
        : null;
      // With a project named, both reads (each checks the session itself) run in parallel. Without
      // one — the first sign-in on a new browser or device — the collection must be read for the
      // project the workspace read chose for this member, so it waits for that answer.
      const [state, early] = await Promise.all([
        loadAuthorizedWorkspace(U, K, scope.sessionToken, scope.projectId, scope.ticketOffset, scope.ticketLimit),
        scope.projectId ? readCollection(scope.projectId) : null,
      ]);
      if (!state.scope?.authorized) return { _scopeUnauthorized: true };
      const collection = scope.projectId ? early : await readCollection(state.scope.project_id);
      if (collection) {
        if (!collection.scope?.authorized) return { _scopeUnauthorized: true };
        if (collection.scope.forbidden_project) return { _scopeForbidden: true };
        for (const table of [
          "project_files",
          "project_audit",
          "meetings",
          "meeting_people",
          "meeting_occurrences",
          "meeting_notes",
          "meeting_note_participants",
          "meeting_note_tasks",
        ]) {
          state[table] = collection[table] || [];
        }
        state.scope = { ...state.scope, ...collection.scope };
      }
      const d = hydrateNormalizedState(state);
      d._scope = state.scope;
      if (state.scope.forbidden_project) d._scopeForbidden = true;
      attachSnapshot(d, true);
      return d;
    }

    const stored = await loadNormalizedState(U, K);
    if (schemaIsCurrent(stored)) {
      const d = hydrateNormalizedState(stored);
      attachSnapshot(d, true);
      return d;
    }
    const legacy = await loadLegacyState(U, K);
    if (legacy) {
      attachSnapshot(legacy, false);
      return legacy;
    }
    const d = seed();
    if (d) attachSnapshot(d, false);
    return d;
  }
  fs.mkdirSync(UP, { recursive: true });
  if (!fs.existsSync(DB)) {
    const d = seed();
    if (!d) return null;
    fs.writeFileSync(DB, JSON.stringify(d, null, 1));
    return d;
  }
  return JSON.parse(fs.readFileSync(DB, "utf8"));
}
export async function loadLoginDb(identifier, phoneNumber, seed) {
  if (!remote) return loadDb(seed);
  const state = await loadLoginState(U, K, identifier, phoneNumber);
  const d = hydrateNormalizedState(state);
  attachSnapshot(d, true);
  return d;
}
export async function createLoginSession(memberId, token) {
  if (!remote) throw new Error("Targeted login sessions require remote Supabase storage.");
  await createMemberSessionRpc(U, K, memberId, token);
}
export async function getWorkspaceMemberCount() {
  if (!remote) return null;
  if (!workspaceMemberCountRequest) {
    workspaceMemberCountRequest = loadWorkspaceMemberCount(U, K)
      .finally(() => { workspaceMemberCountRequest = null; });
  }
  return workspaceMemberCountRequest;
}
// Every ticket id in a project, including tickets the caller cannot see (other clients' tickets, later
// pages). New ticket numbers must be allocated against this, not the caller's scoped/paged view.
// Returns null in local mode, where the loaded workspace already holds every ticket.
export async function loadProjectTicketIds(projectId) {
  if (!remote) return null;
  const ids = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const r = await fetch(`${U}/rest/v1/tickets?project_id=eq.${encodeURIComponent(projectId)}&select=id&order=id&limit=${pageSize}&offset=${offset}`, { headers: H(), cache: "no-store" });
    if (!r.ok) await fail("Loading ticket ids", r);
    const rows = await r.json();
    ids.push(...rows.map((row) => row.id));
    if (rows.length < pageSize) return ids;
  }
}
// A lean row per ticket in the project (all pages) for dashboard analytics.
// Returns null in local mode, where the loaded workspace already holds every ticket.
export async function loadTicketSummaries(projectId) {
  if (!remote) return null;
  const project = `project_id=eq.${encodeURIComponent(projectId)}`;
  const pageAll = async (pathAndQuery) => {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const r = await fetch(`${U}/rest/v1/${pathAndQuery}&limit=1000&offset=${offset}`, { headers: H(), cache: "no-store" });
      if (!r.ok) await fail("Loading analytics", r);
      const page = await r.json();
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  };
  const [tickets, assignments] = await Promise.all([
    pageAll(`tickets?${project}&select=id,type,status,title,date,deadline:due_date,priority:payload->>priority,closed:payload->>closed,raisedBy:payload->>raisedBy&order=id`),
    pageAll(`ticket_assignees?${project}&select=ticket_id,member_id&order=ticket_id`),
  ]);
  const byTicket = new Map();
  assignments.forEach((row) => byTicket.set(row.ticket_id, [...(byTicket.get(row.ticket_id) || []), row.member_id]));
  return tickets.map((t) => ({ ...t, assignees: byTicket.get(t.id) || [] }));
}
// Who a ticket belongs to (assignees, raiser, client), looked up across all pages so an access check
// does not depend on which page the caller loaded. Local mode reads the already-loaded tickets.
// Returns null when the ticket does not exist.
export async function loadTicketAccess(projectId, ticketId, loadedTickets = []) {
  if (!remote) {
    const t = loadedTickets.find((x) => x.id === ticketId);
    return t ? { id: t.id, assignees: t.assignees || [], raisedBy: t.raisedBy || "", createdBy: t.createdBy || "" } : null;
  }
  const filter = `project_id=eq.${encodeURIComponent(projectId)}`;
  const id = encodeURIComponent(ticketId);
  const [ticketResponse, assigneeResponse] = await Promise.all([
    fetch(`${U}/rest/v1/tickets?${filter}&id=eq.${id}&select=id,createdBy:created_by,raisedBy:payload->>raisedBy`, { headers: H(), cache: "no-store" }),
    fetch(`${U}/rest/v1/ticket_assignees?${filter}&ticket_id=eq.${id}&select=member_id`, { headers: H(), cache: "no-store" }),
  ]);
  if (!ticketResponse.ok) await fail("Loading ticket", ticketResponse);
  if (!assigneeResponse.ok) await fail("Loading ticket assignees", assigneeResponse);
  const [ticket] = await ticketResponse.json();
  if (!ticket) return null;
  return { ...ticket, raisedBy: ticket.raisedBy || "", assignees: (await assigneeResponse.json()).map((row) => row.member_id) };
}
// Remove the attachments of deleted tickets: stored objects first, then their rows. Requests only load
// the files they display, so this works from the database rather than the caller's loaded slice.
// Returns false in local mode, where the caller removes them from the loaded workspace instead.
export async function deleteTicketFiles(projectId, ticketIds) {
  if (!remote) return false;
  if (!ticketIds.length) return true;
  const filter = `project_id=eq.${encodeURIComponent(projectId)}&ticket_id=in.(${ticketIds.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",")})`;
  const r = await fetch(`${U}/rest/v1/project_files?${filter}&select=id,url:payload->>url`, { headers: H(), cache: "no-store" });
  if (!r.ok) await fail("Loading ticket attachments", r);
  for (const file of await r.json()) if (!file.url) await delFile(path.basename(file.id));
  const removed = await fetch(`${U}/rest/v1/project_files?${filter}`, { method: "DELETE", headers: H(), cache: "no-store" });
  if (!removed.ok) await fail("Deleting ticket attachments", removed);
  return true;
}
// Every ticket a client raised in a project with its client-facing serial, across all pages.
// Returns null in local mode, where the loaded workspace already holds every ticket.
export async function loadClientTickets(projectId, clientId) {
  if (!remote) return null;
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const r = await fetch(`${U}/rest/v1/tickets?project_id=eq.${encodeURIComponent(projectId)}&created_by=eq.${encodeURIComponent(clientId)}&select=id,type,date,clientRef:payload->>clientRef&order=id&limit=${pageSize}&offset=${offset}`, { headers: H(), cache: "no-store" });
    if (!r.ok) await fail("Loading client tickets", r);
    const page = await r.json();
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
// Every assigned task of the project's meeting notes held on or before `to` (YYYY-MM-DD), as
// { task, note } rows (see lib/meeting-report.js), across all pages. Returns null in local mode, where
// the loaded workspace already holds every note.
export async function loadMeetingTaskRows(projectId, to) {
  if (!remote) return null;
  const rows = [];
  const select = "payload,note:meeting_notes!inner(id,title,date,project_id,createdAt:payload->>createdAt)";
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${U}/rest/v1/meeting_note_tasks?select=${encodeURIComponent(select)}&note.project_id=eq.${encodeURIComponent(projectId)}&note.date=lte.${encodeURIComponent(to)}&assignee_id=neq.&order=note_id,position&limit=1000&offset=${offset}`, { headers: H(), cache: "no-store" });
    if (!r.ok) await fail("Loading meeting tasks", r);
    const page = await r.json();
    rows.push(...page.map((row) => ({ task: row.payload, note: { id: row.note.id, title: row.note.title, date: row.note.date, createdAt: row.note.createdAt || "" } })));
    if (page.length < 1000) return rows;
  }
}
// Projects with their team (active members, roles, emails) for the monthly report emails.
export async function loadReportTeams() {
  if (!remote) {
    const d = await loadDb(() => null);
    if (!d) return [];
    return (d.projects || []).map((project) => ({
      id: project.id, name: project.name,
      members: (project.members || []).map((entry) => {
        const member = (d.members || []).find((item) => item.id === entry.memberId);
        return member && { id: member.id, name: member.name, email: member.email, status: entry.status === "disabled" || member.status === "disabled" ? "disabled" : "active", role: entry.role };
      }).filter(Boolean),
    }));
  }
  const get = async (pathAndQuery) => {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const r = await fetch(`${U}/rest/v1/${pathAndQuery}&limit=1000&offset=${offset}`, { headers: H(), cache: "no-store" });
      if (!r.ok) await fail("Loading teams", r);
      const page = await r.json();
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  };
  const [projects, memberships, members] = await Promise.all([
    get("projects?select=id,name&order=id"),
    get("project_members?select=project_id,member_id,role,status&order=project_id"),
    get("members?select=id,name,email,status&order=id"),
  ]);
  return projects.map((project) => ({
    id: project.id, name: project.name,
    members: memberships.filter((entry) => entry.project_id === project.id).map((entry) => {
      const member = members.find((item) => item.id === entry.member_id);
      return member && { id: member.id, name: member.name, email: member.email, status: entry.status === "disabled" || member.status === "disabled" ? "disabled" : "active", role: entry.role };
    }).filter(Boolean),
  }));
}
// Marks a monthly report as sent. Returns true only for the first caller, so two overlapping reminder
// runs never email the same report twice.
const REPORTS_FILE = path.join(DIR, "monthly-reports.json");
export async function claimMonthlyReport(reportKey) {
  if (!remote) {
    const sent = fs.existsSync(REPORTS_FILE) ? JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8")) : {};
    if (sent[reportKey]) return false;
    sent[reportKey] = new Date().toISOString();
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(sent, null, 1));
    return true;
  }
  const r = await fetch(`${U}/rest/v1/workspace_meta?on_conflict=key`, {
    method: "POST",
    headers: H({ "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=representation" }),
    body: JSON.stringify([{ key: reportKey, value: { sentAt: new Date().toISOString() } }]),
    cache: "no-store",
  });
  if (!r.ok) await fail("Recording monthly report", r);
  return (await r.json()).length > 0;
}
// Keys of the monthly reports already sent whose key starts with `prefix`.
export async function sentMonthlyReports(prefix) {
  if (!remote) {
    const sent = fs.existsSync(REPORTS_FILE) ? JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8")) : {};
    return Object.keys(sent).filter((reportKey) => reportKey.startsWith(prefix));
  }
  const r = await fetch(`${U}/rest/v1/workspace_meta?key=like.${encodeURIComponent(prefix.replace(/[%*]/g, "") + "*")}&select=key`, { headers: H(), cache: "no-store" });
  if (!r.ok) await fail("Loading monthly reports", r);
  return (await r.json()).map((row) => row.key);
}
export async function loadPublicFlowDb(flow, token, identifier, phoneNumber) {
  if (!remote) return loadDb(() => null);
  const state = await loadPublicFlowState(U, K, flow, token, identifier, phoneNumber);
  const d = hydrateNormalizedState(state);
  d._publicFlowFound = state.flow_found === true;
  for (const key of ["v2", "v3", "v4", "v5", "v6"]) d[key] = true;
  attachSnapshot(d, true);
  return d;
}
export async function loadReminderDb() {
  if (!remote) return loadDb(() => null);
  const state = await loadReminderState(U, K);
  const d = hydrateNormalizedState(state);
  attachSnapshot(d, true);
  return d;
}
export async function acquireReminderLease(token) {
  if (!remote) return true;
  return acquireWorkerLease(U, K, "meeting-ticket-reminders", token, 900);
}
export async function releaseReminderLease(token) {
  if (!remote) return;
  await releaseWorkerLease(U, K, "meeting-ticket-reminders", token);
}
export async function saveDb(d, source = d) {
  if (remote) {
    const previous = snapshotFor(source);
    await saveNormalizedState(U, K, d, previous?.state || null, !previous?.normalized);
    updateSnapshot(source, d, true);
    updateSnapshot(d, d, true);
    return;
  }
  fs.writeFileSync(DB + ".tmp", JSON.stringify(d, null, 1)); fs.renameSync(DB + ".tmp", DB);
}
export async function putFile(name, buf, type) {
  if (remote) {
    const r = await fetch(U + "/storage/v1/object/uploads/" + name, { method: "POST", headers: H({ "Content-Type": type || "application/octet-stream" }), body: buf });
    if (!r.ok) await fail("File upload", r);
    return;
  }
  fs.mkdirSync(UP, { recursive: true }); fs.writeFileSync(path.join(UP, name), buf);
}
export async function getFile(name) {
  if (remote) {
    const r = await fetch(U + "/storage/v1/object/uploads/" + name, { headers: H(), cache: "no-store" });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  }
  const fp = path.join(UP, name);
  return fs.existsSync(fp) ? fs.readFileSync(fp) : null;
}
export async function delFile(name) {
  if (remote) { await fetch(U + "/storage/v1/object/uploads/" + name, { method: "DELETE", headers: H() }); return; }
  try { fs.unlinkSync(path.join(UP, name)); } catch (e) {}
}
