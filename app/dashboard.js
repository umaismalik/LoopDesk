"use client";
import { useEffect, useMemo, useRef, useState } from "react";

// Status identity colors (categorical; validated as an ordered set for color-vision deficiency).
// Light-surface contrast is below 3:1 for yellow and green, so every chart also has direct
// labels or a legend with counts plus a data table.
export const STATUS_ORDER = ["Open", "In Progress", "Testing", "Completed", "Reopened"];
export const STATUS_COLORS = { Open: "#2a78d6", "In Progress": "#eda100", Testing: "#6250d6", Completed: "#1baf7a", Reopened: "#eb6834" };
const INK_ON = { "In Progress": "#0b0b0b" }; // label ink inside a filled block; white elsewhere
const SERIES = { raised: "#2a78d6", completed: "#1baf7a" };
const PRIORITIES = ["High", "Medium", "Low", "Not set"];

const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthLabel = (key) => new Date(`${key}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short" });
const fmtDate = (value) => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "—";
const compact = (n) => n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K` : n.toLocaleString("en-GB");
// Four equal whole-number intervals from 0: the step is 1, 2 or 5 × 10^n, so every tick is a clean count.
const niceScale = (v) => {
  const raw = Math.max(1, Math.ceil(v / 4));
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((c) => c >= raw);
  return { max: step * 4, ticks: [0, 1, 2, 3, 4].map((i) => i * step) };
};

function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function DataTable({ caption, columns, rows }) {
  return (
    <details className="dash-table">
      <summary>View data</summary>
      <div className="dash-table-wrap"><table>
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody>
      </table></div>
    </details>
  );
}

function StatTile({ label, value, hint, tone }) {
  return (
    <div className={"dash-tile" + (tone ? " " + tone : "")}>
      <span className="dash-tile-label">{tone === "critical" && <i aria-hidden="true">!</i>}{label}</span>
      <b className="dash-tile-value">{compact(value)}</b>
      {hint && <small>{hint}</small>}
    </div>
  );
}

// One whole split into parts: a tall segmented bar with in-block shares and a legend.
function SegmentedBar({ parts, total }) {
  const [hover, setHover] = useState(null);
  return (
    <div className="dash-seg-wrap">
      <div className="dash-seg" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
        {parts.filter((p) => p.value > 0).map((p) => {
          const share = Math.round((p.value / total) * 100);
          return (
            <div key={p.label} className="dash-seg-part" tabIndex={0} style={{ flexGrow: p.value, background: p.color, color: INK_ON[p.label] || "#fff" }}
              onMouseEnter={() => setHover(p.label)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(p.label)} onBlur={() => setHover(null)}>
              {share >= 9 && <span>{share}%</span>}
              {hover === p.label && <div className="dash-tip" role="tooltip"><b>{p.label}</b><span>{p.value} tickets · {share}%</span></div>}
            </div>
          );
        })}
        {!total && <div className="dash-seg-empty">No tickets yet</div>}
      </div>
      <div className="dash-legend">{parts.map((p) => <span key={p.label}><i style={{ background: p.color }} />{p.label} <em>{p.value}</em></span>)}</div>
    </div>
  );
}

function ThinMeter({ label, done, total }) {
  const share = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="dash-meter">
      <div className="dash-meter-head"><span>{label}</span><b>{share}%</b></div>
      <div className="dash-meter-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share} aria-label={`${label} completion`}>
        <div style={{ width: share + "%" }} />
      </div>
      <small>{done} of {total} completed</small>
    </div>
  );
}

// Two series over months: 2px lines, ringed end markers, crosshair + tooltip on hover.
function TrendChart({ months, series }) {
  const [ref, width] = useElementWidth();
  const [hover, setHover] = useState(null);
  // On narrow cards the end labels would squeeze the plot, so they move out (the legend still names both lines).
  const roomy = width >= 440;
  const height = width && width < 360 ? 190 : 220, left = 30, right = roomy ? 92 : 14, top = 14, bottom = 28;
  const plotW = Math.max(60, width - left - right), plotH = height - top - bottom;
  const { max, ticks } = niceScale(Math.max(1, ...series.flatMap((s) => s.values)));
  const x = (i) => left + (months.length < 2 ? plotW / 2 : (i / (months.length - 1)) * plotW);
  const y = (v) => top + plotH - (v / max) * plotH;
  const ends = series.map((s) => ({ ...s, end: y(s.values[s.values.length - 1] || 0) }));
  const endLabelsFit = roomy && (ends.length < 2 || Math.abs(ends[0].end - ends[1].end) >= 16);
  return (
    <div className="dash-trend" ref={ref}>
      {width > 0 && <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Tickets raised and completed per month">
        {ticks.map((t) => <g key={t}>
          <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} className="dash-grid" />
          <text x={left - 8} y={y(t) + 4} textAnchor="end" className="dash-axis">{t}</text>
        </g>)}
        {months.map((m, i) => <text key={m} x={x(i)} y={height - 8} textAnchor="middle" className="dash-axis">{monthLabel(m)}</text>)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={top} y2={top + plotH} className="dash-crosshair" />}
        {series.map((s) => <g key={s.key}>
          <polyline fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
          {s.values.map((v, i) => (i === s.values.length - 1 || i === hover) && <circle key={i} cx={x(i)} cy={y(v)} r="4" fill={s.color} stroke="#fff" strokeWidth="2" />)}
        </g>)}
        {endLabelsFit && ends.map((s) => <text key={s.key} x={left + plotW + 10} y={s.end + 4} className="dash-endlabel">{s.label} {s.values[s.values.length - 1]}</text>)}
        {months.map((m, i) => <rect key={m} x={x(i) - plotW / Math.max(1, months.length - 1) / 2} y={top} width={plotW / Math.max(1, months.length - 1)} height={plotH}
          fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />)}
      </svg>}
      {hover !== null && <div className="dash-tip floating" style={{ left: Math.max(76, Math.min(x(hover), width - 76)), top: 6 }} role="tooltip">
        <b>{new Date(`${months[hover]}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</b>
        {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}<em>{s.values[hover]}</em></span>)}
      </div>}
    </div>
  );
}

// Horizontal bars, one series: value at the tip, hover shows the share.
function BarList({ rows, total, empty, unit = "open" }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="dash-empty">{empty}</p>;
  return (
    <ul className="dash-bars">
      {rows.map((r) => (
        <li key={r.label} tabIndex={0} title={`${r.label}: ${r.value} ${unit}${total ? ` · ${Math.round((r.value / total) * 100)}%` : ""}`}>
          <span className="dash-bar-label">{r.label}</span>
          <span className="dash-bar-track"><span className="dash-bar-fill" style={{ width: `${Math.max(r.value ? 2 : 0, (r.value / max) * 100)}%` }} /></span>
          <b className="dash-bar-value">{r.value}</b>
        </li>
      ))}
    </ul>
  );
}

export default function Dashboard({ apiGet, members, projectName, onOpenTicket }) {
  const [data, setData] = useState({ tickets: [], generatedAt: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [member, setMember] = useState("");
  const team = useMemo(() => members.filter((m) => m.role !== "Client"), [members]);

  const refresh = async () => {
    setLoading(true);
    const r = await apiGet("analytics");
    if (r.ok) { setData({ tickets: r.tickets || [], generatedAt: r.generatedAt }); setError(""); }
    else setError(r.error || "Analytics could not be loaded.");
    setLoading(false);
  };
  // Reload whenever the project changes; the parent remounts this view per project.
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => {
    const today = dateKey(new Date());
    const list = member ? data.tickets.filter((t) => (t.assignees || []).includes(member)) : data.tickets;
    const done = (t) => t.status === "Completed";
    const open = list.filter((t) => !done(t));
    const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, list.filter((t) => t.status === s).length]));
    const overdue = open.filter((t) => t.deadline && t.deadline < today);
    const now = new Date();
    const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; });
    const raised = months.map((m) => list.filter((t) => String(t.date || "").startsWith(m)).length);
    const completed = months.map((m) => list.filter((t) => done(t) && String(t.closed || "").startsWith(m)).length);
    const workload = [...team.map((m) => ({ label: m.name, value: open.filter((t) => (t.assignees || []).includes(m.id)).length })),
      { label: "Unassigned", value: open.filter((t) => !(t.assignees || []).length).length }]
      .filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
    const priority = PRIORITIES.map((p) => ({ label: p, value: open.filter((t) => (p === "Not set" ? !t.priority : t.priority === p)).length }));
    const upcomingLimit = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14));
    const deadlines = open.filter((t) => t.deadline && t.deadline <= upcomingLimit).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 6);
    const recent = list.filter((t) => done(t) && t.closed).sort((a, b) => String(b.closed).localeCompare(String(a.closed))).slice(0, 5);
    const of = (type) => ({ total: list.filter((t) => t.type === type).length, done: list.filter((t) => t.type === type && done(t)).length });
    return { today, list, open, byStatus, overdue, months, raised, completed, workload, priority, deadlines, recent, issues: of("issue"), features: of("feature") };
  }, [data.tickets, member, team]);

  const total = view.list.length;
  const progress = total ? Math.round((view.byStatus.Completed / total) * 100) : 0;
  const nameOf = (id) => members.find((m) => m.id === id)?.name || "";

  return (
    <div className="dash">
      <div className="dash-filters">
        <div><h2>Project overview</h2><p>{projectName}{data.generatedAt && !loading ? ` · Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</p></div>
        <div className="dash-filter-controls">
          <label><span>Team member</span>
            <select value={member} onChange={(e) => setMember(e.target.value)}><option value="">All team members</option>{team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          </label>
          <button type="button" className="btn alt" onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>
      {error && <div className="meeting-alert" role="alert"><b>Analytics unavailable</b><span>{error}</span></div>}
      <div className={"dash-body" + (loading && data.tickets.length ? " is-refreshing" : "")}>
        <section className="dash-tiles" aria-label="Key figures">
          <StatTile label="Total tickets" value={total} hint={`${view.issues.total} issues · ${view.features.total} features`} />
          <StatTile label="Open" value={view.byStatus.Open + view.byStatus.Reopened} hint={view.byStatus.Reopened ? `${view.byStatus.Reopened} reopened` : "Awaiting work"} />
          <StatTile label="In progress" value={view.byStatus["In Progress"] + view.byStatus.Testing} hint={`${view.byStatus.Testing} in testing`} />
          <StatTile label="Completed" value={view.byStatus.Completed} hint={`${progress}% of all tickets`} />
          <StatTile label="Overdue" value={view.overdue.length} hint={view.overdue.length ? "Past their deadline" : "Nothing overdue"} tone={view.overdue.length ? "critical" : ""} />
          <StatTile label="High priority open" value={view.priority[0].value} hint="Needs attention first" />
        </section>

        <section className="panel dash-card dash-progress">
          <div className="dash-card-head"><h3>Project progress</h3><span>{member ? `Assigned to ${nameOf(member)}` : "All tickets"}</span></div>
          <div className="dash-progress-body">
            <div className="dash-hero"><b>{progress}%</b><span>{view.byStatus.Completed} of {total} tickets completed</span></div>
            <div className="dash-progress-detail">
              <SegmentedBar total={total} parts={STATUS_ORDER.map((s) => ({ label: s, value: view.byStatus[s], color: STATUS_COLORS[s] }))} />
              <div className="dash-meters">
                <ThinMeter label="Issues" done={view.issues.done} total={view.issues.total} />
                <ThinMeter label="Features" done={view.features.done} total={view.features.total} />
              </div>
            </div>
          </div>
          <DataTable caption="Tickets by status" columns={["Status", "Tickets", "Share"]} rows={STATUS_ORDER.map((s) => [s, view.byStatus[s], total ? Math.round((view.byStatus[s] / total) * 100) + "%" : "0%"])} />
        </section>

        <section className="panel dash-card dash-trend-card">
          <div className="dash-card-head"><h3>Raised vs completed</h3><span>Last 6 months</span></div>
          <div className="dash-legend">{[["Raised", SERIES.raised], ["Completed", SERIES.completed]].map(([l, c]) => <span key={l}><i style={{ background: c }} />{l}</span>)}</div>
          <TrendChart months={view.months} series={[
            { key: "raised", label: "Raised", color: SERIES.raised, values: view.raised },
            { key: "completed", label: "Completed", color: SERIES.completed, values: view.completed },
          ]} />
          <DataTable caption="Tickets raised and completed per month" columns={["Month", "Raised", "Completed"]} rows={view.months.map((m, i) => [monthLabel(m) + " " + m.slice(0, 4), view.raised[i], view.completed[i]])} />
        </section>

        <section className="panel dash-card">
          <div className="dash-card-head"><h3>Open work by member</h3><span>{view.open.length} open</span></div>
          <BarList rows={view.workload} total={view.open.length} empty="No open tickets assigned." />
          <DataTable caption="Open tickets by team member" columns={["Member", "Open tickets"]} rows={view.workload.map((r) => [r.label, r.value])} />
        </section>

        <section className="panel dash-card">
          <div className="dash-card-head"><h3>Open by priority</h3><span>{view.open.length} open</span></div>
          <BarList rows={view.priority} total={view.open.length} empty="No open tickets." />
          <DataTable caption="Open tickets by priority" columns={["Priority", "Open tickets"]} rows={view.priority.map((r) => [r.label, r.value])} />
        </section>

        <section className="panel dash-card dash-list-card">
          <div className="dash-card-head"><h3>Upcoming deadlines</h3><span>Overdue and next 14 days</span></div>
          {view.deadlines.length ? <ul className="dash-list">{view.deadlines.map((t) => (
            <li key={t.id}><button type="button" onClick={() => onOpenTicket(t.id)}>
              <span className={"id " + t.type}>{t.id}</span><span className="dash-list-title">{t.title}</span>
              <span className={"dash-due" + (t.deadline < view.today ? " overdue" : "")}>{t.deadline < view.today ? "Overdue · " : ""}{fmtDate(t.deadline)}</span>
            </button></li>))}</ul> : <p className="dash-empty">No deadlines in the next two weeks.</p>}
        </section>

        <section className="panel dash-card dash-list-card">
          <div className="dash-card-head"><h3>Recently completed</h3><span>Latest 5</span></div>
          {view.recent.length ? <ul className="dash-list">{view.recent.map((t) => (
            <li key={t.id}><button type="button" onClick={() => onOpenTicket(t.id)}>
              <span className={"id " + t.type}>{t.id}</span><span className="dash-list-title">{t.title}</span>
              <span className="dash-due">{fmtDate(t.closed)}</span>
            </button></li>))}</ul> : <p className="dash-empty">Nothing completed yet.</p>}
        </section>
      </div>
    </div>
  );
}
