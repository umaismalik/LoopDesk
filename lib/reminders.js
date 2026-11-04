import { loadDb, saveDb } from "./store";
import { sendEmail } from "./email";

const esc = (s) => String(s).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const deadlineTime = (value) => {
  const text = String(value || "");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T23:59:59Z`) : new Date(text);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
};
export async function check() {
  let d; try { d = await loadDb(() => null); } catch (e) { console.error("Reminder DB read failed:", e.message); return; }
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
}
export function startReminders() {
  const run = () => check().catch((e) => console.error("Deadline reminder check failed:", e.message));
  setTimeout(run, 30000); setInterval(run, 60 * 1000);
}
