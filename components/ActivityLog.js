"use client";

import { useMemo, useState } from "react";

// Activity events grouped by week or month on a timeline, with search and category / person filters,
// so a long history stays short: older groups are collapsed until opened.
const CATEGORIES = [
  { id: "tickets", label: "Tickets", color: "#4f46e5", test: (a) => /\b(ISS|FTR)-\d+/.test(a.act) },
  { id: "files", label: "Files", color: "#0891b2", test: (a) => /file|document link/i.test(a.act) },
  { id: "team", label: "Team", color: "#059669", test: (a) => /member|invited|role|password reset/i.test(a.act) },
  { id: "account", label: "Account", color: "#d97706", test: (a) => /password|account|signed out/i.test(a.act) },
  { id: "other", label: "Other", color: "#64748b", test: () => true },
];
const categoryOf = (event) => CATEGORIES.find((c) => c.test(event)).id;
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const weekStart = (date) => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
};
const initials = (name) => String(name || "?").split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const detailText = (detail) => Array.isArray(detail) ? detail.map((c) => `${c.field} ${c.old} ${c.new}`).join(" ") : String(detail || "");

function groupFor(date, mode) {
  if (mode === "month") {
    return { key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}`, label: date.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) };
  }
  const start = weekStart(date), thisWeek = weekStart(new Date());
  const weeksAgo = Math.round((thisWeek - start) / (7 * 864e5));
  const end = new Date(start); end.setDate(start.getDate() + 6);
  const range = `${start.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} – ${end.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`;
  return { key: dayKey(start), label: weeksAgo === 0 ? "This week" : weeksAgo === 1 ? "Last week" : range, sub: weeksAgo <= 1 ? range : "" };
}

export default function ActivityLog({ audit, offset, total, hasMore, loading, onPage }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [person, setPerson] = useState("");
  const [mode, setMode] = useState("week");
  const [openGroups, setOpenGroups] = useState({});

  const events = useMemo(() => audit.map((event, index) => ({ ...event, _key: event.id || `${event.at}-${index}`, _cat: categoryOf(event), _date: new Date(event.at) }))
    .filter((event) => Number.isFinite(event._date.getTime())), [audit]);
  const people = useMemo(() => [...new Set(events.map((e) => e.who).filter(Boolean))].sort(), [events]);
  const counts = useMemo(() => Object.fromEntries(CATEGORIES.map((c) => [c.id, events.filter((e) => e._cat === c.id).length])), [events]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) => (!category || e._cat === category) && (!person || e.who === person)
      && (!q || `${e.who} ${e.act} ${detailText(e.detail)}`.toLowerCase().includes(q)));
  }, [events, query, category, person]);
  const groups = useMemo(() => {
    const map = new Map();
    filtered.forEach((event) => {
      const g = groupFor(event._date, mode);
      if (!map.has(g.key)) map.set(g.key, { ...g, events: [] });
      map.get(g.key).events.push(event);
    });
    return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
  }, [filtered, mode]);
  const searching = !!(query.trim() || category || person);
  const isOpen = (group, index) => openGroups[mode + group.key] ?? (searching || index === 0);
  const toggle = (group, index) => setOpenGroups((o) => ({ ...o, [mode + group.key]: !isOpen(group, index) }));

  return <section className="panel activity">
    <div className="activity-toolbar">
      <div className="activity-search">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input type="search" placeholder="Search activity: ticket ID, person, change…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search activity" />
      </div>
      <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Filter by person"><option value="">Everyone</option>{people.map((p) => <option key={p}>{p}</option>)}</select>
      <div className="seg" role="group" aria-label="Group activity by">
        <button type="button" className={mode === "week" ? "on" : ""} aria-pressed={mode === "week"} onClick={() => setMode("week")}>By week</button>
        <button type="button" className={mode === "month" ? "on" : ""} aria-pressed={mode === "month"} onClick={() => setMode("month")}>By month</button>
      </div>
    </div>
    <div className="activity-cats" role="group" aria-label="Filter by category">
      <button type="button" className={"activity-cat" + (!category ? " on" : "")} onClick={() => setCategory("")}>All <em>{events.length}</em></button>
      {CATEGORIES.filter((c) => counts[c.id]).map((c) => <button type="button" key={c.id} className={"activity-cat" + (category === c.id ? " on" : "")} style={{ "--cat": c.color }} onClick={() => setCategory(category === c.id ? "" : c.id)}><i />{c.label} <em>{counts[c.id]}</em></button>)}
    </div>

    {!groups.length && <div className="activity-empty"><b>{events.length ? "No activity matches these filters" : "No activity yet"}</b><span>{events.length ? "Try a different search or clear the filters." : "Changes to tickets, files and the team will appear here."}</span></div>}

    <div className="activity-groups">
      {groups.map((group, index) => {
        const open = isOpen(group, index);
        const byCat = CATEGORIES.map((c) => [c, group.events.filter((e) => e._cat === c.id).length]).filter(([, n]) => n);
        return <section key={group.key} className={"activity-group" + (open ? " open" : "")} style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}>
          <button type="button" className="activity-group-head" aria-expanded={open} onClick={() => toggle(group, index)}>
            <span className="activity-chevron" aria-hidden="true">›</span>
            <span className="activity-group-title"><b>{group.label}</b>{group.sub && <small>{group.sub}</small>}</span>
            <span className="activity-group-mix">{byCat.map(([c, n]) => <span key={c.id} style={{ "--cat": c.color }} title={`${n} ${c.label.toLowerCase()}`}><i />{n}</span>)}</span>
            <span className="activity-group-count">{group.events.length} {group.events.length === 1 ? "event" : "events"}</span>
          </button>
          {open && <ol className="activity-timeline">
            {group.events.map((a) => {
              const cat = CATEGORIES.find((c) => c.id === a._cat);
              return <li key={a._key} style={{ "--cat": cat.color }}>
                <span className="activity-dot" aria-hidden="true" />
                <div className="activity-item">
                  <div className="activity-item-head">
                    <span className="activity-avatar" aria-hidden="true">{initials(a.who)}</span>
                    <p><b>{a.who}</b> <span>{a.act}</span></p>
                    <span className="activity-tag">{cat.label}</span>
                    <time dateTime={a.at} title={a._date.toLocaleString("en-GB")}>{a._date.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })} · {a._date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  </div>
                  {Array.isArray(a.detail) ? a.detail.length > 0 && <div className="audit-diff">{a.detail.map((change, j) => <div className="audit-change" key={j}>
                    <b>{change.field}</b><span className="audit-value old"><small>Old</small>{change.old}</span><span className="audit-value new"><small>New</small>{change.new}</span>
                  </div>)}</div> : a.detail ? <p className="activity-detail">{a.detail}</p> : null}
                </div>
              </li>;
            })}
          </ol>}
        </section>;
      })}
    </div>

    <div className="tools"><span className="note">Showing {audit.length ? offset + 1 : 0}–{offset + audit.length} of {total} events{searching ? ` · ${filtered.length} match` : ""}</span>
      <button className="btn alt" disabled={!offset || loading} onClick={() => onPage(Math.max(0, offset - 100))}>Newer</button>
      <button className="btn alt" disabled={!hasMore || loading} onClick={() => onPage(offset + 100)}>{loading ? "Loading…" : "Older"}</button></div>
  </section>;
}
