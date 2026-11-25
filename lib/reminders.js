import { randomUUID } from "node:crypto";
import { acquireReminderLease, claimMonthlyReport, loadDb, loadMeetingTaskRows, loadReminderDb, loadReportTeams, releaseReminderLease, saveDb, sentMonthlyReports } from "./store";
import { deadlineTime as reportDeadline, monthlyReport, rowsOfNotes } from "./meeting-report";
import { sendEmail } from "./email";

const esc = (s) => String(s).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const deadlineTime = (value) => {
  const text = String(value || "");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T23:59:59Z`) : new Date(text);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
};
let checking = false;
export async function check() {
  if (checking) return;
  checking = true;
  const leaseToken = randomUUID();
  let leaseAcquired = false;
  try {
  leaseAcquired = await acquireReminderLease(leaseToken);
  if (!leaseAcquired) return;
  const d = await loadReminderDb();
  if (!d) return;
  const jobs = [], n = new Date(), today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  [...(d.projects || []).flatMap((p) => p.tickets || []), ...(d.tickets || [])].forEach((t) => {
    if (!t.deadline || t.status === "Completed" || !(t.assignees || []).length) return;
    const left = Math.round((new Date(t.deadline + "T00:00:00") - today) / 864e5);
    const ms = left < 0 ? "overdue" : [0, 1, 3].includes(left) ? String(left) : null;
    if (!ms || (t.rem || []).includes(ms)) return;
    const when = left < 0 ? "is overdue by " + -left + " day(s)" : left === 0 ? "is due today" : "has " + left + " day(s) left";
    (d.members || []).filter((m) => t.assignees.includes(m.id) && m.status !== "disabled").forEach((m) =>
      jobs.push({ ticket: t, reminder: ms, to: m.email, subject: "Deadline reminder: " + t.id,
        html: `<p>Hello ${esc(m.name)},</p><p>Your ticket <b>${t.id}</b> - ${esc(t.title)} ${when} (deadline: ${t.deadline}).</p><p>Please update its status in the portal${process.env.APP_URL ? ": " + process.env.APP_URL : ""}.</p>` }));
  });
  const good = new Map(), bad = new Map();
  for (const j of jobs) {
    const r = await sendEmail(j);
    if (!r.sent) console.error(`Deadline reminder failed for ${j.to} (${j.subject}): ${r.error}`);
    const m = r.sent ? good : bad;
    if (!m.has(j.ticket)) m.set(j.ticket, new Set());
    m.get(j.ticket).add(j.reminder);
  }
  let changed = false;
  good.forEach((set, t) => set.forEach((rem) => {
    if (!(bad.get(t) || new Set()).has(rem) && !(t.rem || []).includes(rem)) { t.rem = [...(t.rem || []), rem]; changed = true; }
  }));
  const now = Date.now(), windowMs = 60 * 60 * 1000, minuteWindowMs = 60 * 1000, reminderJobs = [];
  (d.meetingNotes || []).forEach((note) => (note.tasks || []).forEach((task) => {
    if (!task.dueDate || task.status === "Completed" || !task.assigneeId) return;
    const due = deadlineTime(task.dueDate);
    if (due === null) return;
    const remaining = due - now;
    const sent = new Set(task.remindersSent || []);
    const project = (d.projects || []).find((item) => item.id === note.projectId);
    const member = (d.members || []).find((item) => item.id === task.assigneeId && item.status !== "disabled" &&
      (!project || (project.members || []).some((entry) => entry.memberId === item.id && entry.status !== "disabled")));
    if (!member) return;
    [
      { minutes: 24 * 60, marker: "24h", label: "24-hour", window: windowMs },
      { minutes: 12 * 60, marker: "12h", label: "12-hour", window: windowMs },
      { minutes: 2 * 60, marker: "2h", label: "2-hour", window: windowMs },
      { minutes: 5, marker: "5m", label: "5-minute", window: minuteWindowMs },
    ].forEach(({ minutes, marker, label, window }) => {
      const target = minutes * 60 * 1000;
      if (remaining <= target && remaining > target - window && !sent.has(marker)) {
        reminderJobs.push({ note, task, marker, member, label, due });
      }
    });
  }));
  for (const job of reminderJobs) {
    const dueLabel = new Date(job.due).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
    const result = await sendEmail({
      to: job.member.email,
      subject: `${job.label} deadline reminder: ${job.task.title}`,
      html: `<p>Hello ${esc(job.member.name)},</p><p>Your <b>${esc(job.task.priority || "Medium")}</b>-priority action item from <b>${esc(job.note.title)}</b> is due in approximately ${job.label === "5-minute" ? "5 minutes" : job.label.replace("-", " ")}.</p><p><b>Task:</b> ${esc(job.task.title)}<br><b>Deadline:</b> ${esc(dueLabel)}</p><p>Please update its status in the portal${process.env.APP_URL ? `: ${esc(process.env.APP_URL)}` : ""}.</p>`,
    });
    if (!result.sent) {
      console.error(`Meeting task reminder failed for ${job.member.email} (${job.task.title}, ${job.marker}): ${result.error}`);
      continue;
    }
    job.task.remindersSent = [...new Set([...(job.task.remindersSent || []), job.marker])];
    changed = true;
  }
  if (changed) await saveDb(d);
  await sendMonthlyReports().catch((error) => console.error("Monthly task report failed:", error?.message || error));
  } finally {
    try {
      if (leaseAcquired) await releaseReminderLease(leaseToken);
    } finally {
      checking = false;
    }
  }
}
export function startReminders() {
  const run = () => check().catch((e) => console.error("Deadline reminder check failed:", e.message));
  setTimeout(run, 30000); setInterval(run, 60 * 1000);
}

// ---------------------------------------------------------------- monthly task report
// On the 1st of each month (from 9:00 in REPORT_TIMEZONE, default Pakistan time; days 2-7 catch up if
// the 1st was missed) every team member is emailed their own report for the previous month and each
// project admin the whole team's. Each project's report is sent once (recorded in the database).
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || "Asia/Karachi";
const REPORT_HOUR = 9;
const PROJECTS_PER_RUN = 3;
let monthlyReportsDone = "";
const localClock = (time) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
  .formatToParts(time).map((part) => [part.type, part.value]));
const monthName = (month) => { const [year, number] = month.split("-").map(Number); return new Date(Date.UTC(year, number - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }); };
const deadlineText = (value) => {
  const time = reportDeadline(value);
  return time === null ? "No deadline" : new Date(time).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: REPORT_TIMEZONE });
};
const cell = "padding:8px 10px;border-bottom:1px solid #e5e8f0;text-align:left;font-size:13px";
const bar = (percent) => `<div style="background:#e5e8f0;border-radius:6px;height:8px;width:120px"><div style="background:${percent >= 75 ? "#16a34a" : percent >= 50 ? "#d97706" : "#dc2626"};height:8px;border-radius:6px;width:${Math.max(0, Math.min(100, percent)) * 1.2}px"></div></div>`;
const portalLink = () => process.env.APP_URL ? `<p><a href="${esc(process.env.APP_URL)}" style="display:inline-block;padding:9px 16px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Open Meeting Notes</a></p>` : "";

function memberReportEmail(row, month, projectName) {
  const pending = row.tasks.filter((task) => !task.done);
  return {
    subject: `Your task report for ${monthName(month)}: ${row.percentDone}% completed`,
    html: `<p>Hello ${esc(row.name)},</p>
<p>Here is your meeting task report for <b>${esc(monthName(month))}</b> in <b>${esc(projectName)}</b>.</p>
<table role="presentation" style="border-collapse:collapse;margin:0 0 14px">
<tr><td style="${cell}">Tasks this month</td><td style="${cell}"><b>${row.total}</b>${row.carried ? ` (${row.carried} carried over from earlier meetings)` : ""}</td></tr>
<tr><td style="${cell}">Completed</td><td style="${cell}"><b>${row.done}</b> · ${row.percentDone}%</td></tr>
<tr><td style="${cell}">Not completed</td><td style="${cell}"><b>${row.notDone}</b> · ${row.percentNotDone}%</td></tr>
<tr><td style="${cell}">Completed on time</td><td style="${cell}">${row.onTime}</td></tr>
<tr><td style="${cell}">Overdue at month end</td><td style="${cell}">${row.overdue}</td></tr>
</table>
${pending.length ? `<p style="margin:0 0 6px"><b>Not completed</b> (these carry over to your next meeting):</p>
<table role="presentation" style="border-collapse:collapse;width:100%;margin:0 0 14px"><tr><th style="${cell}">Task</th><th style="${cell}">Assigned in</th><th style="${cell}">Deadline</th></tr>
${pending.map((task) => `<tr><td style="${cell}">${esc(task.title)}</td><td style="${cell}">${esc(task.noteTitle)} (${esc(task.noteDate)})</td><td style="${cell}">${esc(deadlineText(task.dueDate))}</td></tr>`).join("")}</table>` : "<p>Every task was completed. Well done!</p>"}
${portalLink()}`,
  };
}

function teamReportEmail(admin, report, projectName) {
  return {
    subject: `Team task report for ${monthName(report.month)} (${projectName}): ${report.percentDone}% completed`,
    html: `<p>Hello ${esc(admin.name)},</p>
<p>Meeting task report for <b>${esc(projectName)}</b>, <b>${esc(monthName(report.month))}</b>: ${report.done} of ${report.total} tasks completed (<b>${report.percentDone}%</b>), ${report.notDone} not completed (${report.percentNotDone}%).</p>
<table role="presentation" style="border-collapse:collapse;width:100%;margin:0 0 14px">
<tr><th style="${cell}">Team member</th><th style="${cell}">Tasks</th><th style="${cell}">Completed</th><th style="${cell}">Not completed</th><th style="${cell}">Overdue</th><th style="${cell}"></th></tr>
${report.members.map((row) => `<tr><td style="${cell}"><b>${esc(row.name)}</b>${row.carried ? `<br><span style="color:#64748b;font-size:12px">${row.carried} carried over</span>` : ""}</td><td style="${cell}">${row.total}</td><td style="${cell}">${row.done} · <b>${row.percentDone}%</b></td><td style="${cell}">${row.notDone} · ${row.percentNotDone}%</td><td style="${cell}">${row.overdue}</td><td style="${cell}">${bar(row.percentDone)}</td></tr>`).join("")}
</table>
${portalLink()}`,
  };
}

export async function sendMonthlyReports(now = process.env.MONTHLY_REPORT_TEST_NOW ? new Date(process.env.MONTHLY_REPORT_TEST_NOW) : new Date()) {
  const clock = localClock(now);
  const day = Number(clock.day);
  if (day > 7 || (day === 1 && Number(clock.hour) < REPORT_HOUR)) return;
  const previous = new Date(Date.UTC(Number(clock.year), Number(clock.month) - 2, 1));
  const month = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
  if (monthlyReportsDone === month) return;
  const sent = new Set(await sentMonthlyReports(`monthly-report:${month}:`));
  const teams = (await loadReportTeams()).filter((team) => !sent.has(`monthly-report:${month}:${team.id}`));
  let localNotes = null, sentThisRun = 0;
  for (const team of teams) {
    if (sentThisRun >= PROJECTS_PER_RUN) return; // the rest go out on the next run, a minute later
    let rows = await loadMeetingTaskRows(team.id, `${month}-31`);
    if (!rows) {
      localNotes = localNotes || (await loadDb(() => null))?.meetingNotes || [];
      rows = rowsOfNotes(localNotes.filter((note) => note.projectId === team.id && note.date <= `${month}-31`));
    }
    const report = monthlyReport(rows, month, team.members, now.getTime());
    if (!(await claimMonthlyReport(`monthly-report:${month}:${team.id}`)) || !report.total) continue;
    sentThisRun += 1;
    const active = (id) => team.members.find((member) => member.id === id && member.status === "active" && member.email);
    const jobs = [
      ...report.members.filter((row) => active(row.memberId)).map((row) => ({ to: active(row.memberId).email, ...memberReportEmail(row, month, team.name) })),
      ...team.members.filter((member) => member.role === "Admin" && member.status === "active" && member.email).map((admin) => ({ to: admin.email, ...teamReportEmail(admin, report, team.name) })),
    ];
    for (const job of jobs) {
      const result = await sendEmail(job);
      if (!result.sent) console.error(`Monthly task report failed for ${job.to} (${team.name}): ${result.error}`);
    }
  }
  monthlyReportsDone = month;
}
