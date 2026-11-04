"use client";

import { useCallback, useEffect, useState } from "react";

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
const csvCell = (value) => {
  let text = String(value ?? "");
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
};

export default function MeetingNotes({ projectId, keyValue, members, canDelete, canManageContent, me, onAccessChange }) {
  const [month, setMonth] = useState(currentMonth);
  const [reportPeriod, setReportPeriod] = useState("month");
  const [reportWeek, setReportWeek] = useState(() => new Date().toISOString().slice(0, 10));
  const [reportMember, setReportMember] = useState("");
  const [notes, setNotes] = useState([]);
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

  const request = useCallback(async (body) => {
    try {
      const response = await fetch("/api/meeting-notes?month=" + encodeURIComponent(month) + "&project=" + encodeURIComponent(projectId), {
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
    request().then((result) => {
      if (!active) return;
      if (!result.ok) { setError(result.error || "Could not load notes"); return; }
      setNotes(result.notes || []);
      const canEdit = !!result.canEdit || !!canManageContent;
      setEditAccess(canEdit);
      setEditAccessExpiresAt(result.expiresAt || null);
      onAccessChange?.(canEdit, result.expiresAt || null, result.requests || []);
      setAccessRequests(result.requests || []);
      setSelected((previous) => previous ? (result.notes || []).find((note) => note.id === previous.id) || null : null);
    });
    return () => { active = false; };
  }, [request, canManageContent, onAccessChange]);
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

  const save = async () => {
    if (!selected || !editAccess) return;
    setBusy(true); setError(""); setNotice("");
    const result = await request({ action: "update", noteId: selected.id, title: selected.title, summary: selected.summary, transcript: selected.transcript, participantSummaries: selected.participantSummaries, tasks: selected.tasks });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not save note"); return; }
    setSelected(result.note);
    setNotes((items) => items.map((item) => item.id === result.note.id ? result.note : item));
    setNotice(result.taskEmailsFailed ? `Saved, but ${result.taskEmailsFailed} task assignment email(s) failed: ${result.emailErrors?.[0] || "check email settings"}` : `Note and tasks saved.${result.taskEmailsSent ? ` Assignment notification sent to ${result.taskEmailsSent} team member(s).` : ""}`);
  };

  const addTask = async (event) => {
    event.preventDefault();
    if (!selected || !editAccess || !taskTitle.trim()) return;
    const task = { id: crypto.randomUUID(), title: taskTitle.trim(), description: selected.summary || "", assigneeId: taskAssignee, dueDate: taskDeadline ? new Date(taskDeadline).toISOString() : "", status: "Open", priority: taskPriority, comments: [] };
    const updated = { ...selected, tasks: [...(selected.tasks || []), task] };
    setBusy(true); setError("");
    const result = await request({ action: "update", noteId: updated.id, title: updated.title, summary: updated.summary, transcript: updated.transcript, participantSummaries: updated.participantSummaries, tasks: updated.tasks });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not add task"); return; }
    setSelected(result.note); setNotes((items) => items.map((item) => item.id === result.note.id ? result.note : item));
    setTaskTitle(""); setTaskAssignee(""); setTaskDeadline(""); setTaskPriority("Medium");
    if (result.taskEmailsFailed) setError(`Task saved, but assignment email failed: ${result.emailErrors?.[0] || "check email settings"}`);
    else if (result.taskEmailsSent) setNotice(`Task saved and emailed to ${result.taskEmailsSent} assigned team member(s).`);
  };

  const addComment = async (task) => {
    const text = (commentDrafts[task.id] || "").trim();
    if (!text || !selected || !editAccess) return;
    setBusy(true); setError("");
    const result = await request({ action: "comment", noteId: selected.id, taskId: task.id, text });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not add comment"); return; }
    setSelected(result.note); setNotes((items) => items.map((item) => item.id === result.note.id ? result.note : item));
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
    setSelected(result.note);
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
      const response = await fetch(`/api/meeting-notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&project=${encodeURIComponent(projectId)}`, { headers: { "x-key": keyValue } });
      const result = await response.json();
      if (!response.ok) { setError(result.error || "Could not create report"); return; }
      const reportNotes = result.notes || [];
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
  const canEditTask = (task) => !!canManageContent || (editAccess && task.assigneeId === me?.id);
  const myAccessRequest = accessRequests.find((item) => item.memberId === me?.id && item.projectId === projectId && item.status === "pending");
  const pendingAccessRequests = accessRequests.filter((item) => item.status === "pending");

  return <section className="panel managed-notes">
    <div className="managed-notes-toolbar">
      <div><h2>Meeting notes & action items</h2><p>Meeting decisions become assigned tasks; set deadlines here.</p></div>
      <label>Month<input type="month" value={month} onChange={(event) => { setMonth(event.target.value); setSelected(null); }} /></label>
    </div>
    <div className="meeting-report-toolbar">
      <div><b>Team meeting report</b><span>Export assigned work by team member and week or month.</span></div>
      <label>Period<select value={reportPeriod} onChange={(event) => setReportPeriod(event.target.value)}><option value="month">Month</option><option value="week">Week</option></select></label>
      {reportPeriod === "week" && <label>Week of<input type="date" value={reportWeek} onChange={(event) => setReportWeek(event.target.value)} /></label>}
      <label>Team member<select value={reportMember} onChange={(event) => setReportMember(event.target.value)}><option value="">All members</option>{members.filter((member) => member.status === "active" && member.role !== "Client").map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <button type="button" className="btn alt" onClick={exportReport}>Export Excel CSV</button>
    </div>
    {error && <div className="meeting-alert" role="alert">{error}</div>}
    {notice && <div className="meeting-success" role="status">{notice}</div>}
    {!editAccess && <div className="meeting-access-banner">
      <div><b>View-only meeting access</b><span>You can review notes and update the status of tasks assigned to you. Editing notes, cards, and task details requires admin approval for one hour.</span></div>
      <button type="button" className="btn" disabled={busy || !!myAccessRequest} onClick={requestEditAccess}>{busy ? "Sending…" : myAccessRequest ? "Request pending" : "Request 1-hour edit access"}</button>
    </div>}
    {editAccess && editAccessExpiresAt && <div className="meeting-access-banner active"><div><b>Temporary edit access is active</b><span>Expires {new Date(editAccessExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. After expiry, you can still update statuses of your assigned tasks.</span></div></div>}
    {canDelete && !!pendingAccessRequests.length && <section className="meeting-access-requests"><h3>Temporary edit requests</h3>{pendingAccessRequests.map((item) => <article key={item.id}><div><b>{item.memberName}</b><span>Requested {new Date(item.requestedAt).toLocaleString()}</span></div><div><button type="button" className="btn" disabled={busy} onClick={() => reviewEditAccess(item.id, "approve")}>Approve for 1 hour</button><button type="button" className="btn alt" disabled={busy} onClick={() => reviewEditAccess(item.id, "deny")}>Deny</button></div></article>)}</section>}
    <div className="managed-notes-layout">
      <div className="managed-notes-list">
        {!notes.length && <p className="meeting-empty">No saved meeting notes for this month in this project.</p>}
        {notes.map((note) => <button type="button" className={"managed-note-item" + (selected?.id === note.id ? " selected" : "")} key={note.id} onClick={() => { setSelected(note); setNotice(""); }}>
          <b>{note.title}</b><span>{dateLabel(note.date)}</span><small>{note.tasks?.length || 0} action items · {note.createdByName}</small>
        </button>)}
      </div>
      {selected && <div className="managed-note-detail">
        <div className="managed-note-meta">{dateLabel(selected.date)} · Meeting notes by {selected.createdByName}{canDelete && <button type="button" className="ic dl" disabled={busy} onClick={deleteNote}>Delete note</button>}</div>
        {!!recordingUrls.length && <div className="managed-saved-recording"><b>Saved recording clips ({recordingUrls.length})</b>{recordingUrls.map((url, index) => <label key={url}>Clip {index + 1}<audio controls preload="metadata" src={url}>Recording playback is unavailable in this browser.</audio></label>)}</div>}
        <label>Note title<input disabled={!canManageContent} maxLength="160" value={selected.title} onChange={(event) => setSelected({ ...selected, title: event.target.value })} /></label>
        <label>Generic key points / shared notes<textarea disabled={!canManageContent} rows="6" maxLength="20000" value={selected.summary} onChange={(event) => setSelected({ ...selected, summary: event.target.value })} /></label>
        {!!selected.participantSummaries?.length && <section className="managed-participant-notes"><h3>Member-specific notes</h3>
          {selected.participantSummaries.map((card, index) => <details className="managed-member-note" key={card.memberId} open={index === 0}><summary><b>{card.name}</b><span>{(card.points || []).length} previous updates · {(card.tasks || []).length} upcoming tasks</span></summary>
            <div className="managed-member-note-fields">
              <label>Previous task updates<textarea disabled={!canEditMember(card.memberId)} rows="3" value={(card.points || []).join("\n")} onChange={(event) => setSelected({ ...selected, participantSummaries: selected.participantSummaries.map((item) => item.memberId === card.memberId ? { ...item, points: event.target.value.split("\n") } : item) })} /></label>
              <label>Upcoming tasks · {card.priority || "Medium"} priority<textarea disabled={!canEditMember(card.memberId)} rows="2" value={(card.tasks || []).join("\n")} onChange={(event) => setSelected({ ...selected, participantSummaries: selected.participantSummaries.map((item) => item.memberId === card.memberId ? { ...item, tasks: event.target.value.split("\n") } : item) })} /></label>
            </div>
          </details>)}
        </section>}
        <details className="managed-transcript"><summary>Transcript</summary><textarea disabled={!canManageContent} rows="8" maxLength="50000" value={selected.transcript} onChange={(event) => setSelected({ ...selected, transcript: event.target.value })} /></details>
        <section className="managed-tasks"><h3>Action items</h3>
          {canManageContent && <form className="managed-task-create" onSubmit={addTask}>
            <input required maxLength="300" placeholder="Action item" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} />
            <select value={taskAssignee} onChange={(event) => setTaskAssignee(event.target.value)}><option value="">Unassigned</option>{members.filter((member) => member.role !== "Client" && member.status === "active").map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select>
            <select aria-label="Task priority" value={taskPriority} onChange={(event) => setTaskPriority(event.target.value)}><option>High</option><option>Medium</option><option>Low</option></select>
            <input aria-label="Deadline" type="datetime-local" value={taskDeadline} onChange={(event) => setTaskDeadline(event.target.value)} />
            <button className="btn" disabled={busy}>Add task</button>
          </form>}
          {!taskGroups.length && <p className="meeting-empty">No action items have been assigned yet.</p>}
          {taskGroups.map((group, groupIndex) => <details className="managed-task-member-group" key={group.id} open={groupIndex === 0}>
            <summary><b>{group.name}</b><span>{group.tasks.length} task{group.tasks.length === 1 ? "" : "s"}</span></summary>
            <div>{group.tasks.map((task) => <article className="managed-task" key={task.id}>
              <div className="managed-task-title"><b>Task</b><p>{task.title}</p>{canEditTask(task) && <label>Edit title<input aria-label="Task title" maxLength="300" value={task.title} onChange={(event) => setSelected({ ...selected, tasks: selected.tasks.map((item) => item.id === task.id ? { ...item, title: event.target.value } : item) })} /></label>}</div>
              <div className="managed-task-fields">{canEditTask(task) || task.assigneeId === me?.id
                ? <select aria-label="Task status" disabled={busy} value={task.status} onChange={(event) => canEditTask(task)
                  ? setSelected({ ...selected, tasks: selected.tasks.map((item) => item.id === task.id ? { ...item, status: event.target.value } : item) })
                  : updateTaskStatus(task, event.target.value)}><option>Open</option><option>In Progress</option><option>Completed</option></select>
                : <span className={"pill st " + task.status.replace(" ", "")}>{task.status}</span>}
                {canEditTask(task) && <>
                  <select aria-label="Task priority" value={task.priority || "Medium"} onChange={(event) => setSelected({ ...selected, tasks: selected.tasks.map((item) => item.id === task.id ? { ...item, priority: event.target.value } : item) })}><option>High</option><option>Medium</option><option>Low</option></select>
                  {canManageContent && <select aria-label="Task assignee" value={task.assigneeId || ""} onChange={(event) => setSelected({ ...selected, tasks: selected.tasks.map((item) => item.id === task.id ? { ...item, assigneeId: event.target.value } : item) })}><option value="">Unassigned</option>{members.filter((member) => member.role !== "Client" && member.status === "active").map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select>}
                  <input aria-label="Task deadline" type="datetime-local" value={localDateTime(task.dueDate)} onChange={(event) => setSelected({ ...selected, tasks: selected.tasks.map((item) => item.id === task.id ? { ...item, dueDate: event.target.value ? new Date(event.target.value).toISOString() : "" } : item) })} />
                  {canManageContent && <button type="button" className="ic dl" onClick={() => setSelected({ ...selected, tasks: selected.tasks.filter((item) => item.id !== task.id) })}>Remove</button>}
                </>}
              </div>
              {task.description && <div className="managed-task-description"><b>Task description from meeting notes</b><p>{task.description}</p></div>}
              {(canManageContent || (editAccess && task.assigneeId === me?.id)) && <div className="managed-comments">{(task.comments || []).map((comment) => <p key={comment.id}><b>{comment.by}</b> · {dateLabel(comment.createdAt.slice(0, 10))}<br />{comment.text}</p>)}
                <div><input maxLength="2000" placeholder="Add a comment…" value={commentDrafts[task.id] || ""} onChange={(event) => setCommentDrafts({ ...commentDrafts, [task.id]: event.target.value })} /><button type="button" className="btn alt" disabled={busy} onClick={() => addComment(task)}>Comment</button></div>
              </div>}
            </article>)}</div>
          </details>)}
        </section>
        {editAccess && <div className="acts end"><button className="btn" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save changes"}</button></div>}
      </div>}
    </div>
  </section>;
}
