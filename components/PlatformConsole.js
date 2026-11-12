"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Platform Admin console: every company on LoopDesk (signed up or existing), with its owner, size and
// plan. The operator can change a company's plan or suspend / reactivate it. Company data itself
// (tickets, chats, files) is never shown here.
const PLAN_LABEL = { trial: "Trial", starter: "Starter", business: "Business", enterprise: "Enterprise", "": "Not set" };
const initials = (name) => String(name || "?").split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const dateLabel = (ms) => ms ? new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export default function PlatformConsole({ keyValue }) {
  const [data, setData] = useState({ tenants: [], plans: [], signupsOpen: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [busyId, setBusyId] = useState("");

  const call = useCallback(async (body) => {
    try {
      const response = await fetch("/api/platform", {
        method: body ? "POST" : "GET",
        headers: { "x-key": keyValue, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      return { ...(await response.json().catch(() => ({}))), ok: response.ok };
    } catch {
      return { ok: false, error: "Unable to reach the server" };
    }
  }, [keyValue]);
  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await call();
    setLoading(false);
    if (!result.ok) { setError(result.error || "Could not load companies"); return; }
    setError(""); setData(result);
  }, [call]);
  useEffect(() => { refresh(); }, [refresh]);

  const change = async (tenant, body, message) => {
    if (body.status === "suspended" && !confirm(`Suspend ${tenant.name}? Its members will not be able to use LoopDesk until you reactivate it. No data is deleted.`)) return;
    setBusyId(tenant.id); setNotice(""); setError("");
    const result = await call({ organizationId: tenant.id, ...body });
    setBusyId("");
    if (!result.ok) { setError(result.error || "Could not save"); return; }
    setData((d) => ({ ...d, tenants: d.tenants.map((t) => t.id === tenant.id ? { ...t, ...("status" in body ? { status: body.status } : {}), ...("plan" in body ? { plan: body.plan } : {}) } : t) }));
    setNotice(message);
  };

  const monthAgo = Date.now() - 30 * 864e5;
  const stats = useMemo(() => ({
    total: data.tenants.length,
    active: data.tenants.filter((t) => t.status !== "suspended").length,
    suspended: data.tenants.filter((t) => t.status === "suspended").length,
    recent: data.tenants.filter((t) => t.createdAt > monthAgo).length,
    people: data.tenants.reduce((sum, t) => sum + t.people, 0),
  }), [data.tenants, monthAgo]);
  const q = query.trim().toLowerCase();
  const rows = data.tenants.filter((t) => (!statusFilter || (statusFilter === "suspended" ? t.status === "suspended" : t.status !== "suspended"))
    && (!q || `${t.name} ${t.ownerName} ${t.ownerEmail} ${t.departments.join(" ")} ${t.subsidiaries.join(" ")}`.toLowerCase().includes(q)));

  return <section className="pc">
    <header className="pc-hero">
      <div>
        <span className="pc-eyebrow">PLATFORM ADMIN</span>
        <h2>Companies on LoopDesk</h2>
        <p>Every company workspace: owner, size and plan. Suspend a company to pause its access without deleting any data.</p>
      </div>
      <span className={"pc-signups" + (data.signupsOpen ? " open" : "")}>{data.signupsOpen ? "Self sign-up is open" : "Self sign-up is closed (SIGNUP_DISABLED)"}</span>
      <div className="pc-stats">
        <div><b>{stats.total}</b><span>Companies</span></div>
        <div className="ok"><b>{stats.active}</b><span>Active</span></div>
        <div className={stats.suspended ? "bad" : ""}><b>{stats.suspended}</b><span>Suspended</span></div>
        <div className="info"><b>{stats.recent}</b><span>New in 30 days</span></div>
        <div><b>{stats.people}</b><span>People</span></div>
      </div>
    </header>

    <div className="pc-bar">
      <div className="activity-search">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input type="search" placeholder="Search company, owner or email…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search companies" />
      </div>
      <div className="seg" role="group" aria-label="Filter by status">
        {[["", "All"], ["active", "Active"], ["suspended", "Suspended"]].map(([value, label]) => <button type="button" key={label} className={statusFilter === value ? "on" : ""} aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}>{label}</button>)}
      </div>
      <button type="button" className="btn alt" onClick={refresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
    </div>
    {error && <div className="meeting-alert" role="alert">{error}</div>}
    {notice && <div className="meeting-success" role="status">{notice}</div>}

    <div className="pc-list">
      {loading && !data.tenants.length && <div className="mn-skeleton"><span /><span /><span /></div>}
      {!loading && !rows.length && <div className="activity-empty"><b>{data.tenants.length ? "No company matches" : "No companies yet"}</b><span>{data.tenants.length ? "Try another search or filter." : "Companies appear here when they sign up."}</span></div>}
      {rows.map((t, index) => <article key={t.id} className={"pc-card" + (t.status === "suspended" ? " suspended" : "")} style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }}>
        <span className="pc-logo">{initials(t.name)}</span>
        <div className="pc-main">
          <div className="pc-title"><b>{t.name}</b><span className={"pc-status " + (t.status === "suspended" ? "bad" : "ok")}>{t.status === "suspended" ? "Suspended" : "Active"}</span></div>
          <p className="pc-owner">{t.ownerName ? <>{t.ownerName} · <a href={"mailto:" + t.ownerEmail}>{t.ownerEmail}</a></> : "Owner not recorded"}</p>
          <div className="pc-facts">
            <span>📁 {t.projects} project{t.projects === 1 ? "" : "s"}</span>
            <span>👥 {t.people} {t.people === 1 ? "person" : "people"}</span>
            {t.departments.length > 0 && <span title={t.departments.join(", ")}>🏷 {t.departments.length} department{t.departments.length === 1 ? "" : "s"}</span>}
            {t.subsidiaries.length > 0 && <span title={t.subsidiaries.join(", ")}>🏢 {t.subsidiaries.length} sub-compan{t.subsidiaries.length === 1 ? "y" : "ies"}</span>}
            <span>📅 Since {dateLabel(t.createdAt)}</span>
          </div>
        </div>
        <div className="pc-actions">
          <label>Plan<select value={t.plan || ""} disabled={busyId === t.id} onChange={(e) => change(t, { action: "set-plan", plan: e.target.value }, `${t.name} is now on the ${PLAN_LABEL[e.target.value]} plan.`)}>
            {!t.plan && <option value="">Not set</option>}
            {data.plans.map((plan) => <option key={plan} value={plan}>{PLAN_LABEL[plan] || plan}</option>)}
          </select></label>
          {t.status === "suspended"
            ? <button type="button" className="btn" disabled={busyId === t.id} onClick={() => change(t, { action: "set-status", status: "active" }, `${t.name} is active again.`)}>Reactivate</button>
            : <button type="button" className="btn alt pc-suspend" disabled={busyId === t.id} onClick={() => change(t, { action: "set-status", status: "suspended" }, `${t.name} is suspended. Its members can no longer use LoopDesk.`)}>Suspend</button>}
        </div>
      </article>)}
    </div>
    <p className="note">Changes apply within about a minute. Platform admins are set with PLATFORM_ADMIN_EMAILS on the server (comma separated); by default, the ADMIN_EMAIL account.</p>
  </section>;
}
