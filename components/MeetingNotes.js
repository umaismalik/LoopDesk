"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MonthlyTaskReport from "./MonthlyTaskReport";

const currentMonth = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
const dateLabel = (value) => value ? new Date(value + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-";
const localDateTime = (value) => {
  if (!value) return "";
  const date = new Date(value.length === 10 ? `${value}T23:59:00` : value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const shiftMonth = (value, delta) => {
  const [year, monthNumber] = value.split("-").map(Number);
  const d = new Date(year, monthNumber - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const monthTitle = (value) => new Date(`${value}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
const initials = (name) => String(name || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
const AVATAR_COLORS = ["#4f46e5", "#0f9f8f", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d"];
const avatarColor = (id) => AVATAR_COLORS[[...String(id || "")].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_COLORS.length];
const isOverdue = (task) => task.dueDate && task.status !== "Completed" && new Date(task.dueDate).getTime() < Date.now();
const dueLabel = (value) => {
  if (!value) return "No deadline";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "No deadline";
};
const csvCell = (value) => {
  let text = String(value ?? "");
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
};

const Icon = ({ d, size = 16 }) => <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const CHEVRON = "M6 9l6 6 6-6";
const EDIT = "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z";
const CONTEXT = "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2zM8 9h8M8 13h5";
const toggled = (set, id) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; };

/**
 * `openTarget` ({ note, month, task }) opens one meeting note on one task, as linked from a task
 * assignment email; `onTargetOpened` is called once it is shown.
 */
export default function MeetingNotes({ projectId, keyValue, members, canDelete, canManageContent, me, onAccessChange, refreshKey, openTarget, onTargetOpened }) {
  const [month, setMonth] = useState(currentMonth);
  const [reportPeriod, setReportPeriod] = useState("month");
  const [reportWeek, setReportWeek] = useState(() => new Date().toISOString().slice(0, 10));
  const [reportMember, setReportMember] = useState("");
  const [notes, setNotes] = useState([]);
  const [notesOffset, setNotesOffset] = useState(0);
  const [notesTotal, setNotesTotal] = useState(0);
  const [notesHasMore, setNotesHasMore] = useState(false);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesMonth, setNotesMonth] = useState("");
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [taskDeadline, setTaskDeadline] = useState("");
  const [taskPriority, setTaskPriority] = useState("Medium");
  const [commentDrafts, setCommentDrafts] = useState({});
  const [recordingUrls, setRecordingUrls] = useState([]);
  const [editAccess, setEditAccess] = useState(!!canManageContent);
  const [editAccessExpiresAt, setEditAccessExpiresAt] = useState(null);
  const [accessRequests, setAccessRequests] = useState([]);
  const [tab, setTab] = useState("overview");
  const [search, setSearch] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  // Which member cards and action-item groups are expanded, and which task panel (edit / context) is open.
  const [openMembers, setOpenMembers] = useState(() => new Set());
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const [taskPanels, setTaskPanels] = useState({});
  const [highlightTask, setHighlightTask] = useState("");
  // Tasks from earlier meetings still not completed when the open note's meeting was held.
  const [carried, setCarried] = useState([]);
  const [carriedVersion, setCarriedVersion] = useState(0);
  const [localTarget, setLocalTarget] = useState(null);
  const [monthlyOpen, setMonthlyOpen] = useState(false);
  const target = openTarget || localTarget;
  // The note as last loaded from the server; a live refresh only replaces the open note when the
  // user has not started editing it.
  const baselineRef = useRef("");
  const openNote = (note) => {
    baselineRef.current = note ? JSON.stringify(note) : "";
    setSelected(note);
    setOpenMembers(new Set()); setOpenGroups(new Set()); setTaskPanels({}); setHighlightTask("");
  };
  const toggleTaskPanel = (taskId, panel) => setTaskPanels((panels) => ({ ...panels, [taskId]: panels[taskId] === panel ? "" : panel }));

  const request = useCallback(async (body, offset = 0) => {
    try {
      const response = await fetch("/api/meeting-notes?month=" + encodeURIComponent(month) + "&offset=" + offset + "&limit=50&project=" + encodeURIComponent(projectId), {
        method: body ? "POST" : "GET",
        headers: { "x-key": keyValue, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
        body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
      });
      const result = await response.json();
      return { ...result, ok: response.ok };
    } catch (requestError) {
      return { ok: false, error: requestError instanceof Error ? requestError.message : "Unable to reach the server" };
    }
  }, [projectId, keyValue, month]);

  useEffect(() => {
    let active = true;
    setError("");
    setNotesLoading(true);
    request(null, notesOffset).then((result) => {
      if (!active) return;
      if (!result.ok) { setError(result.error || "Could not load notes"); return; }
      setNotes(result.notes || []);
      setNotesMonth(month);
      setNotesOffset(result.pagination?.offset || 0);
      setNotesTotal(result.pagination?.total ?? result.notes.length);
      setNotesHasMore(!!result.pagination?.hasMore);
      const canEdit = !!result.canEdit || !!canManageContent;
      setEditAccess(canEdit);
      setEditAccessExpiresAt(result.expiresAt || null);
      onAccessChange?.(canEdit, result.expiresAt || null, result.requests || []);
      setAccessRequests(result.requests || []);
      setSelected((previous) => {
        if (!previous) return null;
        const fresh = (result.notes || []).find((note) => note.id === previous.id);
        if (!fresh) return null;
        if (JSON.stringify(previous) !== baselineRef.current) return previous;
        baselineRef.current = JSON.stringify(fresh);
        return fresh;
      });
    }).finally(() => { if (active) setNotesLoading(false); });
    return () => { active = false; };
  }, [request, canManageContent, onAccessChange, notesOffset, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const refreshAccessState = async () => {
    const result = await request();
    if (!result.ok) { setError(result.error || "Could not refresh meeting access"); return; }
    const canEdit = !!result.canEdit || !!canManageContent;
    setEditAccess(canEdit);
    setEditAccessExpiresAt(result.expiresAt || null);
    setAccessRequests(result.requests || []);
    onAccessChange?.(canEdit, result.expiresAt || null, result.requests || []);
  };
  const requestEditAccess = async () => {
    setBusy(true); setError(""); setNotice("");
    const result = await request({ action: "request-edit-access" });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not request edit access"); return; }
    if (result.canEdit) setEditAccess(true);
    await refreshAccessState();
    setNotice(result.canEdit
      ? "Your one-hour edit access is active."
      : `Request sent to a project admin. Approval lasts one hour. Admin email notifications sent: ${result.adminNotificationsSent || 0}${result.adminNotificationsFailed ? `; email failed: ${result.emailErrors?.[0] || "check server email settings"}` : ""}. Pending requests also appear on the dashboard.`);
  };
  const reviewEditAccess = async (requestId, decision) => {
    setBusy(true); setError(""); setNotice("");
    const result = await request({ action: "review-edit-access", requestId, decision });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not review access request"); return; }
    await refreshAccessState();
    setNotice(decision === "approve" ? `${result.request.memberName}'s edit access is approved for one hour.` : "Temporary edit request denied.");
  };
  useEffect(() => {
    let active = true;
    const urls = [];
    setRecordingUrls([]);
    const clipCount = selected?.audioFiles?.length || (selected?.audioFile ? 1 : 0);
    if (selected && clipCount) {
      Promise.all(Array.from({ length: clipCount }, async (_, clip) => {
        const response = await fetch("/api/meeting-recording?id=" + encodeURIComponent(selected.id) + "&clip=" + clip + "&project=" + encodeURIComponent(projectId), { headers: { "x-key": keyValue } });
        if (!response.ok) throw new Error("Could not load saved recording clip " + (clip + 1));
        return URL.createObjectURL(await response.blob());
      })).then((loadedUrls) => {
        if (!active) {
          loadedUrls.forEach((url) => URL.revokeObjectURL(url));
          return;
        }
        urls.push(...loadedUrls);
        setRecordingUrls(loadedUrls);
      }).catch((loadError) => { if (active) setError(loadError.message || "Could not load saved recording"); });
    }
    return () => { active = false; urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [selected?.id, selected?.audioFile?.id, selected?.audioFiles?.length, projectId, keyValue]);

  useEffect(() => {
    if (target?.month && /^\d{4}-\d{2}$/.test(target.month) && target.month !== month) { setMonth(target.month); setNotesOffset(0); }
  }, [target?.month]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Wait until the notes of the task's month are loaded.
    if (!target?.note || notesLoading || notesMonth !== (target.month || month)) return;
    const done = () => { if (openTarget) onTargetOpened?.(); else setLocalTarget(null); };
    const note = notes.find((item) => item.id === target.note);
    if (!note) { setError("That task is no longer in Meeting Notes, or it belongs to another project."); done(); return; }
    openNote(note);
    setTab("tasks");
    const task = (note.tasks || []).find((item) => item.id === target.task);
    if (task) {
      setOpenGroups(new Set([task.assigneeId || "unassigned"]));
      setHighlightTask(task.id);
      setTimeout(() => document.getElementById("mn-task-" + task.id)?.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
    }
    done();
  }, [target, notes, notesLoading, notesMonth, month]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let active = true;
    setCarried([]);
    if (!selected?.id) return undefined;
    fetch(`/api/meeting-notes?carried=${encodeURIComponent(selected.id)}&date=${encodeURIComponent(selected.date)}&at=${encodeURIComponent(selected.createdAt || "")}&project=${encodeURIComponent(projectId)}`, { headers: { "x-key": keyValue } })
      .then((response) => response.ok ? response.json() : { tasks: [] })
      .then((result) => { if (active) setCarried(result.tasks || []); })
      .catch(() => {});
    return () => { active = false; };
  }, [selected?.id, selected?.date, selected?.createdAt, projectId, keyValue, refreshKey, carriedVersion]);
  const carriedPending = carried.filter((task) => task.status !== "Completed");
  const carriedByMember = (() => {
    const groups = new Map();
    carriedPending.forEach((task) => groups.set(task.assigneeId, [...(groups.get(task.assigneeId) || []), task]));
    return [...groups.entries()].map(([memberId, tasks]) => ({ memberId, tasks }));
  })();
  const updateCarriedStatus = async (task, status) => {
    setBusy(true); setError("");
    const result = await request({ action: "task-status", noteId: task.origin.noteId, taskId: task.id, status });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not update task status"); return; }
    setNotes((items) => items.map((item) => item.id === result.note.id ? result.note : item));
    setCarriedVersion((version) => version + 1);
    setNotice(status === "Completed" ? `"${task.title}" is completed.` : `"${task.title}" is now ${status}.`);
  };
  const openOriginal = (task) => setLocalTarget({ note: task.origin.noteId, month: task.origin.date.slice(0, 7), task: task.id });

  const save = async () => {
    if (!selected) return;
    if (!editAccess) return saveOwnTasks();
    setBusy(true); setError(""); setNotice("");
    const result = await request({ action: "update", noteId: selected.id, title: selected.title, summary: selected.summary, transcript: selected.transcript, participantSummaries: selected.participantSummaries, tasks: selected.tasks });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not save note"); return; }
    openNote(result.note);
    setNotes((items) => items.map((item) => item.id === result.note.id ? result.note : item));
    setNotice(result.taskEmailsFailed ? `Saved, but ${result.taskEmailsFailed} task assignment email(s) failed: ${result.emailErrors?.[0] || "check email settings"}` : `Note and tasks saved.${result.taskEmailsSent ? ` Assignment notification sent to ${result.taskEmailsSent} team member(s).` : ""}`);
  };

  // A member's own tasks: added by them for themselves, editable (or removable) for 24 hours after adding.
  const OWN_TASK_EDIT_MS = 24 * 60 * 60 * 1000;
  const ownTaskEditUntil = (task) => task?.createdBy && task.createdBy === me?.id && task.assigneeId === me?.id ? new Date(task.createdAt || 0).getTime() + OWN_TASK_EDIT_MS : 0;
  const ownTaskEditable = (task) => ownTaskEditUntil(task) > Date.now();
  const applyNote = (note) => { openNote(note); setNotes((items) => items.map((item) => item.id === note.id ? note : item)); };
  const saveOwnTasks = async () => {
    const before = JSON.parse(baselineRef.current || "{}").tasks || [];
    const changed = (selected.tasks || []).filter((task) => ownTaskEditable(task) && JSON.stringify(task) !== JSON.stringify(before.find((item) => item.id === task.id)));
    if (!changed.length) return;
    setBusy(true); setError(""); setNotice("");
    let result = null;
    for (const task of changed) {
      result = await request({ action: "own-task-edit", noteId: selected.id, taskId: task.id, title: task.title, description: task.description, priority: task.priority, status: task.status, dueDate: task.dueDate });
      if (!result.ok) break;
    }
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not save your task"); return; }
    applyNote(result.note);
    setNotice(changed.length === 1 ? "Your task was saved." : "Your tasks were saved.");
  };
  const addOwnTask = async (event) => {
    event.preventDefault();
    if (!selected || !taskTitle.trim()) return;
    setBusy(true); setError(""); setNotice("");
    const result = await request({ action: "own-task-add", noteId: selected.id, title: taskTitle.trim(), priority: taskPriority, dueDate: taskDeadline ? new Date(taskDeadline).toISOString() : "" });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not add your task"); return; }
    applyNote(result.note);
    setTaskTitle(""); setTaskDeadline(""); setTaskPriority("Medium"); setTab("tasks");
    setNotice("Task added. You can edit it for the next 24 hours; after that you can update its status.");
  };
  const removeOwnTask = async (task) => {
    if (!selected || !window.confirm(`Remove "${task.title}"?`)) return;
    setBusy(true); setError(""); setNotice("");
    const result = await request({ action: "own-task-remove", noteId: selected.id, taskId: task.id });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not remove the task"); return; }
    applyNote(result.note);
    setNotice("Task removed.");
  };

  // Saves new action items on the open note (with any unsaved edits); assignees are emailed by the server.
  const createTasks = async (tasks) => {
    if (!selected || !editAccess || !tasks.length) return false;
    const updated = { ...selected, tasks: [...(selected.tasks || []), ...tasks] };
    setBusy(true); setError(""); setNotice("");
    const result = await request({ action: "update", noteId: updated.id, title: updated.title, summary: updated.summary, transcript: updated.transcript, participantSummaries: updated.participantSummaries, tasks: updated.tasks });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not add task"); return false; }
    openNote(result.note); setNotes((items) => items.map((item) => item.id === result.note.id ? result.note : item));
    const what = tasks.length === 1 ? "Task" : `${tasks.length} tasks`;
    if (result.taskEmailsFailed) setError(`${what} saved, but assignment email failed: ${result.emailErrors?.[0] || "check email settings"}`);
    else setNotice(`${what} assigned${result.taskEmailsSent ? ` and emailed to ${result.taskEmailsSent} team member(s)` : ""}.`);
    return true;
  };
  const newTask = (title, assigneeId, extra = {}) => ({ id: crypto.randomUUID(), title, description: selected?.summary || "", assigneeId, dueDate: "", status: "Open", priority: "Medium", comments: [], ...extra });
  const addTask = async (event) => {
    event.preventDefault();
    if (!taskTitle.trim()) return;
    const saved = await createTasks([newTask(taskTitle.trim(), taskAssignee, { dueDate: taskDeadline ? new Date(taskDeadline).toISOString() : "", priority: taskPriority })]);
    if (saved) { setTaskTitle(""); setTaskAssignee(""); setTaskDeadline(""); setTaskPriority("Medium"); }
  };
  // A member card's "Next tasks" lines that are not yet action items assigned to that member.
  const unassignedNextTasks = (card) => (card.tasks || []).map((line) => String(line).trim()).filter(Boolean)
    .filter((line) => !(selected?.tasks || []).some((task) => task.assigneeId === card.memberId && task.title.trim() === line));
  const assignNextTasks = (card) => createTasks(unassignedNextTasks(card).map((line) => newTask(line.slice(0, 300), card.memberId, { priority: card.priority || "Medium", description: card.description || selected?.summary || "" })));
  const taskFormRef = useRef(null);

  const addComment = async (task) => {
    const text = (commentDrafts[task.id] || "").trim();
    if (!text || !selected || !editAccess) return;
    setBusy(true); setError("");
    const result = await request({ action: "comment", noteId: selected.id, taskId: task.id, text });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not add comment"); return; }
    openNote(result.note); setNotes((items) => items.map((item) => item.id === result.note.id ? result.note : item));
    setCommentDrafts((drafts) => ({ ...drafts, [task.id]: "" }));
  };
  const deleteNote = async () => {
    if (!selected || !canDelete || !window.confirm("Delete this meeting note and its saved recording?")) return;
    setBusy(true); setError("");
    const result = await request({ action: "delete", noteId: selected.id });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not delete note"); return; }
    setNotes((items) => items.filter((item) => item.id !== selected.id));
    setSelected(null); setRecordingUrls([]); setNotice("Meeting note deleted.");
  };
  const updateTaskStatus = async (task, status) => {
    if (!selected) return;
    setBusy(true); setError("");
    const result = await request({ action: "task-status", noteId: selected.id, taskId: task.id, status });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not update task status"); return; }
    openNote(result.note);
    setNotes((items) => items.map((item) => item.id === result.note.id ? result.note : item));
  };
  const exportReport = async () => {
    setError(""); setNotice("");
    let from, to;
    if (reportPeriod === "month") {
      from = `${month}-01`;
      const [year, monthNumber] = month.split("-").map(Number);
      to = `${month}-${String(new Date(year, monthNumber, 0).getDate()).padStart(2, "0")}`;
    } else {
      const start = new Date(`${reportWeek}T12:00:00`);
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      const end = new Date(start); end.setDate(start.getDate() + 6);
      from = [start.getFullYear(), String(start.getMonth() + 1).padStart(2, "0"), String(start.getDate()).padStart(2, "0")].join("-");
      to = [end.getFullYear(), String(end.getMonth() + 1).padStart(2, "0"), String(end.getDate()).padStart(2, "0")].join("-");
    }
    try {
      const reportNotes = [];
      let offset = 0, hasMore = true;
      while (hasMore) {
        const response = await fetch(`/api/meeting-notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&offset=${offset}&limit=50&project=${encodeURIComponent(projectId)}`, { headers: { "x-key": keyValue } });
        const result = await response.json();
        if (!response.ok) { setError(result.error || "Could not create report"); return; }
        reportNotes.push(...(result.notes || []));
        hasMore = !!result.pagination?.hasMore;
        offset += result.pagination?.limit || 50;
      }
      const rows = [];
      reportNotes.forEach((note) => {
        const noteTasks = note.tasks || [];
        const cards = note.participantSummaries || [];
        const reportCards = cards.filter((card) => !reportMember || card.memberId === reportMember);
        const memberUpdates = new Map(reportCards.map((card) => [card.memberId, card]));
        const filteredTasks = noteTasks.filter((task) => !reportMember || task.assigneeId === reportMember);
        if (!filteredTasks.length) {
          if (reportCards.length) {
            reportCards.forEach((card) => rows.push([
              note.date, note.title, card.name, members.find((item) => item.id === card.memberId)?.email || "",
              (card.points || []).join(" | "), "", card.description || "", note.summary || "",
              card.priority || "", "", "",
            ]));
          } else if (!reportMember) rows.push([note.date, note.title, "", "", "", "", "", note.summary || "", "", "", ""]);
          return;
        }
        filteredTasks.forEach((task) => {
          const member = members.find((item) => item.id === task.assigneeId);
          const card = memberUpdates.get(task.assigneeId) || cards.find((item) => item.memberId === task.assigneeId);
          const previousUpdates = (card?.points || []).join(" | ");
          const legacyDescriptionLines = new Set([
            ...String(note.summary || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
            ...(card?.points || []).map((line) => String(line).trim()).filter(Boolean),
          ]);
          const taskDescription = card?.description || String(task.description || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !legacyDescriptionLines.has(line)).join(" | ");
          rows.push([
            note.date, note.title, member?.name || card?.name || "", member?.email || "",
            previousUpdates, task.title, taskDescription, note.summary || "",
            task.priority || card?.priority || "Medium", task.status || "Open", task.dueDate || "",
          ]);
        });
      });
      const headers = ["Meeting date", "Meeting", "Team member", "Email", "Previous task update", "Upcoming task", "Task description / context", "Meeting notes", "Priority", "Status", "Deadline"];
      const content = "\uFEFF" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = `meeting-tasks-${from}-to-${to}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`${rows.length} report row(s) exported. Open the CSV file in Excel.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not create report");
    }
  };
  const taskGroups = selected ? (() => {
    const groups = new Map();
    (selected.tasks || []).forEach((task) => {
      const member = members.find((item) => item.id === task.assigneeId);
      const key = member?.id || "unassigned";
      if (!groups.has(key)) groups.set(key, { id: key, name: member?.name || "Unassigned", tasks: [] });
      groups.get(key).tasks.push(task);
    });
    return [...groups.values()];
  })() : [];
  const canEditMember = (memberId) => !!canManageContent || (editAccess && memberId === me?.id);
  const canEditTask = (task) => !!canManageContent || ownTaskEditable(task) || (editAccess && task.assigneeId === me?.id && !(task.createdBy === me?.id && !ownTaskEditable(task)));
  const hasOwnEditable = !!selected?.tasks?.some(ownTaskEditable);
  const myAccessRequest = accessRequests.find((item) => item.memberId === me?.id && item.projectId === projectId && item.status === "pending");
  const pendingAccessRequests = accessRequests.filter((item) => item.status === "pending");

  const allTasks = notes.flatMap((note) => note.tasks || []);
  const stats = {
    notes: notesTotal || notes.length,
    tasks: allTasks.length,
    done: allTasks.filter((task) => task.status === "Completed").length,
    open: allTasks.filter((task) => task.status !== "Completed").length,
    overdue: allTasks.filter(isOverdue).length,
  };
  const q = search.trim().toLowerCase();
  const visibleNotes = q ? notes.filter((note) => `${note.title} ${note.summary || ""} ${note.createdByName || ""} ${(note.tasks || []).map((task) => task.title).join(" ")}`.toLowerCase().includes(q)) : notes;
  const selectedTasks = selected?.tasks || [];
  const selectedDone = selectedTasks.filter((task) => task.status === "Completed").length;
  const memberOf = (id) => members.find((item) => item.id === id);
  const changeMonth = (next) => { setMonth(next); setNotesOffset(0); openNote(null); };

  return <section className="mn">
    <header className="mn-hero">
      <div className="mn-hero-text">
        <span className="mn-eyebrow">MEETING NOTES</span>
        <h2>Decisions & action items</h2>
        <p>Every meeting's key points, member updates and assigned tasks — in one place.</p>
      </div>
      <div className="mn-month" role="group" aria-label="Choose month">
        <button type="button" aria-label="Previous month" onClick={() => changeMonth(shiftMonth(month, -1))}>‹</button>
        <label><b>{monthTitle(month)}</b><input type="month" value={month} onChange={(event) => event.target.value && changeMonth(event.target.value)} aria-label="Pick a month" /></label>
        <button type="button" aria-label="Next month" onClick={() => changeMonth(shiftMonth(month, 1))}>›</button>
        <button type="button" className="mn-today" onClick={() => changeMonth(currentMonth())}>This month</button>
      </div>
      <div className="mn-stats">
        <div><b>{stats.notes}</b><span>Notes</span></div>
        <div><b>{stats.tasks}</b><span>Action items</span></div>
        <div className="ok"><b>{stats.done}</b><span>Completed</span></div>
        <div className="info"><b>{stats.open}</b><span>Open</span></div>
        <div className={stats.overdue ? "bad" : ""}><b>{stats.overdue}</b><span>Overdue</span></div>
      </div>
    </header>

    <div className="mn-bar">
      <div className="mn-search">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input type="search" placeholder="Search notes, tasks or people…" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search meeting notes" />
      </div>
      <button type="button" className={"btn alt" + (reportOpen ? " on" : "")} aria-expanded={reportOpen} onClick={() => setReportOpen((open) => !open)}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
        Export report
      </button>
      <button type="button" className={"btn alt" + (monthlyOpen ? " on" : "")} aria-expanded={monthlyOpen} onClick={() => setMonthlyOpen((value) => !value)}>Monthly report</button>
    </div>
    {monthlyOpen && <MonthlyTaskReport projectId={projectId} keyValue={keyValue} month={month} refreshKey={`${refreshKey}-${carriedVersion}-${notes.length}`} title={`Task report · ${monthTitle(month)}`} />}
    {reportOpen && <div className="meeting-report-toolbar mn-report">
      <div><b>Team meeting report</b><span>Download assigned work by team member for a week or a month (opens in Excel).</span></div>
      <label>Period<select value={reportPeriod} onChange={(event) => setReportPeriod(event.target.value)}><option value="month">Month ({monthTitle(month)})</option><option value="week">Week</option></select></label>
      {reportPeriod === "week" && <label>Week of<input type="date" value={reportWeek} onChange={(event) => setReportWeek(event.target.value)} /></label>}
      <label>Team member<select value={reportMember} onChange={(event) => setReportMember(event.target.value)}><option value="">All members</option>{members.filter((member) => member.status === "active" && member.role !== "Client").map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <button type="button" className="btn" onClick={exportReport}>Download CSV</button>
    </div>}

    {error && <div className="meeting-alert" role="alert">{error}</div>}
    {notice && <div className="meeting-success" role="status">{notice}</div>}
    {!editAccess && <div className="meeting-access-banner">
      <div><b>View-only meeting access</b><span>You can review notes, add your own tasks (editable for 24 hours after adding), and update the status of tasks assigned to you. Editing notes, cards, and other task details requires admin approval for one hour.</span></div>
      <button type="button" className="btn" disabled={busy || !!myAccessRequest} onClick={requestEditAccess}>{busy ? "Sending…" : myAccessRequest ? "Request pending" : "Request 1-hour edit access"}</button>
    </div>}
    {editAccess && editAccessExpiresAt && <div className="meeting-access-banner active"><div><b>Temporary edit access is active</b><span>Expires {new Date(editAccessExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. After expiry, you can still update statuses of your assigned tasks.</span></div></div>}
    {canDelete && !!pendingAccessRequests.length && <section className="meeting-access-requests"><h3>Temporary edit requests</h3>{pendingAccessRequests.map((item) => <article key={item.id}><div><b>{item.memberName}</b><span>Requested {new Date(item.requestedAt).toLocaleString()}</span></div><div><button type="button" className="btn" disabled={busy} onClick={() => reviewEditAccess(item.id, "approve")}>Approve for 1 hour</button><button type="button" className="btn alt" disabled={busy} onClick={() => reviewEditAccess(item.id, "deny")}>Deny</button></div></article>)}</section>}

    <div className={"mn-layout" + (selected ? " has-selection" : "")}>
      <div className="mn-list">
        <div className="mn-list-head"><b>{monthTitle(month)}</b><span>{notes.length ? `${notesOffset + 1}–${notesOffset + notes.length} of ${notesTotal}` : "0 notes"}</span></div>
        {notesLoading && !notes.length && <div className="mn-skeleton"><span /><span /><span /></div>}
        {!notesLoading && !visibleNotes.length && <div className="mn-empty-list"><b>{q ? "No notes match your search" : "No meeting notes this month"}</b><span>{q ? "Try another word." : "Notes saved from a meeting appear here."}</span></div>}
        {visibleNotes.map((note, index) => {
          const tasks = note.tasks || [];
          const done = tasks.filter((task) => task.status === "Completed").length;
          const overdue = tasks.filter(isOverdue).length;
          const date = new Date(note.date + "T00:00:00");
          return <button type="button" key={note.id} style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }} className={"mn-card" + (selected?.id === note.id ? " selected" : "")} onClick={() => { openNote(note); setTab("overview"); setNotice(""); }}>
            <span className="mn-date"><b>{Number.isFinite(date.getTime()) ? date.getDate() : "–"}</b><small>{Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-GB", { month: "short" }) : ""}</small></span>
            <span className="mn-card-body">
              <b>{note.title}</b>
              <small>{note.createdByName ? `by ${note.createdByName}` : dateLabel(note.date)}{(note.audioFiles?.length || note.audioFile) ? " · 🎙 recording" : ""}</small>
              {tasks.length > 0 ? <span className="mn-progress" aria-label={`${done} of ${tasks.length} action items completed`}><i style={{ width: `${Math.round((done / tasks.length) * 100)}%` }} /></span> : null}
              <span className="mn-card-chips"><em>{tasks.length} action item{tasks.length === 1 ? "" : "s"}</em>{tasks.length > 0 && <em className="ok">{done} done</em>}{overdue > 0 && <em className="bad">{overdue} overdue</em>}</span>
            </span>
          </button>;
        })}
        {(notesOffset > 0 || notesHasMore) && <div className="tools"><button type="button" className="btn alt" disabled={!notesOffset || notesLoading} onClick={() => setNotesOffset(Math.max(0, notesOffset - 50))}>Previous</button><button type="button" className="btn alt" disabled={!notesHasMore || notesLoading} onClick={() => setNotesOffset(notesOffset + 50)}>{notesLoading ? "Loading…" : "Next"}</button></div>}
      </div>

      {!selected ? <div className="mn-placeholder">
        <span className="mn-placeholder-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M8 13h8M8 17h5" /></svg></span>
        <b>Select a meeting note</b>
        <span>Open a note on the left to see its key points, member updates and action items.</span>
      </div> : <article className="mn-detail" key={selected.id}>
        <header className="mn-detail-head">
          <button type="button" className="mn-back" onClick={() => openNote(null)}>‹ All notes</button>
          <input className="mn-title" disabled={!canManageContent} maxLength="160" value={selected.title} onChange={(event) => setSelected({ ...selected, title: event.target.value })} aria-label="Note title" />
          <div className="mn-detail-meta">
            <span>📅 {dateLabel(selected.date)}</span>
            {selected.createdByName && <span className="mn-by"><i style={{ "--av": avatarColor(selected.createdBy || selected.createdByName) }}>{initials(selected.createdByName)}</i>{selected.createdByName}</span>}
            {selectedTasks.length > 0 && <span className="mn-ring" style={{ "--pct": `${Math.round((selectedDone / selectedTasks.length) * 100)}%` }}><i />{selectedDone}/{selectedTasks.length} done</span>}
            {canDelete && <button type="button" className="ic dl" disabled={busy} onClick={deleteNote}>Delete note</button>}
          </div>
          <nav className="mn-tabs" role="tablist">
            {[["overview", "Overview"], ["tasks", `Action items${selectedTasks.length ? ` · ${selectedTasks.length}` : ""}${carriedPending.length ? ` + ${carriedPending.length} carried` : ""}`], ["transcript", `Transcript${recordingUrls.length ? " & audio" : ""}`]].map(([id, label]) =>
              <button type="button" role="tab" key={id} aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>)}
          </nav>
        </header>

        {canManageContent && <form className="mn-add-task" ref={taskFormRef} onSubmit={addTask} aria-label="Assign a task">
          <b className="mn-add-task-label">Assign a task</b>
          <input required maxLength="300" placeholder="What needs to be done…" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} />
          <select aria-label="Assignee" value={taskAssignee} onChange={(event) => setTaskAssignee(event.target.value)}><option value="">Unassigned</option>{members.filter((member) => member.role !== "Client" && member.status === "active").map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select>
          <select aria-label="Task priority" value={taskPriority} onChange={(event) => setTaskPriority(event.target.value)}><option>High</option><option>Medium</option><option>Low</option></select>
          <input aria-label="Deadline" type="datetime-local" value={taskDeadline} onChange={(event) => setTaskDeadline(event.target.value)} />
          <button className="btn" disabled={busy}>{busy ? "Saving…" : "Assign task"}</button>
        </form>}
        {!canManageContent && <form className="mn-add-task own" onSubmit={addOwnTask} aria-label="Add my task">
          <b className="mn-add-task-label">Add my task <small>You can edit it for 24 hours after adding it; after that, only its status.</small></b>
          <input required maxLength="300" placeholder="What will you work on…" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} />
          <select aria-label="Task priority" value={taskPriority} onChange={(event) => setTaskPriority(event.target.value)}><option>High</option><option>Medium</option><option>Low</option></select>
          <input aria-label="Deadline" type="datetime-local" value={taskDeadline} onChange={(event) => setTaskDeadline(event.target.value)} />
          <button className="btn" disabled={busy}>{busy ? "Saving…" : "Add task"}</button>
        </form>}

        {!!carriedPending.length && (tab === "overview" || tab === "tasks") && <div className="mn-carry-alert" role="status">
          <b>⚠ Not completed from previous meetings — ask for an update</b>
          <span>{carriedByMember.map(({ memberId, tasks }) => `${memberOf(memberId)?.name || "Former member"} (${tasks.length})`).join(" · ")}</span>
          {tab === "overview" && <button type="button" className="ic" onClick={() => setTab("tasks")}>See the tasks</button>}
        </div>}

        {tab === "overview" && <div className="mn-pane">
          <section className="mn-block">
            <h3>Key points</h3>
            <textarea disabled={!canManageContent} rows="7" maxLength="20000" value={selected.summary} onChange={(event) => setSelected({ ...selected, summary: event.target.value })} placeholder="Decisions, progress, blockers and next steps…" />
          </section>
          {!!selected.participantSummaries?.length && <section className="mn-block">
            <h3>Member updates <small>{selected.participantSummaries.length} member{selected.participantSummaries.length === 1 ? "" : "s"}</small>
              <button type="button" className="mn-expand-all" onClick={() => setOpenMembers(openMembers.size === selected.participantSummaries.length ? new Set() : new Set(selected.participantSummaries.map((card) => card.memberId)))}>{openMembers.size === selected.participantSummaries.length ? "Collapse all" : "Expand all"}</button>
            </h3>
            <div className="mn-members">
              {selected.participantSummaries.map((card) => {
                const open = openMembers.has(card.memberId);
                const updates = (card.points || []).filter((line) => String(line).trim()).length, next = (card.tasks || []).filter((line) => String(line).trim()).length;
                const assigned = selectedTasks.filter((task) => task.assigneeId === card.memberId);
                const pendingBefore = carriedPending.filter((task) => task.assigneeId === card.memberId).length;
                return <article className={"mn-member" + (open ? " open" : "")} key={card.memberId} style={{ "--av": avatarColor(card.memberId) }}>
                <button type="button" className="mn-member-head" aria-expanded={open} onClick={() => setOpenMembers((set) => toggled(set, card.memberId))}>
                  <i>{initials(card.name)}</i>
                  <span className="mn-member-name"><b>{card.name}</b><small>{memberOf(card.memberId)?.role || "Team member"}</small></span>
                  <span className="mn-member-counts"><em>{updates} update{updates === 1 ? "" : "s"}</em><em>{next} next task{next === 1 ? "" : "s"}</em>{!!assigned.length && <em className="ok">{assigned.filter((task) => task.status === "Completed").length}/{assigned.length} done</em>}{!!pendingBefore && <em className="bad">{pendingBefore} pending from before</em>}</span>
                  <em className={"pill " + (card.priority || "Medium")}>{card.priority || "Medium"}</em>
                  <span className="mn-chevron"><Icon d={CHEVRON} /></span>
                </button>
                {open && <div className="mn-member-body">
                <div className="mn-member-fields">
                  <label>Updates (done / in progress / blockers)<textarea disabled={!canEditMember(card.memberId)} rows="3" value={(card.points || []).join("\n")} onChange={(event) => setSelected({ ...selected, participantSummaries: selected.participantSummaries.map((item) => item.memberId === card.memberId ? { ...item, points: event.target.value.split("\n") } : item) })} /></label>
                  <label>Next tasks<textarea disabled={!canEditMember(card.memberId)} rows="3" value={(card.tasks || []).join("\n")} onChange={(event) => setSelected({ ...selected, participantSummaries: selected.participantSummaries.map((item) => item.memberId === card.memberId ? { ...item, tasks: event.target.value.split("\n") } : item) })} /></label>
                </div>
                {canManageContent && <div className="mn-member-assign">
                  {unassignedNextTasks(card).length
                    ? <button type="button" className="btn alt" disabled={busy} onClick={() => assignNextTasks(card)}>Assign {unassignedNextTasks(card).length === 1 ? "this next task" : `these ${unassignedNextTasks(card).length} next tasks`} to {card.name}</button>
                    : <small>{(card.tasks || []).some((line) => String(line).trim()) ? `Next tasks are assigned to ${card.name}.` : `Add next tasks above to assign them to ${card.name}.`}</small>}
                  <button type="button" className="ic" onClick={() => { setTaskAssignee(card.memberId); taskFormRef.current?.querySelector("input")?.focus(); taskFormRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }}>Assign another task</button>
                </div>}
                </div>}
              </article>;
              })}
            </div>
          </section>}
        </div>}

        {tab === "tasks" && <div className="mn-pane">
          {!!carried.length && <section className="mn-carried">
            <h3>Previously assigned <small>{carriedPending.length} not completed{carried.length > carriedPending.length ? ` · ${carried.length - carriedPending.length} completed since` : ""}</small></h3>
            <p className="mn-carried-hint">Tasks from earlier meetings that were not completed by this meeting. They appear in every meeting until they are completed.</p>
            {carried.map((task) => <article id={"mn-task-" + task.id} className={"mn-task carried st-" + String(task.status || "Open").replace(" ", "") + (isOverdue(task) ? " overdue" : "")} key={task.origin.noteId + task.id}>
              <div className="mn-task-top">
                <p className="mn-task-title">{task.title}</p>
                <span className="mn-carried-tag">Previously assigned</span>
                <span className={"pill " + (task.priority || "Medium")}>{task.priority || "Medium"}</span>
              </div>
              <div className="mn-task-meta">
                {task.assigneeId === me?.id
                  ? <select className={"mn-status st " + String(task.status || "Open").replace(" ", "")} aria-label="Task status" disabled={busy} value={task.status} onChange={(event) => updateCarriedStatus(task, event.target.value)}><option>Open</option><option>In Progress</option><option>Completed</option></select>
                  : <span className={"pill st " + String(task.status || "Open").replace(" ", "")}>{task.status}</span>}
                <span className={"mn-due" + (isOverdue(task) ? " bad" : "")}>⏰ {isOverdue(task) ? "Overdue · " : ""}{dueLabel(task.dueDate)}</span>
                {memberOf(task.assigneeId) && <span className="mn-assignee"><i style={{ "--av": avatarColor(task.assigneeId) }}>{initials(memberOf(task.assigneeId).name)}</i>{memberOf(task.assigneeId).name}</span>}
              </div>
              <div className="mn-carried-from">
                <span>Assigned in <b>{task.origin.title}</b> · {dateLabel(task.origin.date)}{task.status !== "Completed" ? ` · pending ${task.pendingDays} day${task.pendingDays === 1 ? "" : "s"}` : ""}</span>
                <button type="button" className="ic" onClick={() => openOriginal(task)}>Open in its meeting</button>
              </div>
            </article>)}
          </section>}
          {!taskGroups.length && <div className="mn-empty-list"><b>No action items yet</b><span>{canManageContent ? "Add the first one above." : "Tasks assigned in this meeting will appear here."}</span></div>}
          {taskGroups.length > 1 && <div className="mn-group-tools"><button type="button" className="mn-expand-all" onClick={() => setOpenGroups(openGroups.size === taskGroups.length ? new Set() : new Set(taskGroups.map((group) => group.id)))}>{openGroups.size === taskGroups.length ? "Collapse all" : "Expand all"}</button></div>}
          {taskGroups.map((group) => {
            const open = openGroups.has(group.id) || taskGroups.length === 1;
            const done = group.tasks.filter((task) => task.status === "Completed").length, overdue = group.tasks.filter(isOverdue).length;
            return <section className={"mn-task-group" + (open ? " open" : "")} key={group.id} style={{ "--av": avatarColor(group.id) }}>
            <button type="button" className="mn-member-head" aria-expanded={open} disabled={taskGroups.length === 1} onClick={() => setOpenGroups((set) => toggled(set, group.id))}>
              <i>{group.id === "unassigned" ? "?" : initials(group.name)}</i>
              <span className="mn-member-name"><b>{group.name}</b><small>{memberOf(group.id)?.role || (group.id === "unassigned" ? "Not assigned yet" : "Team member")}</small></span>
              <span className="mn-member-counts"><em>{group.tasks.length} task{group.tasks.length === 1 ? "" : "s"}</em><em className="ok">{done} done</em>{overdue > 0 && <em className="bad">{overdue} overdue</em>}</span>
              <span className="mn-group-progress" aria-label={`${done} of ${group.tasks.length} done`}><i style={{ width: `${Math.round((done / group.tasks.length) * 100)}%` }} /></span>
              {taskGroups.length > 1 && <span className="mn-chevron"><Icon d={CHEVRON} /></span>}
            </button>
            {open && <div className="mn-tasks">{group.tasks.map((task) => {
              const panel = taskPanels[task.id] || "";
              const editable = canEditTask(task);
              const updateTask = (changes) => setSelected({ ...selected, tasks: selected.tasks.map((item) => item.id === task.id ? { ...item, ...changes } : item) });
              return <article id={"mn-task-" + task.id} className={"mn-task st-" + String(task.status || "Open").replace(" ", "") + (isOverdue(task) ? " overdue" : "") + (highlightTask === task.id ? " highlight" : "")} key={task.id}>
              <div className="mn-task-top">
                {editable ? <input className="mn-task-title" aria-label="Task title" maxLength="300" value={task.title} onChange={(event) => updateTask({ title: event.target.value })} /> : <p className="mn-task-title">{task.title}</p>}
                <span className={"pill " + (task.priority || "Medium")}>{task.priority || "Medium"}</span>
                <span className="mn-task-tools">
                  {editable && <button type="button" className={"mn-icon-btn" + (panel === "edit" ? " on" : "")} title="Edit details" aria-label="Edit details" aria-expanded={panel === "edit"} onClick={() => toggleTaskPanel(task.id, "edit")}><Icon d={EDIT} /></button>}
                  {(editable || task.description) && <button type="button" className={"mn-icon-btn" + (panel === "context" ? " on" : "") + (task.description ? " has" : "")} title="Context from the meeting" aria-label="Context from the meeting" aria-expanded={panel === "context"} onClick={() => toggleTaskPanel(task.id, "context")}><Icon d={CONTEXT} /></button>}
                </span>
              </div>
              <div className="mn-task-meta">
                {canEditTask(task) || task.assigneeId === me?.id
                  ? <select className={"mn-status st " + String(task.status || "Open").replace(" ", "")} aria-label="Task status" disabled={busy} value={task.status} onChange={(event) => canEditTask(task)
                    ? setSelected({ ...selected, tasks: selected.tasks.map((item) => item.id === task.id ? { ...item, status: event.target.value } : item) })
                    : updateTaskStatus(task, event.target.value)}><option>Open</option><option>In Progress</option><option>Completed</option></select>
                  : <span className={"pill st " + String(task.status || "Open").replace(" ", "")}>{task.status}</span>}
                <span className={"mn-due" + (isOverdue(task) ? " bad" : "")}>⏰ {isOverdue(task) ? "Overdue · " : ""}{dueLabel(task.dueDate)}</span>
                {task.createdBy && task.createdBy === task.assigneeId && <span className={"mn-own-tag" + (ownTaskEditUntil(task) && !ownTaskEditable(task) ? " locked" : "")} title={task.createdAt ? `Added ${new Date(task.createdAt).toLocaleString()}` : ""}>
                  {ownTaskEditUntil(task)
                    ? ownTaskEditable(task) ? `Your task · editable until ${new Date(ownTaskEditUntil(task)).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "Your task · locked, status only"
                    : `Added by ${task.createdByName || memberOf(task.createdBy)?.name || "member"}`}
                </span>}
                {memberOf(task.assigneeId) && <span className="mn-assignee"><i style={{ "--av": avatarColor(task.assigneeId) }}>{initials(memberOf(task.assigneeId).name)}</i>{memberOf(task.assigneeId).name}</span>}
              </div>
              {panel === "edit" && editable && <div className="mn-task-panel">
                <b><Icon d={EDIT} size={14} />Edit details</b>
                <div className="mn-task-edit">
                  <label>Priority<select value={task.priority || "Medium"} onChange={(event) => updateTask({ priority: event.target.value })}><option>High</option><option>Medium</option><option>Low</option></select></label>
                  {canManageContent && <label>Assignee<select value={task.assigneeId || ""} onChange={(event) => updateTask({ assigneeId: event.target.value })}><option value="">Unassigned</option>{members.filter((member) => member.role !== "Client" && member.status === "active").map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
                  <label>Deadline<input type="datetime-local" value={localDateTime(task.dueDate)} onChange={(event) => updateTask({ dueDate: event.target.value ? new Date(event.target.value).toISOString() : "" })} /></label>
                  {canManageContent && <button type="button" className="ic dl" onClick={() => setSelected({ ...selected, tasks: selected.tasks.filter((item) => item.id !== task.id) })}>Remove task</button>}
                  {!canManageContent && ownTaskEditable(task) && <button type="button" className="ic dl" disabled={busy} onClick={() => removeOwnTask(task)}>Remove task</button>}
                </div>
              </div>}
              {panel === "context" && <div className="mn-task-panel">
                <b><Icon d={CONTEXT} size={14} />Context from the meeting</b>
                {editable
                  ? <textarea rows="4" maxLength="2000" value={task.description || ""} onChange={(event) => updateTask({ description: event.target.value })} placeholder="What was said about this task in the meeting: background, links, acceptance criteria…" aria-label="Context from the meeting" />
                  : <p>{task.description}</p>}
              </div>}
              {(canManageContent || (editAccess && task.assigneeId === me?.id)) && <div className="mn-comments">
                {(task.comments || []).map((comment) => <p key={comment.id}><b>{comment.by}</b><small>{dateLabel(comment.createdAt.slice(0, 10))}</small><br />{comment.text}</p>)}
                <div><input maxLength="2000" placeholder="Write a comment…" value={commentDrafts[task.id] || ""} onChange={(event) => setCommentDrafts({ ...commentDrafts, [task.id]: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addComment(task); } }} /><button type="button" className="btn alt" disabled={busy || !(commentDrafts[task.id] || "").trim()} onClick={() => addComment(task)}>Comment</button></div>
              </div>}
            </article>;
            })}</div>}
          </section>;
          })}
        </div>}

        {tab === "transcript" && <div className="mn-pane">
          {!!recordingUrls.length && <section className="mn-block"><h3>Recording clips <small>{recordingUrls.length}</small></h3><div className="mn-audio">{recordingUrls.map((url, index) => <label key={url}>Clip {index + 1}<audio controls preload="metadata" src={url}>Recording playback is unavailable in this browser.</audio></label>)}</div></section>}
          <section className="mn-block"><h3>Transcript</h3><textarea disabled={!canManageContent} rows="14" maxLength="50000" value={selected.transcript || ""} onChange={(event) => setSelected({ ...selected, transcript: event.target.value })} placeholder="No transcript was saved with this note." /></section>
        </div>}

        {(editAccess || hasOwnEditable) && <footer className="mn-save">
          <span>{JSON.stringify(selected) !== baselineRef.current ? "You have unsaved changes" : "All changes saved"}</span>
          <button className="btn" disabled={busy || JSON.stringify(selected) === baselineRef.current} onClick={save}>{busy ? "Saving…" : "Save changes"}</button>
        </footer>}
      </article>}
    </div>
  </section>;
}
