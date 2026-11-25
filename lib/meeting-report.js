// Meeting-task bookkeeping shared by the server, the monthly email and the screens:
// - tasks still pending from earlier meetings, shown in each later meeting note ("previously assigned");
// - the monthly report: per team member, how much of the work they had that month they completed.
//
// A "row" is { task, note: { id, title, date, createdAt } } for one task of one meeting note.

const DAY = 864e5;

/** When the task was assigned: its own timestamp, or its meeting's date for older tasks. */
export const assignedAt = (row) => row.task.createdAt || `${row.note.date}T00:00:00.000Z`;

/** When the task was completed; older tasks without a timestamp count as completed when assigned. */
export const completedAt = (row) => row.task.status === "Completed" ? row.task.completedAt || assignedAt(row) : "";

/** A deadline as a time: a date-only deadline lasts to the end of that day (UTC). */
export const deadlineTime = (value) => {
  const text = String(value || "");
  if (!text) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T23:59:59Z`) : new Date(text);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
};

const noteBefore = (a, b) => a.date < b.date || (a.date === b.date && String(a.createdAt || "") < String(b.createdAt || ""));

/**
 * Tasks assigned in meetings before `note` that were still not completed when `note` was held, so they
 * carry over into it. A task keeps carrying over into every later meeting until it is completed.
 */
export function carriedOverTasks(rows, note) {
  const heldAt = note.createdAt || `${note.date}T23:59:59.999Z`;
  return rows
    .filter((row) => row.task.assigneeId && row.note.id !== note.id && noteBefore(row.note, note))
    .filter((row) => !completedAt(row) || completedAt(row) >= heldAt)
    .map((row) => ({ ...row.task, origin: { noteId: row.note.id, title: row.note.title, date: row.note.date }, pendingDays: Math.max(0, Math.floor((Date.now() - new Date(assignedAt(row)).getTime()) / DAY)) }))
    .sort((a, b) => a.origin.date.localeCompare(b.origin.date) || a.title.localeCompare(b.title));
}

/** First and last moment of a "YYYY-MM" month (UTC), as ISO strings. */
export function monthRange(month) {
  const [year, number] = month.split("-").map(Number);
  return { start: new Date(Date.UTC(year, number - 1, 1)).toISOString(), end: new Date(Date.UTC(year, number, 1) - 1).toISOString() };
}

/**
 * The month's task report. A member's tasks for the month are the ones assigned during it plus the ones
 * carried into it (assigned earlier, not completed before it began). Done = completed by month end.
 */
export function monthlyReport(rows, month, members = [], now = Date.now()) {
  const { start, end } = monthRange(month);
  const cutoff = Math.min(new Date(end).getTime(), now);
  const byMember = new Map();
  rows.forEach((row) => {
    const { task } = row;
    if (!task.assigneeId) return;
    const assigned = assignedAt(row);
    if (assigned > end) return;
    const completed = completedAt(row);
    if (completed && completed < start) return;
    const done = !!completed && completed <= end;
    const deadline = deadlineTime(task.dueDate);
    const entry = {
      id: task.id, title: task.title, priority: task.priority || "Medium", status: task.status || "Open", dueDate: task.dueDate || "",
      noteId: row.note.id, noteTitle: row.note.title, noteDate: row.note.date,
      done, carried: assigned < start, onTime: done && (deadline === null || new Date(completed).getTime() <= deadline),
      overdue: !done && deadline !== null && deadline < cutoff,
    };
    if (!byMember.has(task.assigneeId)) byMember.set(task.assigneeId, []);
    byMember.get(task.assigneeId).push(entry);
  });
  const percent = (part, whole) => whole ? Math.round((part / whole) * 100) : 0;
  const memberRows = [...byMember.entries()].map(([memberId, tasks]) => {
    const member = members.find((item) => item.id === memberId);
    const done = tasks.filter((task) => task.done).length;
    return {
      memberId, name: member?.name || "Former member", email: member?.email || "",
      total: tasks.length, done, notDone: tasks.length - done,
      percentDone: percent(done, tasks.length), percentNotDone: tasks.length ? 100 - percent(done, tasks.length) : 0,
      carried: tasks.filter((task) => task.carried).length,
      onTime: tasks.filter((task) => task.onTime).length,
      overdue: tasks.filter((task) => task.overdue).length,
      tasks: tasks.sort((a, b) => Number(a.done) - Number(b.done) || a.noteDate.localeCompare(b.noteDate)),
    };
  }).sort((a, b) => b.percentDone - a.percentDone || a.name.localeCompare(b.name));
  const total = memberRows.reduce((sum, row) => sum + row.total, 0), done = memberRows.reduce((sum, row) => sum + row.done, 0);
  return { month, members: memberRows, total, done, notDone: total - done, percentDone: percent(done, total), percentNotDone: total ? 100 - percent(done, total) : 0 };
}

/** Rows for every task of the given meeting notes. */
export const rowsOfNotes = (notes) => notes.flatMap((note) => (note.tasks || []).map((task) => ({ task, note: { id: note.id, title: note.title, date: note.date, createdAt: note.createdAt } })));
