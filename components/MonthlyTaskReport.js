"use client";

import { useEffect, useState } from "react";

const currentMonth = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
const shiftMonth = (value, delta) => {
  const [year, number] = value.split("-").map(Number);
  const date = new Date(year, number - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
const monthTitle = (value) => new Date(`${value}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
const initials = (name) => String(name || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
const tone = (percent) => percent >= 75 ? "good" : percent >= 50 ? "mid" : "low";

/**
 * Per team member: how many of the month's meeting tasks (assigned that month, or carried over from
 * earlier meetings) they completed. `month` makes it follow another month picker; otherwise it has its own.
 */
export default function MonthlyTaskReport({ projectId, keyValue, month: controlledMonth, refreshKey, title = "Monthly task report" }) {
  const [ownMonth, setOwnMonth] = useState(currentMonth);
  const month = controlledMonth || ownMonth;
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    fetch(`/api/meeting-notes?report=${encodeURIComponent(month)}&project=${encodeURIComponent(projectId)}`, { headers: { "x-key": keyValue } })
      .then(async (response) => ({ ok: response.ok, ...(await response.json().catch(() => ({}))) }))
      .then((result) => { if (!active) return; if (!result.ok) setError(result.error || "Could not load the report"); else setReport(result.report); })
      .catch(() => active && setError("Could not load the report"));
    return () => { active = false; };
  }, [month, projectId, keyValue, refreshKey]);
  const thisMonth = month === currentMonth();
  return <section className="mtr" aria-label={title}>
    <header className="mtr-head">
      <div><b>{title}</b><span>{thisMonth ? "So far this month. " : ""}Tasks assigned in the month plus those carried over from earlier meetings. Emailed to each member and the admins on the 1st of every month.</span></div>
      {!controlledMonth && <div className="mtr-month" role="group" aria-label="Report month">
        <button type="button" aria-label="Previous month" onClick={() => setOwnMonth(shiftMonth(month, -1))}>‹</button>
        <b>{monthTitle(month)}</b>
        <button type="button" aria-label="Next month" disabled={thisMonth} onClick={() => setOwnMonth(shiftMonth(month, 1))}>›</button>
      </div>}
    </header>
    {error && <p className="mtr-empty">{error}</p>}
    {!error && !report && <p className="mtr-empty">Loading…</p>}
    {report && !report.total && <p className="mtr-empty">No meeting tasks were assigned for {monthTitle(month)}.</p>}
    {report && !!report.total && <>
      <div className="mtr-summary">
        <div className={"mtr-big " + tone(report.percentDone)}><b>{report.percentDone}%</b><span>completed</span></div>
        <div><b>{report.done}</b><span>of {report.total} tasks done</span></div>
        <div><b>{report.notDone}</b><span>not completed · {report.percentNotDone}%</span></div>
        <div><b>{report.members.length}</b><span>team member{report.members.length === 1 ? "" : "s"}</span></div>
      </div>
      <ul className="mtr-list">
        {report.members.map((row) => <li key={row.memberId} className={open === row.memberId ? "open" : ""}>
          <button type="button" className="mtr-row" aria-expanded={open === row.memberId} onClick={() => setOpen(open === row.memberId ? "" : row.memberId)}>
            <i>{initials(row.name)}</i>
            <span className="mtr-name"><b>{row.name}</b><small>{row.total} task{row.total === 1 ? "" : "s"}{row.carried ? ` · ${row.carried} carried over` : ""}{row.overdue ? ` · ${row.overdue} overdue` : ""}</small></span>
            <span className={"mtr-bar " + tone(row.percentDone)} aria-hidden="true"><i style={{ width: `${row.percentDone}%` }} /></span>
            <span className="mtr-pct"><b>{row.percentDone}%</b> done<small>{row.percentNotDone}% not done</small></span>
          </button>
          {open === row.memberId && <ol className="mtr-tasks">
            {row.tasks.map((task) => <li key={task.id + task.noteId} className={task.done ? "done" : task.overdue ? "overdue" : ""}>
              <span>{task.done ? "✓" : "•"}</span>
              <b>{task.title}</b>
              <small>{task.noteTitle} · {task.noteDate}{task.carried ? " · carried over" : ""}{task.done ? task.onTime ? " · on time" : " · late" : task.overdue ? " · overdue" : ` · ${task.status}`}</small>
            </li>)}
          </ol>}
        </li>)}
      </ul>
    </>}
  </section>;
}
