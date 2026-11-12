// Platform Admin console API: the LoopDesk operator (Solexes) sees every company that signed up and
// can suspend / reactivate it or change its plan. Only the emails in PLATFORM_ADMIN_EMAILS
// (comma separated; defaults to ADMIN_EMAIL) can use it. It never opens a company's own data.
import fs from "fs";
import path from "path";
import { remote } from "./store";
import { loadAllOrgMeta, updateOrgMeta } from "./tenant-store";

const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
const H = (x = {}) => ({ apikey: K, ...(String(K).startsWith("sb_") ? {} : { Authorization: "Bearer " + K }), ...x });
const J = (o, s = 200) => Response.json(o, { status: s, headers: { "Cache-Control": "no-store" } });
const enc = encodeURIComponent;
export const PLANS = ["trial", "starter", "business", "enterprise"];

export const platformAdminEmails = () => (process.env.PLATFORM_ADMIN_EMAILS || process.env.ADMIN_EMAIL || "")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
export const isPlatformAdmin = (email) => !!email && platformAdminEmails().includes(String(email).toLowerCase());

async function rest(pathAndQuery) {
  const response = await fetch(`${U}/rest/v1/${pathAndQuery}`, { headers: H(), cache: "no-store" });
  if (!response.ok) throw new Error(`Database request failed: ${response.status} ${await response.text()}`);
  return response.json();
}
async function all(table, select) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rest(`${table}?select=${select}&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function sessionMember(token) {
  if (!token) return null;
  if (!remote) {
    const d = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "db.json"), "utf8"));
    const member = d.members.find((m) => m.status !== "disabled" && (m.sessions || []).includes(token));
    return member ? { id: member.id, name: member.name, email: member.email } : null;
  }
  const [row] = await rest(`member_sessions?token=eq.${enc(token)}&select=expires_at,members(id,name,email,status)&limit=1`);
  if (!row || (row.expires_at != null && Number(row.expires_at) <= Date.now()) || row.members?.status === "disabled") return null;
  return row.members;
}

// Every company with its departments / sub-companies, projects, people and owner.
async function overview() {
  let organizations, admins, projects, memberships, members;
  if (!remote) {
    const d = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "db.json"), "utf8"));
    organizations = (d.organizations || []).map((o) => ({ id: o.id, name: o.name, created_at: "" }));
    admins = (d.organizations || []).flatMap((o) => (o.adminIds || []).map((memberId) => ({ organization_id: o.id, member_id: memberId })));
    projects = d.projects.map((p) => ({ id: p.id, organization_id: p.organizationId, name: p.name }));
    memberships = d.projects.flatMap((p) => p.members.map((m) => ({ project_id: p.id, member_id: m.memberId, status: m.status })));
    members = d.members.map((m) => ({ id: m.id, name: m.name, email: m.email }));
  } else {
    [organizations, admins, projects, memberships] = await Promise.all([
      all("organizations", "id,name,created_at"),
      all("organization_admins", "organization_id,member_id"),
      all("projects", "id,organization_id,name"),
      all("project_members", "project_id,member_id,status"),
    ]);
    members = null;
  }
  const meta = await loadAllOrgMeta();
  const childrenOf = new Map();
  organizations.forEach((o) => {
    const parentId = meta.get(o.id)?.parentId;
    if (parentId) childrenOf.set(parentId, [...(childrenOf.get(parentId) || []), o]);
  });
  const tenants = organizations.filter((o) => !meta.get(o.id)?.parentId).map((o) => {
    const m = meta.get(o.id) || {};
    const children = childrenOf.get(o.id) || [];
    const orgIds = new Set([o.id, ...children.map((c) => c.id)]);
    const tenantProjects = projects.filter((p) => orgIds.has(p.organization_id));
    const projectIds = new Set(tenantProjects.map((p) => p.id));
    const people = new Set(memberships.filter((x) => projectIds.has(x.project_id) && x.status !== "disabled").map((x) => x.member_id));
    const ownerId = m.ownerId || admins.find((a) => a.organization_id === o.id)?.member_id || "";
    return {
      id: o.id, name: o.name, status: m.status || "active", plan: m.plan || "", createdAt: m.createdAt || (o.created_at ? Date.parse(o.created_at) : 0),
      signedUp: !!m.ownerId && m.plan !== "", ownerId,
      departments: children.filter((c) => meta.get(c.id)?.kind === "department").map((c) => c.name),
      subsidiaries: children.filter((c) => meta.get(c.id)?.kind === "subsidiary").map((c) => c.name),
      projects: tenantProjects.length, people: people.size,
    };
  });
  // Owner names and emails, looked up only for the owners.
  const ownerIds = [...new Set(tenants.map((t) => t.ownerId).filter(Boolean))];
  if (!members && ownerIds.length) members = await rest(`members?id=in.(${ownerIds.map((id) => `"${id.replace(/"/g, "")}"`).join(",")})&select=id,name,email`);
  const byId = new Map((members || []).map((m) => [m.id, m]));
  tenants.forEach((t) => { const owner = byId.get(t.ownerId); t.ownerName = owner?.name || ""; t.ownerEmail = owner?.email || ""; delete t.ownerId; });
  return tenants.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function platformRequest(req, method, key) {
  try {
    const me = await sessionMember(key);
    if (!me) return J({ error: "denied" }, 401);
    if (!isPlatformAdmin(me.email)) return J({ error: "Platform admins only" }, 403);
    if (method === "GET") return J({ tenants: await overview(), plans: PLANS, signupsOpen: String(process.env.SIGNUP_DISABLED || "").toLowerCase() !== "true" });
    const b = await req.json();
    const organizationId = String(b.organizationId || "");
    if (!organizationId) return J({ error: "Choose a company" }, 400);
    if (b.action === "set-status") {
      if (!["active", "suspended"].includes(b.status)) return J({ error: "Invalid status" }, 400);
      return J({ ok: true, meta: await updateOrgMeta(organizationId, { status: b.status }) });
    }
    if (b.action === "set-plan") {
      if (!PLANS.includes(b.plan)) return J({ error: "Invalid plan" }, 400);
      return J({ ok: true, meta: await updateOrgMeta(organizationId, { plan: b.plan }) });
    }
    return J({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("Platform request failed:", error);
    return J({ error: error?.message || "Request failed" }, 500);
  }
}
