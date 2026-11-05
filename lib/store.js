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
      const state = await loadAuthorizedWorkspace(
        U,
        K,
        scope.sessionToken,
        scope.projectId,
        scope.ticketOffset,
        scope.ticketLimit,
      );
      if (!state.scope?.authorized) return { _scopeUnauthorized: true };
      if (scope.collection) {
        const collection = await loadAuthorizedCollection(
          U,
          K,
          scope.sessionToken,
          scope.projectId,
          scope.collection,
          scope.rangeStart,
          scope.rangeEnd,
          scope.collectionOffset,
          scope.collectionLimit,
          scope.recordId,
        );
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
