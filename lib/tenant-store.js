// Storage for companies (tenants), their child organizations, and self sign-up.
//
// Structure:
//   Tenant (main company, e.g. "Solexes" or a customer)  - created only through self sign-up
//     ├─ Child organization: a Department or a Sub-company  - created by the tenant's admins
//     └─ Projects (in the tenant or in any of its child organizations)
//
// Which organization is a tenant and which is a child lives in its own small table (org_meta), so
// the existing workspace tables stay unchanged. An organization without an org_meta row is treated
// as a tenant (all companies that existed before this change).
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { remote } from "./store";

const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
const H = (x = {}) => ({ apikey: K, ...(String(K).startsWith("sb_") ? {} : { Authorization: "Bearer " + K }), ...x });
const DIR = path.join(process.cwd(), "data"), DB = path.join(DIR, "db.json"), META = path.join(DIR, "tenants.json");
const enc = encodeURIComponent;
export const CHILD_KINDS = ["department", "subsidiary"];

export class TenantSetupError extends Error {}

async function rest(pathAndQuery, init = {}) {
  const response = await fetch(`${U}/rest/v1/${pathAndQuery}`, { cache: "no-store", ...init, headers: H(init.headers || {}) });
  if (!response.ok) {
    const text = await response.text();
    if (/PGRST205|42P01|Could not find the table/i.test(text)) {
      throw new TenantSetupError("The database needs the latest update. Run the updated supabase.sql in the Supabase SQL Editor.");
    }
    throw new Error(`Database request failed: ${response.status} ${text}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
const insert = (table, rows) => rest(table, { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(rows) });

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJson = (file, data) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 1));
  fs.renameSync(file + ".tmp", file);
};
const fromMeta = (row) => ({ organizationId: row.organization_id, parentId: row.parent_id || "", kind: row.kind || "tenant", status: row.status || "active", plan: row.plan || "", ownerId: row.owner_member_id || "", createdAt: Number(row.created_at) || 0 });

// ---------------------------------------------------------------------------------------------
// Organization metadata
// ---------------------------------------------------------------------------------------------
export async function loadOrgMeta(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return new Map();
  if (!remote) {
    const meta = readJson(META, { orgs: [], signups: [] }).orgs.filter((row) => list.includes(row.organization_id));
    return new Map(meta.map((row) => [row.organization_id, fromMeta(row)]));
  }
  try {
    const rows = await rest(`org_meta?organization_id=in.(${list.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",")})&select=*`);
    return new Map((rows || []).map((row) => [row.organization_id, fromMeta(row)]));
  } catch (error) {
    // Before the SQL update, every organization simply behaves as a main company.
    if (error instanceof TenantSetupError) return new Map();
    throw error;
  }
}

export async function saveOrgMeta({ organizationId, parentId = "", kind = "tenant", status = "active", plan = "", ownerId = "", createdAt = 0 }) {
  const row = { organization_id: organizationId, parent_id: parentId || null, kind, status, plan, owner_member_id: ownerId, created_at: createdAt || Date.now() };
  if (!remote) {
    const data = readJson(META, { orgs: [], signups: [] });
    data.orgs = [...data.orgs.filter((x) => x.organization_id !== organizationId), row];
    writeJson(META, data);
    return fromMeta(row);
  }
  await rest("org_meta?on_conflict=organization_id", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
  return fromMeta(row);
}

// ---------------------------------------------------------------------------------------------
// Self sign-up: a pending request waits for email verification, then becomes a tenant.
// ---------------------------------------------------------------------------------------------
export const SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;

export async function savePendingSignup(token, email, payload) {
  const row = { token, email, payload, expires_at: Date.now() + SIGNUP_TTL_MS };
  if (!remote) {
    const data = readJson(META, { orgs: [], signups: [] });
    data.signups = [...(data.signups || []).filter((x) => x.expires_at > Date.now() && x.email !== email), row];
    writeJson(META, data);
    return;
  }
  // One pending request per email address: a new request replaces the old one.
  await rest(`signup_requests?email=eq.${enc(email)}`, { method: "DELETE" });
  await rest(`signup_requests?expires_at=lt.${Date.now()}`, { method: "DELETE" }).catch(() => {});
  await insert("signup_requests", [row]);
}

// Returns the pending sign-up and removes it, so a verification link works once.
export async function takePendingSignup(token) {
  if (!token) return null;
  if (!remote) {
    const data = readJson(META, { orgs: [], signups: [] });
    const row = (data.signups || []).find((x) => x.token === token);
    data.signups = (data.signups || []).filter((x) => x.token !== token);
    writeJson(META, data);
    return row && row.expires_at > Date.now() ? row : null;
  }
  const rows = await rest(`signup_requests?token=eq.${enc(token)}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  const row = rows?.[0];
  return row && Number(row.expires_at) > Date.now() ? row : null;
}

export async function findMemberByEmail(email) {
  if (!remote) {
    const d = readJson(DB, null);
    const member = d?.members?.find((m) => String(m.email || "").toLowerCase() === email);
    return member ? { id: member.id, name: member.name, status: member.status || "active", pw: member.pw || "" } : null;
  }
  const [member] = (await rest(`members?email=ilike.${enc(email)}&select=id,name,status&limit=1`)) || [];
  if (!member) return null;
  const [credential] = (await rest(`member_credentials?member_id=eq.${enc(member.id)}&select=password_hash&limit=1`)) || [];
  return { id: member.id, name: member.name, status: member.status, pw: credential?.password_hash || "" };
}

const newId = (length) => crypto.randomBytes(16).toString("hex").slice(0, length);

// Creates the tenant: the company, its owner (new account, or an existing one), and a first project
// where the owner is Admin. Rows are written in the same shape the rest of the app uses.
export async function provisionTenant({ existingMemberId, name, email, passwordHash, companyName, projectName, sessionToken }) {
  const memberId = existingMemberId || newId(8);
  const organization = { id: newId(12), name: companyName };
  const project = { id: newId(12), organizationId: organization.id, name: projectName };
  const audit = { id: newId(32), at: new Date().toISOString(), who: name, act: "Created workspace", detail: `${companyName} · ${projectName}` };

  if (!remote) {
    const d = readJson(DB, null);
    if (!d) throw new Error("Local workspace data is missing. Start the app once with ADMIN_EMAIL set.");
    let member = d.members.find((m) => m.id === memberId);
    if (!member) {
      member = { id: memberId, name, email, phone: "", pw: passwordHash, role: "Admin", sessions: [] };
      d.members.push(member);
    }
    member.sessions = [...(member.sessions || []), sessionToken];
    d.organizations = [...(d.organizations || []), { ...organization, adminIds: [memberId] }];
    d.projects.push({ ...project, tickets: [], files: [], audit: [audit], members: [{ memberId, role: "Admin", status: "active" }] });
    writeJson(DB, d);
  } else {
    let createdMember = false;
    try {
      await insert("organizations", [organization]);
      if (!existingMemberId) {
        await insert("members", [{ id: memberId, email, name, phone: "", status: "active", payload: { id: memberId, name, email, phone: "", role: "Admin" } }]);
        createdMember = true;
        await insert("member_credentials", [{ member_id: memberId, password_hash: passwordHash, legacy_key: "" }]);
      }
      await insert("organization_admins", [{ organization_id: organization.id, member_id: memberId }]);
      await insert("projects", [{ id: project.id, organization_id: organization.id, name: project.name, payload: { id: project.id, organizationId: organization.id, name: project.name } }]);
      await insert("project_members", [{ project_id: project.id, member_id: memberId, role: "Admin", status: "active" }]);
      await insert("project_audit", [{ project_id: project.id, event_id: audit.id, position: Date.parse(audit.at), payload: audit }]);
    } catch (error) {
      // Undo a half-created workspace; deleting the company also removes its project and admin rows.
      await rest(`organizations?id=eq.${enc(organization.id)}`, { method: "DELETE" }).catch(() => {});
      if (createdMember) await rest(`members?id=eq.${enc(memberId)}`, { method: "DELETE" }).catch(() => {});
      throw error;
    }
  }
  await saveOrgMeta({ organizationId: organization.id, kind: "tenant", status: "active", plan: "trial", ownerId: memberId });
  return { memberId, organizationId: organization.id, projectId: project.id };
}

// Every organization's metadata (for the Platform Admin console).
export async function loadAllOrgMeta() {
  if (!remote) {
    const rows = readJson(META, { orgs: [], signups: [] }).orgs;
    return new Map(rows.map((row) => [row.organization_id, fromMeta(row)]));
  }
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rest(`org_meta?select=*&limit=1000&offset=${offset}`);
    rows.push(...(page || []));
    if ((page || []).length < 1000) break;
  }
  return new Map(rows.map((row) => [row.organization_id, fromMeta(row)]));
}

// Changes some fields of an organization's metadata and keeps the rest (an organization without a
// row so far is a main company).
export async function updateOrgMeta(organizationId, changes) {
  const current = (await loadOrgMeta([organizationId])).get(organizationId) || { organizationId, parentId: "", kind: "tenant", status: "active", plan: "", ownerId: "" };
  statusCache.clear();
  return saveOrgMeta({ ...current, ...changes, organizationId });
}

// Whether the main company that an organization belongs to is suspended. Checked on every signed-in
// request, so it is cached for a minute.
const statusCache = globalThis.__loopdeskTenantStatus || (globalThis.__loopdeskTenantStatus = new Map());
export async function tenantSuspended(organizationId) {
  if (!organizationId) return false;
  const hit = statusCache.get(organizationId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const meta = (await loadOrgMeta([organizationId])).get(organizationId);
  const rootId = meta?.parentId || organizationId;
  const root = rootId === organizationId ? meta : (await loadOrgMeta([rootId])).get(rootId);
  const value = root?.status === "suspended";
  if (statusCache.size > 2000) statusCache.clear();
  statusCache.set(organizationId, { value, expires: Date.now() + 60 * 1000 });
  return value;
}
