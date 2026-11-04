"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { correctTurnNames, generateEnglishKeyPoints, generateMeetingParticipantCards } from "../lib/local-transcription";
import MeetingNotes from "../components/MeetingNotes";

const LocalTranscriber = dynamic(() => import("../components/LocalTranscriber"), { ssr: false });

const STATUS = ["Open", "In Progress", "Testing", "Completed", "Reopened"], PRIO = ["High", "Medium", "Low"], ROLES = ["Admin", "Developer", "Collaborator", "Client"];
const CATS = ["Requirements & Design", "Reports & Releases", "Guides & Communication", "Other"];
const COL = ["#ef4444", "#f59e0b", "#06b6d4", "#10b981", "#a855f7"];
const today = () => new Date().toISOString().slice(0, 10);
const localDateKey = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const fmt = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-";
const ml = (m, s) => new Date(m + "-01T00:00:00").toLocaleDateString("en-GB", { month: s ? "short" : "long", year: s ? "2-digit" : "numeric" });
const blank = (type) => ({ type, by: "Team", title: "", priority: "Medium", assignees: [], details: "", version: "", deployed: "", status: "Open", date: today(), closed: "" });
const ticketNumber = (t) => Number((t.id || "").match(/-(\d+)$/)?.[1] || 0);
const nextId = (l, type) => (type === "issue" ? "ISS-" : "FTR-") + String(Math.max(0, ...l.filter((t) => t.type === type).map(ticketNumber)) + 1).padStart(2, "0");
const conferenceLaunchUrl = (provider) => ({
  "google-meet": "https://meet.google.com/new",
  "microsoft-teams": "https://teams.microsoft.com/",
  zoom: "https://zoom.us/start/videomeeting",
}[provider] || "");
const meetingCards = (meeting, members) => {
  const saved = new Map((meeting?.participantSummaries || []).map((card) => [card.memberId, card]));
  const eligible = members.filter((member) => member.status === "active" && member.role !== "Client");
  return eligible.map((member) => {
    const id = member.id;
    const card = saved.get(id);
    return { memberId: id, name: member.name, points: card?.points || [], tasks: card?.tasks || [], description: card?.description || "", priority: card?.priority || "Medium" };
  });
};
const meetingVoiceAttendees = (members, me) => {
  const activeTeam = members.filter((member) => member.status === "active" && member.role !== "Client");
  if (me?.role === "Admin" && !activeTeam.some((member) => member.id === me.id)) return [...activeTeam, me];
  return activeTeam;
};
const MEMBER_CARD_COLORS = ["#2563eb", "#0f9f8f", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#4f46e5", "#65a30d"];
const mergeVoiceCards = (existing, incoming) => {
  const cards = new Map(existing.map((card) => [card.memberId, card]));
  incoming.forEach((card) => {
    const previous = cards.get(card.memberId);
    cards.set(card.memberId, { ...previous, ...card, priority: previous?.priority || card.priority || "Medium" });
  });
  return [...cards.values()];
};
let jitsiApiScriptPromise;
function JitsiMeetingEmbed({ roomUrl, title }) {
  const containerRef = useRef(null);
  const [status, setStatus] = useState("Connecting to the Jitsi room…");
  useEffect(() => {
    let disposed = false, api;
    const loadApi = () => {
      if (window.JitsiMeetExternalAPI) return Promise.resolve();
      if (!jitsiApiScriptPromise) {
        jitsiApiScriptPromise = new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://meet.jit.si/external_api.js";
          script.async = true;
          script.onload = resolve;
          script.onerror = () => {
            jitsiApiScriptPromise = null;
            reject(new Error("Could not load Jitsi's meeting embed API."));
          };
          document.head.appendChild(script);
        });
      }
      return jitsiApiScriptPromise;
    };
    loadApi().then(() => {
      if (disposed || !containerRef.current || !window.JitsiMeetExternalAPI) return;
      const roomName = new URL(roomUrl).pathname.split("/").filter(Boolean).pop();
      if (!roomName) throw new Error("The Jitsi meeting link is invalid.");
      api = new window.JitsiMeetExternalAPI("meet.jit.si", {
        roomName,
        parentNode: containerRef.current,
        width: "100%",
        height: "100%",
        configOverwrite: {
          prejoinPageEnabled: false,
          startWithAudioMuted: false,
          startWithVideoMuted: false,
        },
        interfaceConfigOverwrite: { DISABLE_JOIN_LEAVE_NOTIFICATIONS: true },
      });
      api.addListener("videoConferenceJoined", () => setStatus("Connected. Allow microphone and camera if your browser asks."));
      api.addListener("cameraError", () => setStatus("Camera access failed. Check this site's camera permission and close other apps using the camera."));
      api.addListener("micError", () => setStatus("Microphone access failed. Check this site's microphone permission and close other apps using the microphone."));
      api.addListener("readyToClose", () => setStatus("The Jitsi room was closed."));
    }).catch((error) => {
      if (!disposed) setStatus(error.message || "Unable to open the Jitsi meeting in the dashboard.");
    });
    return () => {
      disposed = true;
      api?.dispose();
    };
  }, [roomUrl]);
  return <><div className="meeting-room-frame" ref={containerRef} aria-label={"Jitsi meeting: " + title} /><p className="meeting-invite-hint" role="status">{status}</p></>;
}
const api = async (p, body, key, projectId) => {
  try {
    const r = await fetch("/api/" + p + (projectId ? (p.includes("?") ? "&" : "?") + "project=" + encodeURIComponent(projectId) : ""), {
      method: body ? "POST" : "GET",
      headers: { "x-key": key || "", ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    });
    const text = await r.text();
    if (!text.trim()) return { ok: false, status: r.status, error: `Server returned an empty response (HTTP ${r.status})` };
    try {
      const result = JSON.parse(text);
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid API response");
      return { ...result, ok: r.ok, status: r.status };
    } catch {
      return { ok: false, status: r.status, error: `Server returned an invalid response (HTTP ${r.status})` };
    }
  } catch (error) {
    return { ok: false, status: 0, error: `Unable to reach the server: ${error instanceof Error ? error.message : String(error)}` };
  }
};
const Ic = ({ d }) => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>);
const EYE = "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 100 6 3 3 0 000-6z";
const PEN = "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z";
const TRASH = "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6";
const CLIP = "M21 11l-9 9a5 5 0 01-7-7l9-9a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8-8";

function Assign({ t, members, can, onChange }) {
  const [open, setOpen] = useState(null);
  const sel = t.assignees || [];
  const names = members.filter((m) => sel.includes(m.id)).map((m) => m.name.split(" ")[0]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (e) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);
  return (<div className="ms">
    <button type="button" className="msb" disabled={!can} aria-expanded={!!open} onClick={(e) => { if (open) return setOpen(null); const r = e.currentTarget.getBoundingClientRect(); setOpen({ x: Math.min(r.left, window.innerWidth - 250), y: Math.min(r.bottom + 4, window.innerHeight - 280) }); }}>{names.length ? names.join(", ") : "Unassigned"} &#9662;</button>
    {open && typeof document !== "undefined" && createPortal(<>
      <div className="msv" onMouseDown={() => setOpen(null)} />
      <div className="msp" style={{ left: open.x, top: open.y }} onMouseDown={(e) => e.stopPropagation()}>
        {members.map((m) => (<label key={m.id} className="mo"><input type="checkbox" checked={sel.includes(m.id)} onChange={() => onChange(sel.includes(m.id) ? sel.filter((x) => x !== m.id) : [...sel, m.id])} />{m.name} <em>{m.role}</em></label>))}
        {!members.length && <small>No team members yet</small>}
      </div>
    </>, document.body)}
  </div>);
}

function Chart({ title, list }) {
  const ms = [...new Set(list.map((t) => (t.date || "").slice(0, 7)).filter(Boolean))].sort();
  const rc = ms.map((m) => STATUS.map((s) => list.filter((t) => (t.date || "").startsWith(m) && t.status === s).length));
  const mx = Math.max(1, ...rc.flat()), st = STATUS.map((s) => list.filter((t) => t.status === s).length), tot = list.length || 1;
  let a = 0;
  const grad = st.map((n, i) => { const s = a; a += (n / tot) * 100; return COL[i] + " " + s + "% " + a + "%"; }).join(",");
  return (
    <div className="panel">
      <h3>{title}</h3>
      <div className="ch">
        <svg viewBox={"0 0 " + (ms.length * 104 + 16) + " 160"} className="svg">
          {rc.map((row, i) => (<g key={i}>
            {row.map((n, j) => (<g key={j}>
              <rect x={i * 104 + 12 + j * 16} y={120 - (n / mx) * 100} width="14" height={(n / mx) * 100} rx="3" fill={COL[j]} />
              {n > 0 && <text x={i * 104 + 19 + j * 16} y={116 - (n / mx) * 100} textAnchor="middle" fontSize="9" fill="#334155">{n}</text>}
            </g>))}
            <text x={i * 104 + 52} y="140" textAnchor="middle" fontSize="11" fill="#64748b">{ml(ms[i], 1)}</text>
          </g>))}
        </svg>
        <div className="donut" style={{ background: "conic-gradient(" + (list.length ? grad : "#e5e9f2,#e5e9f2") + ")" }}><b>{list.length}</b></div>
      </div>
      <div className="leg">{STATUS.map((s, i) => (<span key={s}><i style={{ background: COL[i] }} />{s} {st[i]}</span>))}</div>
    </div>
  );
}

export default function Page() {
  const [screen, setScreen] = useState("loading");
  const [key, setKey] = useState("");
  const [me, setMe] = useState(null);
  const [canUseMeetings, setCanUseMeetings] = useState(false);
  const [canManageMeetings, setCanManageMeetings] = useState(false);
  const [meetingEditAccess, setMeetingEditAccess] = useState(false);
  const [meetingEditAccessExpiresAt, setMeetingEditAccessExpiresAt] = useState(null);
  const [meetingEditRequests, setMeetingEditRequests] = useState([]);
  const [projects, setProjects] = useState([]);
  const [organizations, setOrganizations] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [projectModal, setProjectModal] = useState(false);
  const [organizationModal, setOrganizationModal] = useState(false);
  const [organizationName, setOrganizationName] = useState("");
  const [projectOrganizationId, setProjectOrganizationId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [tickets, setTickets] = useState([]);
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [audit, setAudit] = useState([]);
  const [files, setFiles] = useState([]);
  const [fc, setFc] = useState(0);
  const [lk, setLk] = useState({ url: "", name: "" });
  const [fa, setFa] = useState(""), [aa, setAa] = useState("");
  const [amsg, setAmsg] = useState("");
  const [inv, setInv] = useState(null);
  const [invPassword, setInvPassword] = useState("");
  const [view, setView] = useState("all");
  const [q, setQ] = useState(""), [fs, setFs] = useState(""), [fp, setFp] = useState(""), [fm, setFm] = useState("");
  const [col, setCol] = useState({});
  const [modal, setModal] = useState(null);
  const [detail, setDetail] = useState(null);
  const [ucat, setUcat] = useState(CATS[0]);
  const [form, setForm] = useState({ name: "", email: "", role: "Developer" });
  const [msg, setMsg] = useState("");
  const [lf, setLf] = useState({ name: "", email: "", phone: "", password: "", id: "" });
  const [acct, setAcct] = useState(null);
  const [meetingMonth, setMeetingMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [meetings, setMeetings] = useState([]);
  const [meetingsLoading, setMeetingsLoading] = useState(false);
  const [meetingSelected, setMeetingSelected] = useState(null);
  const [meetingDraft, setMeetingDraft] = useState("");
  const [meetingFormOpen, setMeetingFormOpen] = useState(false);
  const [meetingForm, setMeetingForm] = useState({ title: "Team meeting", date: today(), time: "10:00", duration: "60", agenda: "", online: true, roomProvider: "google-meet", roomUrl: "", attendeeIds: [] });
  const [participantSummaries, setParticipantSummaries] = useState([]);
  const [selectedMeetingMemberId, setSelectedMeetingMemberId] = useState("");
  const [meetingCardView, setMeetingCardView] = useState("selected");
  const [recordingCards, setRecordingCards] = useState([]);
  const [meetingError, setMeetingError] = useState("");
  const [meetingNotice, setMeetingNotice] = useState("");
  const [dashboardNotice, setDashboardNotice] = useState("");
  const [meetingVoiceError, setMeetingVoiceError] = useState("");
  const [meetingBusy, setMeetingBusy] = useState(false);
  const [googleCalendarConfigured, setGoogleCalendarConfigured] = useState(false);
  const [googleCalendarConnected, setGoogleCalendarConnected] = useState(false);
  const [googleCalendarEmail, setGoogleCalendarEmail] = useState("");
  const [recordingState, setRecordingState] = useState("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [transcriptionLanguage, setTranscriptionLanguage] = useState("auto");
  const [hasRecordedVoiceNote, setHasRecordedVoiceNote] = useState(false);
  const [transcriptionProgress, setTranscriptionProgress] = useState("");
  const [pendingRecording, setPendingRecording] = useState(null);
  const [failedRecording, setFailedRecording] = useState(null);
  const [recordingClips, setRecordingClips] = useState([]);
  const [recordingTranscript, setRecordingTranscript] = useState("");
  const [recordingSaved, setRecordingSaved] = useState(false);
  const [recordingNoteId, setRecordingNoteId] = useState("");
  const [sharingParticipantIds, setSharingParticipantIds] = useState([]);
  const [conferenceJoined, setConferenceJoined] = useState(false);
  const recorderRef = useRef(null);
  const recordingStreamRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const handleMeetingAccessChange = useCallback((canEdit, expiresAt, requests) => {
    setMeetingEditAccess(canEdit);
    setMeetingEditAccessExpiresAt(expiresAt);
    if (requests) setMeetingEditRequests(requests);
  }, []);
  const recordingClipsRef = useRef([]);
  const recordingNotesStartRef = useRef(null);
  useEffect(() => { recordingClipsRef.current = recordingClips; }, [recordingClips]);
  useEffect(() => () => recordingClipsRef.current.forEach((clip) => URL.revokeObjectURL(clip.url)), []);
  useEffect(() => () => {
    clearInterval(recordingTimerRef.current);
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const load = useCallback(async (k, requestedProject) => {
    const selectedProject = requestedProject || localStorage.getItem("rw-project") || "";
    const r = await api("db", null, k, selectedProject);
    if (r.setup) return setScreen("setup");
    if (r.status === 401) return setScreen("login");
    if (!r.ok && r.status === 403 && selectedProject) {
      const fallback = await api("db", null, k);
      if (fallback.ok) return applyDb(fallback);
    }
    if (!r.ok) { if (r.status === 401) setScreen("login"); else alert(r.error || "Unable to load project"); return; }
    applyDb(r);
    function applyDb(data) {
      setMe(data.me); setCanUseMeetings(data.canUseMeetings === undefined ? data.me.role !== "Client" : data.canUseMeetings); setCanManageMeetings(!!data.canManageMeetings); setMeetingEditAccess(!!data.meetingEditAccess); setMeetingEditAccessExpiresAt(data.meetingEditAccessExpiresAt || null); setMeetingEditRequests(data.meetingEditRequests || []); setGoogleCalendarConfigured(!!data.googleCalendarConfigured); setGoogleCalendarConnected(!!data.googleCalendarConnected); setGoogleCalendarEmail(data.googleCalendarEmail || ""); setProjects(data.projects || []); setOrganizations(data.organizations || []); setProjectId(data.projectId); localStorage.setItem("rw-project", data.projectId);
      setView((v) => data.me.role === "Client" && v !== "account" ? "portal" : v); setAcct({ name: data.me.name, phone: data.me.phone || "", current: "", password: "", confirm: "" }); setTickets(data.tickets); setMembers(data.members); setInvites(data.invites || []); setAudit(data.audit || []); setFiles(data.files || []); setScreen("app");
    }
  }, []);
  useEffect(() => {
    const sp = new URLSearchParams(location.search), t = sp.get("invite");
    if (sp.get("reset")) { setScreen("reset"); return; }
    if (sp.has("google-meet")) {
      setView("meetings");
      if (sp.get("google-meet") === "connected") setMeetingNotice("Google Calendar connected. New online meetings can now create shareable Google Meet rooms automatically.");
      else setMeetingError(`Google Calendar connection did not complete (${sp.get("reason") || "cancelled"}). Check the OAuth setup and try again.`);
      history.replaceState(null, "", "/");
    }
    if (t) api("invite?t=" + t).then((r) => { setInv({ ...r, token: t }); setScreen(r.email ? "accept" : "denied"); });
    else { const k = localStorage.getItem("rw-key") || ""; setKey(k); load(k); }
  }, [load]);
  useEffect(() => {
    if (!meetingEditAccessExpiresAt) return;
    const timer = setTimeout(() => {
      if (Date.now() >= meetingEditAccessExpiresAt) {
        setMeetingEditAccess(false);
        setMeetingEditAccessExpiresAt(null);
      }
    }, Math.max(0, meetingEditAccessExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [meetingEditAccessExpiresAt]);
  useEffect(() => {
    if (view === "meetings" || recordingState !== "idle" || !meetingSelected) return;
    setMeetingSelected(null);
    setMeetingDraft("");
    setParticipantSummaries([]);
    setSelectedMeetingMemberId("");
    setRecordingTranscript("");
    setRecordingCards([]);
    setMeetingError("");
    setMeetingNotice("");
  }, [view, recordingState, meetingSelected]);
  useEffect(() => {
    const pending = meetingEditRequests.some((item) => item.projectId === projectId && item.memberId === me?.id && item.status === "pending");
    if (!pending || !key || !projectId) return;
    const timer = setInterval(async () => {
      const result = await api("meeting-notes?month=" + monthKey(meetingMonth), null, key, projectId);
      if (!result.ok) return;
      setMeetingEditAccess(!!result.canEdit);
      setMeetingEditAccessExpiresAt(result.expiresAt || null);
      setMeetingEditRequests(result.requests || []);
    }, 15000);
    return () => clearInterval(timer);
  }, [meetingEditRequests, me, key, projectId, meetingMonth]);
  useEffect(() => {
    if (me?.role !== "Admin" || view !== "all" || !key || !projectId) return;
    const timer = setInterval(async () => {
      const result = await api("meeting-notes?month=" + monthKey(meetingMonth), null, key, projectId);
      if (result.ok) setMeetingEditRequests(result.requests || []);
    }, 30000);
    return () => clearInterval(timer);
  }, [me, view, key, projectId, meetingMonth]);
  useEffect(() => {
    if (view !== "meetings" || !key || !projectId) return;
    let cancelled = false;
    setMeetingsLoading(true);
    api("meetings?month=" + monthKey(meetingMonth), null, key, projectId).then((r) => {
      if (cancelled) return;
      if (!r.ok) { setMeetingError(r.error || "Unable to load meetings"); return; }
      setMeetings(r.meetings || []);
      setMeetingSelected((selected) => selected && (r.meetings || []).some((item) => item.id === selected.id && item.occurrenceDate === selected.occurrenceDate)
        ? (r.meetings || []).find((item) => item.id === selected.id && item.occurrenceDate === selected.occurrenceDate)
        : null);
    }).catch((error) => { if (!cancelled) setMeetingError(error.message || "Unable to load meetings"); })
      .finally(() => { if (!cancelled) setMeetingsLoading(false); });
    return () => { cancelled = true; };
  }, [view, key, projectId, meetingMonth]);

  const join = async (path, body) => {
    setMsg("");
    const r = await api(path, body);
    if (!r.key) return setMsg(r.error || "Failed");
    localStorage.setItem("rw-key", r.key); setKey(r.key); history.replaceState(null, "", "/"); load(r.key, r.projectId);
  };
  const acceptInvite = async (e) => {
    e.preventDefault();
    setMsg("");
    const r = await api("accept", { token: inv.token, name: lf.name, password: invPassword || lf.password, phone: lf.phone });
    if (!r.key) return setMsg(r.error || "Failed to accept invitation");
    localStorage.setItem("rw-key", r.key); localStorage.setItem("rw-project", r.projectId);
    setKey(r.key); history.replaceState(null, "", "/"); load(r.key, r.projectId);
  };
  const commit = async (next) => { setTickets(next); const r = await api("tickets", { tickets: next }, key, projectId); if (!r.ok) { alert(r.error || "Save failed"); load(key); } };

  const admin = me && me.role === "Admin", canEdit = me && me.role !== "Collaborator" && me.role !== "Client", client = me && me.role === "Client";
  const canEditMeetingContent = !!me && (["Admin", "Collaborator"].includes(me.role) || meetingEditAccess);
  const activeProject = projects.find((p) => p.id === projectId);
  const activeOrganization = organizations.find((organization) => organization.id === activeProject?.organizationId);
  const canDel = (t) => admin && !(t.assignees || []).includes(me.id);
  const base = useMemo(() => tickets.filter((t) => view === "all" || t.type === view), [tickets, view]);
  const months = useMemo(() => [...new Set(base.map((t) => (t.date || "").slice(0, 7)).filter(Boolean))].sort(), [base]);
  const rows = useMemo(() => base.filter((t) =>
    (!fs || t.status === fs) && (!fp || t.priority === fp) && (!fa || (fa === "none" ? !(t.assignees || []).length : (t.assignees || []).includes(fa))) && (!fm || (t.date || "").startsWith(fm)) &&
    (!q || (t.id + t.title + t.details + members.filter((m) => (t.assignees || []).includes(m.id)).map((m) => m.name).join(" ")).toLowerCase().includes(q.toLowerCase()))
  ).sort((a, b) => view === "issue" || view === "feature"
    ? ticketNumber(a) - ticketNumber(b) || a.id.localeCompare(b.id)
    : (a.date || "").localeCompare(b.date || "") || a.id.localeCompare(b.id)), [base, q, fs, fp, fm, fa, members, view]);
  const cnt = (s) => base.filter((t) => t.status === s).length;
  const stats = [["Total tickets", base.length, "c1"], ["Open / In progress", cnt("Open") + cnt("In Progress") + cnt("Reopened"), "c2"], ["In testing", cnt("Testing"), "c3"], ["Completed", cnt("Completed"), "c4"], ["High priority open", base.filter((t) => t.priority === "High" && t.status !== "Completed").length, "c5"]];

  const patch = (id, o) => commit(tickets.map((t) => t.id === id ? { ...t, ...o } : t));
  const setStatus = (t, status) => patch(t.id, { status, closed: status === "Completed" ? (t.closed || today()) : "" });
  const del = (t) => { if (confirm("Delete " + t.id + "?")) commit(tickets.filter((x) => x.id !== t.id)); };
  const attachAll = async (id, m) => {
    for (const f of m._files || []) {
      const fd = new FormData(); fd.append("file", f); fd.append("cat", m._cat || CATS[CATS.length - 1]); fd.append("ticket", id);
      const r = await api("upload", fd, key, projectId); if (!r.ok) alert(r.error || "Upload failed");
    }
    if (m._url) { const r = await api("addlink", { url: m._url, name: m._uname || m._url, cat: m._cat || CATS[CATS.length - 1], ticket: id }, key, projectId); if (!r.ok) alert(r.error || "Invalid link"); }
  };
  const save = async (e) => {
    e.preventDefault();
    const m = modal, t = { ...m }; ["_files", "_cat", "_url", "_uname"].forEach((k) => delete t[k]);
    setModal(null);
    if (me.role === "Client") {
      const r = await api("client", { ticket: t }, key, projectId);
      if (!r.id) return alert(r.error || "Failed");
      await attachAll(r.id, m); return load(key);
    }
    t.closed = t.status === "Completed" ? (t.closed || today()) : "";
    if (!t.id) { t.id = nextId(tickets, t.type); await commit([...tickets, t]); } else await commit(tickets.map((x) => x.id === t.id ? t : x));
    await attachAll(t.id, m); load(key);
  };
  const reopen = async (t) => {
    const reason = prompt("Why are you not satisfied with the solution? (required)");
    if (!reason || !reason.trim()) return;
    const r = await api("client", { action: "reopen", id: t.id, reason }, key, projectId);
    if (!r.ok) alert(r.error || "Failed");
    setDetail(null); load(key);
  };
  const addLink = async () => {
    const r = await api("addlink", { url: lk.url, name: lk.name || lk.url, cat: CATS[fc] }, key, projectId);
    if (!r.ok) return alert(r.error || "Failed");
    setLk({ url: "", name: "" }); load(key);
  };
  const exportCsv = () => {
    const cols = ["id", "type", "date", "by", "title", "priority", "assignee", "details", "version", "deployed", "status", "closed"];
    const csv = [cols.join(","), ...tickets.map((t) => cols.map((c) => '"' + String(c === "assignee" ? anames(t.assignees) : t[c] || "").replace(/"/g, '""') + '"').join(","))].join("\n");
    const projectSlug = (activeProject?.name || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = projectSlug + "-tickets.csv"; a.click();
  };
  const dt = tickets.find((t) => t.id === detail);
  const uploadFile = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f); fd.append("cat", CATS[fc]);
    const r = await api("upload", fd, key, projectId);
    if (!r.ok) alert(r.error || "Upload failed");
    e.target.value = ""; load(key);
  };
  const saveAcct = async (e, pw) => {
    e.preventDefault(); setAmsg("");
    if (pw && acct.password !== acct.confirm) return setAmsg("Passwords do not match");
    const r = await api("account", pw ? { current: acct.current, password: acct.password } : { name: acct.name, phone: acct.phone }, key, projectId);
    if (!r.ok) return setAmsg(r.error || "Failed");
    setAmsg(pw ? "Password changed" : "Profile saved"); load(key);
  };
  const adm = async (p, body) => { const r = await api(p, body, key, projectId); if (!r.ok) return alert(r.error || "Action failed"); load(key); };
  const refreshMeetings = async (month = monthKey(meetingMonth)) => {
    const r = await api("meetings?month=" + month, null, key, projectId);
    if (!r.ok) { setMeetingError(r.error || "Unable to load meetings"); return; }
    setMeetings(r.meetings || []);
  };
  const createMeeting = async (e) => {
    e.preventDefault(); setMeetingError(""); setMeetingNotice(""); setMeetingBusy(true);
    try {
      const r = await api("meetings", { action: "create", ...meetingForm, duration: Number(meetingForm.duration), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }, key, projectId);
      if (!r.ok) { setMeetingError(r.error || "Could not create meeting"); return; }
      setMeetingFormOpen(false);
      setMeetingMonth(new Date(meetingForm.date + "T00:00:00"));
      setMeetingSelected({ ...r.meeting, occurrenceDate: meetingForm.date });
      setMeetingDraft("");
      const savedCards = meetingCards(r.meeting, members);
      setParticipantSummaries(savedCards);
      setSelectedMeetingMemberId(savedCards[0]?.memberId || "");
      setMeetingCardView("selected");
      if (r.inviteEmailsSent < r.inviteEmailsTotal) setMeetingError(`Meeting scheduled, but invitation emails were delivered to ${r.inviteEmailsSent} of ${r.inviteEmailsTotal} invitees. ${r.emailErrors?.[0] || "Check the server email configuration."}`);
      else if (r.inviteEmailsTotal) setMeetingNotice(`Meeting scheduled. Invitation emails sent to ${r.inviteEmailsSent} team member(s).`);
      await refreshMeetings(meetingForm.date.slice(0, 7));
    } catch (error) { setMeetingError(error.message || "Could not create meeting"); }
    finally { setMeetingBusy(false); }
  };
  const connectGoogleCalendar = async () => {
    setMeetingError("");
    const result = await api("google-meet", { action: "connect" }, key, projectId);
    if (!result.ok || !result.authorizationUrl) {
      setMeetingError(result.error || "Could not start Google Calendar connection.");
      return;
    }
    window.location.assign(result.authorizationUrl);
  };
  const disconnectGoogleCalendar = async () => {
    const result = await api("google-meet", { action: "disconnect" }, key, projectId);
    if (!result.ok) {
      setMeetingError(result.error || "Could not disconnect Google Calendar.");
      return;
    }
    setGoogleCalendarConnected(false);
    setGoogleCalendarEmail("");
    setMeetingNotice("Google Calendar disconnected.");
  };
  const saveMeetingNotes = async () => {
    if (!meetingSelected || !canEditMeetingContent) return;
    setMeetingError(""); setMeetingNotice(""); setMeetingBusy(true);
    try {
      const r = await api("meetings", { action: "notes", id: meetingSelected.id, occurrenceDate: meetingSelected.occurrenceDate, notes: meetingDraft, participantSummaries }, key, projectId);
      if (!r.ok) { setMeetingError(r.error || "Could not save meeting notes"); return; }
      const saved = { ...meetingSelected, notes: meetingDraft, participantSummaries };
      setMeetingSelected(saved);
      setMeetings((items) => items.map((item) => item.id === saved.id && item.occurrenceDate === saved.occurrenceDate ? saved : item));
      const emailFailures = (r.summaryEmailsFailed || 0) + (r.taskEmailsFailed || 0);
      setMeetingError(emailFailures ? `Notes were saved to the monthly Meeting Notes list, but ${emailFailures} summary or task assignment email(s) failed. ${r.emailErrors?.[0] || "Check the server email configuration."}` : "");
      const emailSent = (r.summaryEmailsSent || 0) + (r.taskEmailsSent || 0);
      setMeetingNotice(emailFailures ? "" : `Notes saved to the monthly Meeting Notes list.${emailSent ? ` ${emailSent} summary or task email(s) sent.` : ""}`);
    } catch (error) { setMeetingError(error.message || "Could not save meeting notes"); }
    finally { setMeetingBusy(false); }
  };
  const deleteMeeting = async (meeting) => {
    if (!confirm("Delete this meeting" + (meeting.weekly ? " series" : "") + "?")) return;
    const r = await api("meetings", { action: "delete", id: meeting.id }, key, projectId);
    if (!r.ok) { setMeetingError(r.error || "Could not delete meeting"); return; }
    setMeetingSelected(null); setMeetingDraft(""); await refreshMeetings();
  };
  const runRecordingClock = (recorder) => {
    clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = setInterval(() => {
      setRecordingSeconds((seconds) => {
        if (seconds + 1 >= 3600) {
          clearInterval(recordingTimerRef.current);
          if (recorder.state !== "inactive") recorder.stop();
          return 3600;
        }
        return seconds + 1;
      });
    }, 1000);
  };
  const startMeetingRecording = async () => {
    if (!recordingSaved && recordingClips.length >= 20) {
      setMeetingVoiceError("A single recording note can contain up to 20 clips. Save or cancel this recording set before starting another.");
      return;
    }
    setMeetingVoiceError("");
    setMeetingError("");
    setFailedRecording(null);
    if (recordingSaved) {
      recordingClips.forEach((clip) => URL.revokeObjectURL(clip.url));
      setRecordingClips([]);
      setRecordingTranscript("");
      setRecordingCards([]);
      setRecordingSaved(false);
      setRecordingNoteId("");
    }
    if (!window.isSecureContext) {
      setMeetingVoiceError("Microphone recording requires a secure connection (HTTPS). Open the portal using HTTPS, or use localhost for local development.");
      return;
    }
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (policy?.allowsFeature && !policy.allowsFeature("microphone")) {
      setMeetingVoiceError("This page is not allowed to use the microphone. The site must allow microphone access in its Permissions-Policy.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMeetingVoiceError("Audio recording is not supported by this browser. Use an up-to-date browser such as Chrome or Edge.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      recordingStreamRef.current = stream;
      const cleanup = () => {
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        recordingStreamRef.current = null;
      };
      const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 48000 }), chunks = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => {
        clearInterval(recordingTimerRef.current);
        cleanup();
        setRecordingState("idle"); setMeetingVoiceError("The browser could not record audio. Please try again.");
      };
      recorder.onstop = async () => {
        clearInterval(recordingTimerRef.current);
        cleanup();
        const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (!audio.size) { setRecordingState("idle"); setMeetingVoiceError("No audio was recorded."); return; }
        const clip = { id: crypto.randomUUID(), audio, url: URL.createObjectURL(audio), transcript: "" };
        setRecordingClips((clips) => [...clips, clip]);
        setHasRecordedVoiceNote(true);
        setFailedRecording(null);
        setRecordingState("transcribing"); setTranscriptionProgress("Preparing on-device transcription…"); setMeetingVoiceError("");
        setPendingRecording(audio);
      };
      if (recordingSaved || !recordingClips.length) recordingNotesStartRef.current = meetingDraft;
      recorder.start(1000); setRecordingSeconds(0); setRecordingState("recording");
      runRecordingClock(recorder);
    } catch (error) {
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      const message = error.name === "NotAllowedError"
        ? "Microphone access was blocked. Allow microphone access for this site in your browser's address-bar settings, then try again. If the page is embedded, its host must also grant microphone access."
        : error.name === "NotFoundError"
          ? "No microphone was found. Connect or enable a microphone, then try again."
          : error.name === "NotReadableError"
            ? "The microphone is busy or unavailable. Close other apps using it and try again."
            : error.message || "Unable to start audio recording.";
      setMeetingVoiceError(message);
      setRecordingState("idle");
    }
  };
  const pauseMeetingRecording = () => {
    if (recorderRef.current?.state !== "recording") return;
    recorderRef.current.pause();
    clearInterval(recordingTimerRef.current);
    setRecordingState("paused");
  };
  const resumeMeetingRecording = () => {
    if (recorderRef.current?.state !== "paused") return;
    recorderRef.current.resume();
    setRecordingState("recording");
    runRecordingClock(recorderRef.current);
  };
  const stopMeetingRecording = () => {
    if (!recorderRef.current || recorderRef.current.state === "inactive") return;
    clearInterval(recordingTimerRef.current);
    recorderRef.current.stop();
  };
  const onTranscriptionComplete = useCallback((text) => {
    const attendees = meetingVoiceAttendees(members, me);
    const correctedText = correctTurnNames(text, attendees);
    setMeetingVoiceError("");
    setRecordingTranscript((transcript) => transcript ? `${transcript}\n\n${correctedText}` : correctedText);
    const keyPoints = generateEnglishKeyPoints(correctedText);
    if (keyPoints) setMeetingDraft((notes) => notes.trim() ? `${notes.trimEnd()}\n\n${keyPoints}` : keyPoints);
    const cards = generateMeetingParticipantCards(correctedText, attendees, selectedMeetingMemberId);
    if (cards.length) {
      setParticipantSummaries((previous) => mergeVoiceCards(previous, cards));
      setSelectedMeetingMemberId(cards[0].memberId);
      setMeetingCardView("selected");
    }
    setRecordingCards((previous) => {
      const merged = new Map(previous.map((card) => [card.memberId, card]));
      cards.forEach((card) => {
        const earlier = merged.get(card.memberId) || { ...card, points: [], tasks: [], priority: "Medium" };
        merged.set(card.memberId, {
          ...card,
          points: [...new Set([...earlier.points, ...card.points])].slice(0, 20),
          tasks: [...new Set([...earlier.tasks, ...card.tasks])].slice(0, 30),
          priority: earlier.priority || "Medium",
        });
      });
      return [...merged.values()];
    });
    setRecordingClips((clips) => clips.map((clip) => clip.audio === pendingRecording ? { ...clip, transcript: correctedText } : clip));
    if (!cards.length) {
      setMeetingVoiceError("");
      setMeetingNotice("Transcript added to shared meeting notes. Say a team member's name or select their card before recording to route spoken updates into their fields.");
    }
    setRecordingState("idle");
    setTranscriptionProgress("");
    setFailedRecording(null);
    setPendingRecording(null);
  }, [key, meetingSelected, pendingRecording, projectId, members, me, selectedMeetingMemberId]);
  const onTranscriptionError = useCallback((message) => {
    setMeetingVoiceError(message);
    setRecordingState("idle");
    setTranscriptionProgress("");
    setFailedRecording(pendingRecording);
    setPendingRecording(null);
  }, [pendingRecording]);
  const retryLastTranscription = () => {
    if (!failedRecording) return;
    setMeetingVoiceError("");
    setFailedRecording(null);
    setTranscriptionProgress("Retrying on-device transcription…");
    setRecordingState("transcribing");
    setPendingRecording(failedRecording);
  };
  const shareParticipantSummary = async (card) => {
    if (!meetingSelected || !canEditMeetingContent || sharingParticipantIds.includes(card.memberId)) return;
    setMeetingError(""); setMeetingNotice("");
    setSharingParticipantIds((ids) => [...ids, card.memberId]);
    try {
      const result = await api("meetings", {
        action: "participant-summary",
        id: meetingSelected.id,
        occurrenceDate: meetingSelected.occurrenceDate || meetingSelected.date,
        memberId: card.memberId,
        points: card.points,
        tasks: card.tasks,
        priority: card.priority || "Medium",
      }, key, projectId);
      if (!result.ok) {
        setMeetingError(`Could not share ${card.name}'s notes: ${result.error || "email delivery failed"}`);
        return;
      }
      if (result.sent) {
        const sharedCard = { ...card, points: [...card.points], tasks: [...card.tasks] };
        const summaries = [...(meetingSelected.participantSummaries || []).filter((item) => item.memberId !== card.memberId), sharedCard];
        setMeetingSelected((selected) => selected ? { ...selected, participantSummaries: summaries } : selected);
        setParticipantSummaries(summaries);
        setSelectedMeetingMemberId(card.memberId);
        setMeetings((items) => items.map((item) => item.id === meetingSelected.id && item.occurrenceDate === (meetingSelected.occurrenceDate || meetingSelected.date)
          ? { ...item, participantSummaries: summaries }
          : item));
        setMeetingNotice(`${card.name}'s reviewed meeting notes were emailed directly to them.`);
      } else {
        setMeetingNotice(`${card.name}'s current notes were already shared.`);
      }
    } finally {
      setSharingParticipantIds((ids) => ids.filter((id) => id !== card.memberId));
    }
  };
  const cancelRecordingNotes = () => {
    recordingClips.forEach((clip) => URL.revokeObjectURL(clip.url));
    if (recordingNotesStartRef.current !== null) setMeetingDraft(recordingNotesStartRef.current);
    recordingNotesStartRef.current = null;
    setRecordingClips([]);
    setRecordingTranscript("");
    setRecordingCards([]);
    setRecordingSaved(false);
    setRecordingNoteId("");
    setFailedRecording(null);
    setPendingRecording(null);
    setMeetingVoiceError("");
    setMeetingError("");
    setMeetingNotice("Unsaved recording notes were discarded. You can start a new recording.");
  };
  const saveRecordingAsNote = async () => {
    if (!meetingSelected || !canEditMeetingContent || !recordingTranscript.trim()) return;
    setMeetingError(""); setMeetingNotice(""); setMeetingBusy(true);
    try {
      let noteId = recordingNoteId;
      let result = { summaryEmailsFailed: 0, taskEmailsFailed: 0, summaryEmailsSent: 0, taskEmailsSent: 0 };
      if (!noteId) {
        const summary = generateEnglishKeyPoints(recordingTranscript);
        const cards = recordingCards.map((card) => ({ ...card, points: card.points || [], tasks: card.tasks || [] }));
        const tasks = cards.flatMap((card) => card.tasks.map((title) => ({
          id: crypto.randomUUID(), title, description: (card.description || "").slice(0, 2000), assigneeId: card.memberId, dueDate: "", status: "Open", comments: [], priority: card.priority || "Medium",
        })));
        result = await api("meeting-notes", {
          action: "create", meetingId: meetingSelected.id, date: meetingSelected.occurrenceDate || meetingSelected.date,
          title: meetingSelected.title + " · recording notes", summary, transcript: recordingTranscript,
          participantSummaries: cards, tasks,
        }, key, projectId);
        if (!result.ok) { setMeetingError(result.error || "Could not save recording notes"); return; }
        noteId = result.note.id;
        setRecordingNoteId(noteId);
      }
      for (const [clipIndex, clip] of recordingClips.entries()) {
        const formData = new FormData();
        formData.append("noteId", noteId);
        formData.append("clipIndex", String(clipIndex));
        formData.append("file", clip.audio, `meeting-recording-${clipIndex + 1}.webm`);
        const upload = await api("meeting-recording", formData, key, projectId);
        if (!upload.ok) {
          setMeetingNotice(`Notes saved, but recording clip ${clipIndex + 1} could not be uploaded: ` + (upload.error || "Unknown error"));
          return;
        }
      }
      setRecordingSaved(true);
      const emailFailures = (result.summaryEmailsFailed || 0) + (result.taskEmailsFailed || 0);
      if (emailFailures) {
        setMeetingError(`Recording notes saved, but ${emailFailures} member summary or task assignment email(s) failed. ${result.emailErrors?.[0] || "Check the configured email provider."}`);
      } else {
        const sent = (result.summaryEmailsSent || 0) + (result.taskEmailsSent || 0);
        setMeetingNotice(`Recording notes saved as one monthly entry with ${recordingClips.length} clip(s).${sent ? ` Member summary or task emails sent: ${sent}.` : " No member-specific email was generated."}`);
      }
    } catch (error) { setMeetingError(error.message || "Could not save recording notes"); }
    finally { setMeetingBusy(false); }
  };
  const createProject = async (e) => {
    e.preventDefault();
    const r = await api("project", { name: projectName, organizationId: projectOrganizationId || activeOrganization?.id }, key, projectId);
    if (!r.ok) return alert(r.error || "Could not create project");
    setProjectModal(false); setProjectName(""); setView("all"); load(key, r.project.id);
  };
  const createOrganization = async (e) => {
    e.preventDefault();
    const result = await api("organization", { name: organizationName }, key, projectId);
    if (!result.ok) return alert(result.error || "Could not create company");
    setOrganizations((items) => [...items.filter((item) => item.id !== result.organization.id), result.organization]);
    setProjectOrganizationId(result.organization.id);
    setOrganizationName("");
    setOrganizationModal(false);
    setProjectName("");
    setProjectModal(true);
    load(key, projectId);
  };
  const requestMeetingEditAccess = async () => {
    setMeetingError(""); setMeetingNotice("");
    const result = await api("meeting-notes", { action: "request-edit-access" }, key, projectId);
    if (!result.ok) { setMeetingError(result.error || "Could not request temporary edit access"); return; }
    if (result.canEdit) setMeetingEditAccess(true);
    if (result.request) setMeetingEditRequests((requests) => [...requests.filter((item) => item.id !== result.request.id), result.request]);
    setMeetingNotice(result.canEdit
      ? "Your one-hour meeting edit access is active."
      : `One-hour access request sent. Admin email notifications sent: ${result.adminNotificationsSent || 0}${result.adminNotificationsFailed ? `; email failed: ${result.emailErrors?.[0] || "check server email settings"}` : ""}. Pending requests also appear on the admin dashboard.`);
  };
  const reviewMeetingEditRequest = async (requestId, decision) => {
    const result = await api("meeting-notes", { action: "review-edit-access", requestId, decision }, key, projectId);
    if (!result.ok) { setDashboardNotice(result.error || "Could not review access request"); return; }
    setMeetingEditRequests((requests) => requests.map((item) => item.id === requestId ? result.request : item));
    setDashboardNotice(decision === "approve" ? `${result.request.memberName} has meeting edit access for one hour.` : `Edit request from ${result.request.memberName} was denied.`);
  };
  const sendInvite = async (e) => {
    e.preventDefault();
    const r = await api("invite", { email: form.email, role: form.role }, key, projectId);
    setMsg(r.error ? r.error : r.sent ? "Invitation to " + activeProject?.name + " emailed to " + form.email : (r.emailError || "Email could not be sent.") + " Copy the project invitation link: " + r.link);
    setForm({ ...form, email: "" }); load(key);
  };
  const f = (k) => ({ value: modal[k] || "", onChange: (e) => setModal({ ...modal, [k]: e.target.value }) });
  const anames = (ids) => members.filter((m) => (ids || []).includes(m.id)).map((m) => m.name).join(", ") || "Unassigned";
  const aN = aa ? " - " + ((members.find((m) => m.id === aa) || {}).name || "") : "";
  const fh = (a) => a.url || fl(a);
  const fl = (a) => "/api/file?f=" + a.id + "&n=" + encodeURIComponent(a.name) + "&key=" + key + "&project=" + encodeURIComponent(projectId);
  const selectMeetingMember = (memberId) => {
    const member = members.find((item) => item.id === memberId && item.status === "active" && item.role !== "Client");
    if (!member) return;
    setParticipantSummaries((items) => items.some((item) => item.memberId === memberId)
      ? items
      : [...items, { memberId, name: member.name, points: [], tasks: [], description: "", priority: "Medium" }]);
    setSelectedMeetingMemberId(memberId);
    setMeetingCardView("selected");
  };
  const updateRecordingCard = (card, changes) => {
    const updated = { ...card, ...changes };
    setRecordingCards((items) => items.map((item) => item.memberId === card.memberId ? updated : item));
    setParticipantSummaries((items) => mergeVoiceCards(items, [updated]));
    setSelectedMeetingMemberId(card.memberId);
  };
  const moveMeetingMember = (direction) => {
    const eligible = members.filter((member) => member.status === "active" && member.role !== "Client");
    if (!eligible.length) return;
    const currentIndex = eligible.findIndex((member) => member.id === selectedMeetingMemberId);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + eligible.length) % eligible.length;
    selectMeetingMember(eligible[nextIndex].id);
  };

  const L = (k) => ({ value: lf[k], onChange: (e) => setLf({ ...lf, [k]: e.target.value }) });
  const A = (k) => ({ value: (acct || {})[k] || "", onChange: (e) => setAcct({ ...acct, [k]: e.target.value }) });
  if (screen !== "app") return (
    <div className="gate"><div className="modal">
      <div className="brand dk"><span className="brand-mark"><img src="/loopdesk-mark.svg" alt="" /></span><div><b>LoopDesk</b><small>Team &amp; project management</small></div></div>
      {screen === "loading" && <p>Loading...</p>}
      {screen === "denied" && <p>This invitation is invalid or has expired. Please ask an admin for a new one.</p>}
      {screen === "login" && (<form onSubmit={(e) => { e.preventDefault(); join("login", { id: lf.id, password: lf.password }); }}><h2>Sign in</h2>
        <div className="g"><label className="full">Email or phone number<input required autoComplete="username" {...L("id")} /></label>
          <label className="full">Password<input required type="password" autoComplete="current-password" {...L("password")} /></label></div>
        <div className="acts end"><button type="button" className="ic" onClick={() => { setMsg(""); setScreen("forgot"); }}>Forgot password?</button><button className="btn">Sign in</button></div></form>)}
      {screen === "forgot" && (<form onSubmit={async (e) => { e.preventDefault(); await api("forgot", { id: lf.id }); setMsg("If an account exists for that email or phone, a reset link has been sent."); }}><h2>Forgot password</h2>
        <div className="g"><label className="full">Email or phone number<input required {...L("id")} /></label></div>
        <div className="acts end"><button type="button" className="ic" onClick={() => { setMsg(""); setScreen("login"); }}>Back to sign in</button><button className="btn">Send reset link</button></div></form>)}
      {screen === "reset" && (<form onSubmit={async (e) => { e.preventDefault(); const r = await api("reset", { token: new URLSearchParams(location.search).get("reset"), password: lf.password }); if (!r.ok) return setMsg(r.error || "Failed"); history.replaceState(null, "", "/"); setLf({ ...lf, password: "" }); setMsg("Password updated. Please sign in."); setScreen("login"); }}><h2>Set a new password</h2>
        <div className="g"><label className="full">New password (8+ characters, letter and number)<input required type="password" minLength={8} autoComplete="new-password" {...L("password")} /></label></div>
        <div className="acts end"><button className="btn">Update password</button></div></form>)}
      {screen === "setup" && <p>No admin account exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in the .env.local file, restart the server, then sign in.</p>}
      {screen === "accept" && inv && (<form onSubmit={acceptInvite}><h2>Join {inv.projectName} as {inv.role}</h2><p>{inv.email}</p>
        <div className="g">{inv.existing ? <label className="full">Enter your existing account password<input required type="password" autoComplete="current-password" value={invPassword} onChange={(e) => setInvPassword(e.target.value)} /></label> : <>
          <label className="full">Your name<input required {...L("name")} /></label>
          <label className="full">Create password (8+ characters, letter and number)<input required type="password" minLength={8} autoComplete="new-password" {...L("password")} /></label></>}
        </div>
        {msg && <p className="err">{msg}</p>}
        <div className="acts end"><button className="btn">{inv.existing ? "Join project" : "Create account and join"}</button></div></form>)}
      {msg && <p className="err">{msg}</p>}
    </div></div>
  );

  const nav = client ? [["portal", "My Tickets"], ...(canUseMeetings ? [["meetings", "Meetings"]] : [])] : [["all", "Dashboard"], ["issue", "Issues"], ["feature", "Features"], ["files", "Attachments"], ["team", "Team"], ...(canUseMeetings ? [["meetings", "Meetings"], ["meeting-notes", "Meeting Notes"]] : []), ...(admin ? [["activity", "Activity"]] : [])];
  const counts = {}; rows.forEach((t) => { const m = (t.date || "").slice(0, 7); counts[m] = (counts[m] || 0) + 1; });
  const firstOfMonth = new Date(meetingMonth.getFullYear(), meetingMonth.getMonth(), 1);
  const calendarStart = new Date(firstOfMonth); calendarStart.setDate(firstOfMonth.getDate() - ((firstOfMonth.getDay() + 6) % 7));
  const calendarDates = Array.from({ length: 42 }, (_, i) => { const date = new Date(calendarStart); date.setDate(calendarStart.getDate() + i); return date; });
  let last = null;
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><span className="brand-mark"><img src="/loopdesk-mark.svg" alt="" /></span><div><b>LoopDesk</b><small>Team &amp; project management</small></div></div>
        <div className="project-picker">
          <label htmlFor="organization-select">COMPANY</label>
          <select id="organization-select" value={activeOrganization?.id || ""} onChange={(event) => {
            if (event.target.value === "__add_company__") { setOrganizationName(""); setOrganizationModal(true); return; }
            const nextProject = projects.find((item) => item.organizationId === event.target.value);
            if (nextProject) { setProjectId(nextProject.id); setMeetingSelected(null); setMeetingDraft(""); setParticipantSummaries([]); setView(client ? "portal" : "all"); setModal(null); setDetail(null); load(key, nextProject.id); }
          }}>
            {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
            {admin && <option value="__add_company__">＋ Add company…</option>}
          </select>
          <label htmlFor="project-select">PROJECT</label>
          <select id="project-select" value={projectId} onChange={(e) => {
            if (e.target.value === "__add_project__") { setProjectName(""); setProjectOrganizationId(activeOrganization?.id || organizations.find((item) => item.canCreateProject)?.id || ""); setProjectModal(true); return; }
            const id = e.target.value;
            setProjectId(id); setMeetingSelected(null); setMeetingDraft(""); setParticipantSummaries([]); setView(client ? "portal" : "all"); setModal(null); setDetail(null); load(key, id);
          }}>
            {projects.filter((item) => item.organizationId === activeOrganization?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            {organizations.some((item) => item.id === activeOrganization?.id && item.canCreateProject) && <option value="__add_project__">＋ Add project…</option>}
          </select>
        </div>
        {nav.map(([k, l]) => (<button key={k} className={"nav " + (view === k ? "on" : "")} onClick={() => {
          if (k === "meetings" && view !== "meetings" && recordingState === "idle") {
            setMeetingSelected(null); setMeetingDraft(""); setParticipantSummaries([]); setSelectedMeetingMemberId("");
            setRecordingTranscript(""); setRecordingCards([]); setRecordingNoteId(""); setRecordingSaved(false); setMeetingError(""); setMeetingNotice("");
          }
          setView(k);
        }}>{l}{k !== "meeting-notes" && <em>{k === "files" ? files.length : k === "activity" ? audit.length : k === "team" ? members.length : k === "meetings" ? meetings.length : tickets.filter((t) => k === "all" || k === "portal" || t.type === k).length}</em>}</button>))}
        {!client && <button className="nav ghost" onClick={exportCsv}>Export CSV</button>}
        <button className={"nav ghost " + (view === "account" ? "on" : "")} onClick={() => { setAmsg(""); setView("account"); }}>My account</button>
        <button className="nav ghost" onClick={async () => { await api("logout", {}, key); localStorage.removeItem("rw-key"); location.reload(); }}>Sign out</button>
      </aside>
      <main className="main">
        <header className="top">
          <div><h1>{{ all: "Support Dashboard", issue: "Issues Log", feature: "Features Log", team: "Team & Roles", meetings: "Meeting Calendar", "meeting-notes": "Meeting Notes & Tasks", activity: "Activity Log", files: "Attachments", account: "My Account", portal: "My Tickets" }[view]}</h1><p><b>{activeOrganization?.name}</b> · <b>{activeProject?.name}</b> · Signed in as <b>{me.name}</b> <span className={"pill r" + me.role}>{me.role}</span></p></div>
          {!["team", "activity", "files", "account", "meetings", "meeting-notes"].includes(view) && <div className="acts"><button className="btn alt" onClick={() => setModal(blank("feature"))}>+ New Feature</button><button className="btn" onClick={() => setModal(blank("issue"))}>+ New Issue</button></div>}
        </header>

        {view === "all" && admin && <section className="panel dashboard-access-notifications">
          <div className="dashboard-access-heading"><div><h2>Meeting edit approvals</h2><p>Temporary edit access requests for this project.</p></div><span>{meetingEditRequests.filter((item) => item.projectId === projectId && item.status === "pending").length} pending</span></div>
          {dashboardNotice && <div className="meeting-success" role="status">{dashboardNotice}</div>}
          {meetingEditRequests.filter((item) => item.projectId === projectId && item.status === "pending").length
            ? meetingEditRequests.filter((item) => item.projectId === projectId && item.status === "pending").map((item) => <article key={item.id}>
              <div><b>{item.memberName}</b><span>Requested {new Date(item.requestedAt).toLocaleString()} · meeting cards and notes · 1 hour</span></div>
              <div><button type="button" className="btn" onClick={() => reviewMeetingEditRequest(item.id, "approve")}>Approve 1 hour</button><button type="button" className="btn alt" onClick={() => reviewMeetingEditRequest(item.id, "deny")}>Deny</button></div>
            </article>)
            : <p className="meeting-empty">No pending meeting edit requests.</p>}
        </section>}

        {view === "meetings" ? (<section className="meeting-page">
          <div className="meeting-hero">
            <div><span className="meeting-eyebrow">TEAM WORKSPACE</span><h2>One place for every team meeting</h2><p>Plan shared meetings, capture decisions, and keep follow-ups in one place across all projects.</p></div>
            <div className="meeting-hero-badge"><b>{meetings.length}</b><span>{meetings.length === 1 ? "meeting this month" : "meetings this month"}</span></div>
          </div>
          <div className="panel">
            <div className="meeting-toolbar">
              <div className="meeting-month"><button className="btn alt" aria-label="Previous month" onClick={() => setMeetingMonth(new Date(meetingMonth.getFullYear(), meetingMonth.getMonth() - 1, 1))}>‹</button><h2>{meetingMonth.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h2><button className="btn alt" aria-label="Next month" onClick={() => setMeetingMonth(new Date(meetingMonth.getFullYear(), meetingMonth.getMonth() + 1, 1))}>›</button><button className="btn alt meeting-today" onClick={() => setMeetingMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</button></div>
              <button className="btn" onClick={() => { setMeetingError(""); setMeetingForm({ title: "Team meeting", date: today(), time: "10:00", duration: "60", agenda: "", online: true, roomProvider: "google-meet", roomUrl: "", attendeeIds: [] }); setMeetingFormOpen((open) => !open); }}>+ Schedule meeting</button>
            </div>
            {meetingError && <div className="meeting-alert" role="alert"><b>Action needed</b><span>{meetingError}</span></div>}
            {meetingNotice && <div className="meeting-success" role="status">{meetingNotice}</div>}
            {meetingFormOpen && <form className="meeting-create" onSubmit={createMeeting}>
              <h3>Schedule a team meeting</h3>
              <div className="meeting-form-grid">
                <label>Meeting title<input required maxLength={120} value={meetingForm.title} onChange={(e) => setMeetingForm({ ...meetingForm, title: e.target.value })} /></label>
                <label>Date<input required type="date" value={meetingForm.date} onChange={(e) => setMeetingForm({ ...meetingForm, date: e.target.value })} /></label>
                <label>Start time<input required type="time" value={meetingForm.time} onChange={(e) => setMeetingForm({ ...meetingForm, time: e.target.value })} /></label>
                <label>Duration (minutes)<input required type="number" min="15" max="60" step="15" value={meetingForm.duration} onChange={(e) => setMeetingForm({ ...meetingForm, duration: e.target.value })} /></label>
                <label className="meeting-weekly"><input type="checkbox" checked={meetingForm.online} onChange={(e) => setMeetingForm({ ...meetingForm, online: e.target.checked })} /> Online meeting</label>
                {meetingForm.online && <>
                  <label>Conference service<select value={meetingForm.roomProvider} onChange={(e) => setMeetingForm({ ...meetingForm, roomProvider: e.target.value, roomUrl: "" })}><option value="google-meet">Google Meet</option><option value="zoom">Zoom</option></select></label>
                  {meetingForm.roomProvider === "google-meet" ? <div className="meeting-provider-actions">
                    {canManageMeetings && googleCalendarConnected
                      ? <span className="meeting-google-status">Connected to Google Calendar{googleCalendarEmail ? ` · ${googleCalendarEmail}` : ""}</span>
                      : canManageMeetings && googleCalendarConfigured
                        ? <button type="button" className="btn alt" onClick={connectGoogleCalendar}>Connect Google Calendar</button>
                        : canManageMeetings
                          ? <span className="meeting-invite-hint">Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server to enable Meet room creation.</span>
                          : <span className="meeting-invite-hint">A project admin must connect Google Calendar to create Meet rooms automatically.</span>}
                    {canManageMeetings && googleCalendarConnected && <button type="button" className="btn alt" onClick={disconnectGoogleCalendar}>Disconnect</button>}
                    {!googleCalendarConnected && <label className="meeting-agenda">Existing Google Meet link (optional)<input type="url" placeholder="Paste an existing Meet link if not connecting Google Calendar" value={meetingForm.roomUrl} onChange={(e) => setMeetingForm({ ...meetingForm, roomUrl: e.target.value })} /></label>}
                  </div> : <div className="meeting-provider-actions">
                    <a className="btn alt" href={conferenceLaunchUrl("zoom")} target="_blank" rel="noreferrer">Open Zoom</a>
                    <label className="meeting-agenda">Shared join link (needed in invite emails)<input type="url" placeholder="Paste the Zoom invite link" value={meetingForm.roomUrl} onChange={(e) => setMeetingForm({ ...meetingForm, roomUrl: e.target.value })} /></label>
                  </div>}
                </>}
                <fieldset className="meeting-invitees">
                  <legend>Invite team members</legend>
                  {members.filter((member) => member.status === "active" && member.role !== "Client").map((member) => (
                    <label key={member.id}><input type="checkbox" checked={meetingForm.attendeeIds.includes(member.id)} onChange={(event) => setMeetingForm({
                      ...meetingForm,
                      attendeeIds: event.target.checked
                        ? [...meetingForm.attendeeIds, member.id]
                        : meetingForm.attendeeIds.filter((id) => id !== member.id),
                    })} /> {member.name} <span>{member.email}</span></label>
                  ))}
                  {!members.some((member) => member.status === "active" && member.role !== "Client") && <p>No active team members available to invite.</p>}
                </fieldset>
                <label className="meeting-agenda">Agenda<textarea rows="3" maxLength="3000" value={meetingForm.agenda} onChange={(e) => setMeetingForm({ ...meetingForm, agenda: e.target.value })} placeholder="Topics for the team to discuss" /></label>
              </div>
              <p className="meeting-invite-hint">{meetingForm.online ? meetingForm.roomProvider === "google-meet" ? googleCalendarConnected ? "A Google Meet room and shareable link will be created automatically when you schedule." : "Connect Google Calendar to create a shareable Meet room automatically, or paste a Meet link above. Meetings are limited to 60 minutes." : "Open Zoom, create a meeting there, then paste its shareable invite link. Meetings are limited to 60 minutes." : "This is an in-person meeting; invitees receive the date and time by email. Meetings are limited to 60 minutes."} Recording uses this device's microphone; online-call audio is not captured unless the microphone can hear the room speakers.</p>
              <div className="acts end"><button type="button" className="btn alt" onClick={() => setMeetingFormOpen(false)}>Cancel</button><button className="btn" disabled={meetingBusy}>{meetingBusy ? "Saving…" : "Schedule"}</button></div>
            </form>}
            <div className="meeting-calendar">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <div className="meeting-weekday" key={day}>{day}</div>)}
              {calendarDates.map((date) => {
                const dateKey = localDateKey(date), inMonth = date.getMonth() === meetingMonth.getMonth();
                return <div className={"meeting-day" + (inMonth ? "" : " outside") + (dateKey === localDateKey(new Date()) ? " today" : "")} key={dateKey}>
                  <span className="meeting-day-number">{date.getDate()}</span>
                  {meetings.filter((meeting) => meeting.date === dateKey).map((meeting) => <button disabled={recordingState !== "idle" || (!!recordingClips.length && !recordingSaved)} className={"meeting-event" + (meetingSelected?.id === meeting.id && meetingSelected?.occurrenceDate === meeting.occurrenceDate ? " selected" : "")} key={meeting.id + dateKey} onClick={() => { setMeetingSelected(meeting); setMeetingDraft(meeting.notes || ""); const cards = meetingCards(meeting, members); setParticipantSummaries(cards); setSelectedMeetingMemberId(cards[0]?.memberId || ""); setMeetingCardView("selected"); setRecordingTranscript(""); recordingClips.forEach((clip) => URL.revokeObjectURL(clip.url)); setRecordingClips([]); setRecordingSaved(false); setRecordingNoteId(""); setRecordingCards([]); setConferenceJoined(false); setMeetingError(""); setMeetingNotice(""); setMeetingVoiceError(""); setHasRecordedVoiceNote(false); setRecordingSeconds(0); setFailedRecording(null); }}>
                    <b>{meeting.time}</b> {meeting.title}{meeting.online && <small>Online</small>}
                  </button>)}
                </div>;
              })}
            </div>
            {meetingsLoading && <p className="meeting-empty">Loading calendar…</p>}
            {!meetingsLoading && !meetings.length && <p className="meeting-empty">No meetings scheduled for this month. Schedule a meeting on any date to get started.</p>}
          </div>
          {meetingSelected && <div className="panel meeting-detail">
            {pendingRecording && <LocalTranscriber audio={pendingRecording} language={transcriptionLanguage} onProgress={setTranscriptionProgress} onComplete={onTranscriptionComplete} onError={onTranscriptionError} />}
            <div className="meeting-detail-head"><div><h2>{meetingSelected.title}</h2><p>{fmt(meetingSelected.occurrenceDate)} · {meetingSelected.time} · {meetingSelected.duration} minutes · {activeProject?.name}</p></div>
              {(meetingSelected.createdBy === me.id || canManageMeetings) && <button className="ic dl" onClick={() => deleteMeeting(meetingSelected)}>Delete meeting</button>}
            </div>
            {!canEditMeetingContent && <div className="meeting-access-banner"><div><b>View-only meeting cards</b><span>Only Admins and Collaborators can edit meeting cards and notes. Request a one-hour approval from a project admin; you can still change status on tasks assigned to you in Meeting Notes.</span></div><button type="button" className="btn" disabled={meetingBusy || meetingEditRequests.some((item) => item.projectId === projectId && item.memberId === me.id && item.status === "pending")} onClick={requestMeetingEditAccess}>{meetingEditRequests.some((item) => item.projectId === projectId && item.memberId === me.id && item.status === "pending") ? "Request pending" : "Request 1-hour edit access"}</button></div>}
            {!["Admin", "Collaborator"].includes(me.role) && meetingEditAccess && meetingEditAccessExpiresAt && <div className="meeting-access-banner active"><div><b>Temporary edit access is active</b><span>Expires {new Date(meetingEditAccessExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</span></div></div>}
              {meetingSelected.online && <section className="meeting-room">
                <div className="meeting-room-toolbar"><div><h3>{meetingSelected.roomProvider === "jitsi" ? "Jitsi conference room" : `${meetingSelected.roomProvider === "google-meet" ? "Google Meet" : meetingSelected.roomProvider === "zoom" ? "Zoom" : "Microsoft Teams"} conference`}</h3>{meetingSelected.roomUrl ? <a href={meetingSelected.roomUrl} target="_blank" rel="noreferrer">{meetingSelected.roomUrl}</a> : <span className="meeting-invite-hint">No shared invite link is saved.</span>}</div>
                  {meetingSelected.roomProvider === "jitsi" ? <button className="btn" onClick={() => setConferenceJoined((joined) => !joined)}>{conferenceJoined ? "Close room" : "Join in dashboard"}</button> : <a className="btn" href={meetingSelected.roomUrl || conferenceLaunchUrl(meetingSelected.roomProvider)} target="_blank" rel="noreferrer">{meetingSelected.roomUrl ? "Join meeting" : `Open ${meetingSelected.roomProvider === "google-meet" ? "Google Meet" : meetingSelected.roomProvider === "zoom" ? "Zoom" : "Teams"}`}</a>}
                  {meetingSelected.roomProvider === "jitsi" && <a className="btn alt" href={meetingSelected.roomUrl} target="_blank" rel="noreferrer">Open in new tab</a>}
                </div>
                {conferenceJoined && meetingSelected.roomProvider === "jitsi" && <JitsiMeetingEmbed roomUrl={meetingSelected.roomUrl} title={meetingSelected.title} />}
                <p className="meeting-invite-hint">{meetingSelected.roomProvider === "jitsi" ? "Public Jitsi room: anyone with the link may join, and duration/availability is not guaranteed." : meetingSelected.roomUrl ? "The conference opens in a new tab; meeting duration and recording depend on that provider's account." : "The button opens the conference service, but does not create a shared room or send an invite link. Create the room there and share its join link with invitees."}</p>
              </section>}
            {meetingSelected.agenda && <div className="meeting-agenda-read"><b>Agenda</b><p>{meetingSelected.agenda}</p></div>}
            <div className="meeting-attendee-list"><b>Meeting invitees</b><span>{(meetingSelected.attendees || []).length ? meetingSelected.attendees.map((attendee) => attendee.name).join(", ") : "No invitees selected"} Voice routing recognizes all active team members, including the admin.</span></div>
            {!!recordingClips.length && <div className="meeting-audio-preview"><span>Recording clips ({recordingClips.length})</span><div>{recordingClips.map((clip, index) => <div key={clip.id}><label>Clip {index + 1}</label><audio controls preload="metadata" src={clip.url}>Audio preview unavailable in this browser.</audio></div>)}</div></div>}
            {!!recordingTranscript && <label className="meeting-transcript-review">English transcript (AI-generated; review and correct before sharing)<textarea disabled={!canEditMeetingContent} rows="6" value={recordingTranscript} onChange={(event) => {
              const transcript = event.target.value;
              setRecordingTranscript(transcript);
              const keyPoints = generateEnglishKeyPoints(transcript);
              const baseNotes = recordingNotesStartRef.current || "";
              setMeetingDraft(keyPoints ? (baseNotes.trim() ? `${baseNotes.trimEnd()}\n\n` : "") + keyPoints : baseNotes);
              const suggestions = generateMeetingParticipantCards(transcript, meetingVoiceAttendees(members, me), selectedMeetingMemberId);
              setRecordingCards((previous) => suggestions.map((card) => ({ ...card, priority: previous.find((item) => item.memberId === card.memberId)?.priority || "Medium" })));
              if (suggestions.length) {
                setParticipantSummaries((previous) => mergeVoiceCards(previous, suggestions));
                setSelectedMeetingMemberId(suggestions[0].memberId);
                setMeetingCardView("selected");
              }
            }} /></label>}
            {!!recordingCards.length && <section className="meeting-summary-cards" aria-label="Recording participant notes">
              <h3>Member notes from this recording <small>Check the speaker and correct these AI-generated notes before sharing. Only the card you choose is emailed to that member.</small></h3>
              <div className="meeting-summary-grid">{recordingCards.map((card) => <article className="meeting-summary-card" key={card.memberId}>
                <h4>{card.name}</h4>
                <label>Key points (one per line)<textarea disabled={!canEditMeetingContent} rows="4" value={card.points.join("\n")} onChange={(event) => updateRecordingCard(card, { points: event.target.value.split("\n") })} /></label>
                <label>Priority<select disabled={!canEditMeetingContent} value={card.priority || "Medium"} onChange={(event) => updateRecordingCard(card, { priority: event.target.value })}><option>High</option><option>Medium</option><option>Low</option></select></label>
                <label>Action items (one per line)<textarea disabled={!canEditMeetingContent} rows="3" value={card.tasks.join("\n")} onChange={(event) => updateRecordingCard(card, { tasks: event.target.value.split("\n") })} /></label>
                <button className="btn" disabled={!canEditMeetingContent || meetingBusy || recordingState !== "idle" || sharingParticipantIds.includes(card.memberId) || (!card.points.length && !card.tasks.length)} onClick={() => shareParticipantSummary(card)}>
                  {sharingParticipantIds.includes(card.memberId) ? "Sharing…" : `Share ${card.name}'s notes by email`}
                </button>
              </article>)}</div>
            </section>}
            <section className="meeting-summary-cards" aria-label="Team member updates and upcoming tasks">
              <div className="meeting-cards-heading"><h3>Team task cards <small>Say a member's name to route their update automatically, or click a card before recording to use it as the default. Clicking alone does not add or change any notes.</small></h3>
                <div className="meeting-member-controls">
                  <label>Select team member<select aria-label="Select team member card" value={selectedMeetingMemberId} onChange={(event) => selectMeetingMember(event.target.value)}><option value="">Choose a member…</option>{members.filter((member) => member.status === "active" && member.role !== "Client").map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
                  <button type="button" className="btn alt" onClick={() => moveMeetingMember(-1)} disabled={!members.some((member) => member.status === "active" && member.role !== "Client")}>‹ Previous</button>
                  <button type="button" className="btn alt" onClick={() => moveMeetingMember(1)} disabled={!members.some((member) => member.status === "active" && member.role !== "Client")}>Next member ›</button>
                  <button type="button" className={"btn " + (meetingCardView === "all" ? "" : "alt")} aria-pressed={meetingCardView === "all"} onClick={() => setMeetingCardView((mode) => mode === "all" ? "selected" : "all")}>{meetingCardView === "all" ? "Show selected" : "Show all members"}</button>
                </div>
              </div>
              <div className="meeting-member-picker" aria-label="Choose a member card">{members.filter((member) => member.status === "active" && member.role !== "Client").map((member, index) => {
                const hasCard = participantSummaries.some((card) => card.memberId === member.id);
                return <button type="button" key={member.id} className={"meeting-member-chip" + (selectedMeetingMemberId === member.id ? " selected" : "")} style={{ "--member-accent": MEMBER_CARD_COLORS[index % MEMBER_CARD_COLORS.length] }} aria-pressed={selectedMeetingMemberId === member.id} onClick={() => { selectMeetingMember(member.id); setMeetingCardView("selected"); }}>
                  <span>{member.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><b>{member.name}</b>{hasCard && <small>Notes</small>}
                </button>;
              })}</div>
              <div className={"meeting-summary-grid " + (meetingCardView === "all" ? "all-member-cards" : "single-member-card")}>{participantSummaries.filter((card) => meetingCardView === "all" || card.memberId === selectedMeetingMemberId).map((card) => {
                const memberIndex = members.filter((member) => member.status === "active" && member.role !== "Client").findIndex((member) => member.id === card.memberId);
                const recentWork = tickets.filter((ticket) => (ticket.assignees || []).includes(card.memberId)).sort((a, b) => (b.closed || b.date || "").localeCompare(a.closed || a.date || "")).slice(0, 3);
                return <article className={"meeting-summary-card" + (selectedMeetingMemberId === card.memberId ? " selected-member-card" : "")} key={card.memberId} style={{ "--member-accent": MEMBER_CARD_COLORS[(memberIndex < 0 ? 0 : memberIndex) % MEMBER_CARD_COLORS.length] }} onClick={(event) => {
                  if (meetingCardView === "all" && !event.target.closest("input,textarea,select,button,label")) {
                    setSelectedMeetingMemberId(card.memberId);
                    setMeetingCardView("selected");
                  }
                }}>
                  <h4>{card.name}<span>{members.find((member) => member.id === card.memberId)?.role || "Team member"}</span></h4>
                  <div className="meeting-recent-work"><b>Recent task updates</b>{recentWork.length ? recentWork.map((ticket) => <p key={ticket.id}><span>{ticket.title}</span><em>{ticket.status} · {ticket.closed || ticket.date}</em></p>) : <small>No recent ticket updates.</small>}</div>
                  <label>Previous task update (one per line)<textarea disabled={!canEditMeetingContent || (!["Admin", "Collaborator"].includes(me.role) && card.memberId !== me.id)} rows="3" value={(card.points || []).join("\n")} onChange={(event) => setParticipantSummaries((items) => items.map((item) => item.memberId === card.memberId ? { ...item, points: event.target.value.split("\n") } : item))} placeholder="Summarize progress or blockers from the last task" /></label>
                  <label>Task description / context<textarea disabled={!canEditMeetingContent || (!["Admin", "Collaborator"].includes(me.role) && card.memberId !== me.id)} rows="3" value={card.description || ""} onChange={(event) => setParticipantSummaries((items) => items.map((item) => item.memberId === card.memberId ? { ...item, description: event.target.value } : item))} placeholder="Add notes or context for the assigned task" /></label>
                  <label>Priority for upcoming tasks<select disabled={!canEditMeetingContent || (!["Admin", "Collaborator"].includes(me.role) && card.memberId !== me.id)} value={card.priority || "Medium"} onChange={(event) => setParticipantSummaries((items) => items.map((item) => item.memberId === card.memberId ? { ...item, priority: event.target.value } : item))}><option>High</option><option>Medium</option><option>Low</option></select></label>
                  <label>Next tasks (one per line)<textarea disabled={!canEditMeetingContent || (!["Admin", "Collaborator"].includes(me.role) && card.memberId !== me.id)} rows="3" value={(card.tasks || []).join("\n")} onChange={(event) => setParticipantSummaries((items) => items.map((item) => item.memberId === card.memberId ? { ...item, tasks: event.target.value.split("\n") } : item))} placeholder="Write the next action; details and deadline can be managed in Meeting Notes" /></label>
                </article>;
              })}
                {!selectedMeetingMemberId && <div className="meeting-member-empty"><b>Ready for the next update?</b><span>Select a team member above, or start recording and their turn will be selected when their name is recognized.</span></div>}
              </div>
            </section>
            <label className="meeting-notes-label">Shared meeting notes<textarea disabled={!["Admin", "Collaborator"].includes(me.role)} rows="10" maxLength="20000" value={meetingDraft} onChange={(e) => setMeetingDraft(e.target.value)} placeholder="Capture decisions, action items, and follow-ups here." /></label>
            <div className="meeting-note-tools">
              <label className="meeting-language-setting">Spoken language
                <select value={transcriptionLanguage} onChange={(event) => setTranscriptionLanguage(event.target.value)} disabled={recordingState !== "idle"}>
                  <option value="auto">Auto-detect</option>
                  <option value="english">English</option>
                  <option value="urdu">Urdu / Urdu-English</option>
                </select>
              </label>
              {recordingState === "idle" && !failedRecording && (!recordingNoteId || recordingSaved) && <button className="btn meeting-record-button" disabled={!["Admin", "Collaborator"].includes(me.role)} onClick={startMeetingRecording}>{hasRecordedVoiceNote ? "Record another clip" : "Start microphone recording"}</button>}
              {recordingState === "recording" && <>
                <button className="btn alt meeting-record-button" onClick={pauseMeetingRecording}>Pause</button>
                <button className="btn meeting-record-button recording" onClick={stopMeetingRecording}>Finish & transcribe</button>
              </>}
              {recordingState === "paused" && <>
                <button className="btn meeting-record-button" onClick={resumeMeetingRecording}>Resume recording</button>
                <button className="btn alt meeting-record-button" onClick={stopMeetingRecording}>Finish & transcribe</button>
              </>}
              {recordingState === "transcribing" && <button className="btn meeting-record-button" disabled>Transcribing…</button>}
              {recordingState === "idle" && failedRecording && <button className="btn alt meeting-record-button" disabled={!["Admin", "Collaborator"].includes(me.role)} onClick={retryLastTranscription}>Retry last clip</button>}
              <span className={"meeting-record-status " + recordingState} aria-live="polite">{recordingState === "recording" ? `Recording · ${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")} · max 60 minutes` : recordingState === "paused" ? `Recording paused · ${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}` : recordingState === "transcribing" ? transcriptionProgress || "Translating and preparing English key points…" : "For Urdu-English speech, select Urdu / Urdu-English. Repeated output is retried with a more accurate model. Review the transcript and speaker suggestions before saving."}</span>
              {canEditMeetingContent && (!recordingClips.length || recordingSaved) && <button className="btn" disabled={meetingBusy || recordingState !== "idle"} onClick={saveMeetingNotes}>{meetingBusy ? "Saving…" : "Save notes"}</button>}
            </div>
            {!!recordingClips.length && !recordingSaved && <div className="meeting-record-save"><span>{recordingNoteId ? "The note is saved. Retry to finish uploading its clips." : `${recordingClips.filter((clip) => clip.transcript).length} of ${recordingClips.length} clip(s) transcribed. Add more clips, then save them together as one monthly note. Cancel removes this set's generated text from Shared meeting notes.`}</span><div>{!recordingNoteId && <button className="btn alt" disabled={meetingBusy || recordingState !== "idle"} onClick={cancelRecordingNotes}>Cancel recording notes</button>}{recordingNoteId || (recordingClips.every((clip) => clip.transcript) && recordingTranscript) ? <button className="btn" disabled={!["Admin", "Collaborator"].includes(me.role) || meetingBusy || recordingState !== "idle"} onClick={saveRecordingAsNote}>{meetingBusy ? "Saving…" : "Save recording as note"}</button> : null}</div></div>}
            {meetingVoiceError && <div className="meeting-alert meeting-voice-alert" role="alert"><b>Voice note unavailable</b><span>{meetingVoiceError}</span></div>}
            <p className="meeting-privacy">Whisper Base handles English; Urdu / Urdu-English uses Whisper Small. Unclear or placeholder output is retried with a more careful decode and rejected rather than shown as a confident transcript if still unusable. Edit the transcript and review the individual member cards before sharing. No email is sent automatically from an unreviewed transcript; use the Share button on a member's card to email only that member. Audio remains on this device unless you explicitly save the recording as a monthly note; saved audio is uploaded to the app's configured storage.</p>
          </div>}
        </section>) : view === "meeting-notes" ? <MeetingNotes projectId={projectId} keyValue={key} members={members} canDelete={admin} canManageContent={!!me && ["Admin", "Collaborator"].includes(me.role)} me={me} onAccessChange={handleMeetingAccessChange} /> : view === "portal" ? (<section className="panel"><div className="wrap"><table className="tm"><thead><tr><th>ID</th><th>Ticket</th><th>Type</th><th>Raised</th><th>Status</th><th>Completed</th><th>Actions</th></tr></thead><tbody>
          {[...tickets].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((t) => (<tr key={t.id}>
            <td><b className={"id " + t.type}>{t.id}</b></td><td className="tt">{t.title}</td><td>{t.type === "issue" ? "Issue" : "Feature"}</td><td className="nw">{fmt(t.date)}</td>
            <td><span className={"pill st " + t.status.replace(" ", "")}>{t.status}</span></td><td className="nw">{fmt(t.closed)}</td>
            <td className="ra"><button className="ic" title="View details, solution and attachments" onClick={() => setDetail(t.id)}><Ic d={EYE} /></button>
              {t.status !== "Completed" && <button className="ic" title="Edit" onClick={() => setModal({ ...t })}><Ic d={PEN} /></button>}
              {t.status === "Completed" && <button className="ic" onClick={() => reopen(t)}>Reopen</button>}</td></tr>))}
          {!tickets.length && <tr><td colSpan="7" className="empty">You have not raised any tickets yet. Use the buttons above to raise one.</td></tr>}</tbody></table></div></section>) : view === "account" ? (<section className="acc">
          <div className="panel"><h3>Profile</h3>
            <div className="prof"><span className="av">{me.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span><div><b>{me.name}</b><div className="dd">{me.email}</div><span className={"pill r" + me.role}>{me.role}</span></div></div>
            <form onSubmit={(e) => saveAcct(e, false)}><div className="g">
              <label>Full name<input required {...A("name")} /></label><label>Phone number<input type="tel" {...A("phone")} /></label>
              <label>Email<input disabled value={me.email} /></label><label>Role<input disabled value={me.role} /></label></div>
              <div className="acts end"><button className="btn">Save profile</button></div></form></div>
          <div className="panel"><h3>Security</h3>
            <form onSubmit={(e) => saveAcct(e, true)}><div className="g">
              {me.hasPw && <label className="full">Current password<input required type="password" autoComplete="current-password" {...A("current")} /></label>}
              <label>New password<input required type="password" minLength={8} autoComplete="new-password" {...A("password")} /></label>
              <label>Confirm new password<input required type="password" minLength={8} autoComplete="new-password" {...A("confirm")} /></label></div>
              <p className="note">8+ characters with at least one letter and one number.</p>
              <div className="acts end"><button className="btn">Change password</button></div></form>
            <div className="acts"><button className="btn alt" onClick={async () => { if (confirm("Sign out of all devices?")) { await api("logoutall", {}, key); localStorage.removeItem("rw-key"); location.reload(); } }}>Sign out of all devices</button></div>
            {amsg && <p className="err">{amsg}</p>}</div>
        </section>) : view === "files" ? (<section className="panel">
          <div className="subtabs">{CATS.map((c, i) => (<button key={c} className={"tab " + (fc === i ? "on" : "")} onClick={() => setFc(i)}>{c}<em>{files.filter((x) => x.cat === c).length}</em></button>))}</div>
          <div className="tools up"><input type="file" onChange={uploadFile} /><span className="note">Uploads go to: <b>{CATS[fc]}</b></span></div>
          <div className="tools up"><input placeholder="Or add a document link (Google Drive, Docs...)" value={lk.url} onChange={(e) => setLk({ ...lk, url: e.target.value })} /><input placeholder="Name (optional)" value={lk.name} onChange={(e) => setLk({ ...lk, name: e.target.value })} /><button className="btn alt" onClick={addLink}>Add link</button></div>
          <div className="wrap"><table className="tm"><thead><tr><th>File</th><th>Size</th><th>Uploaded by</th><th>Date</th><th>Ticket</th><th></th></tr></thead><tbody>
            {files.filter((x) => x.cat === CATS[fc]).map((a) => (<tr key={a.id}><td className="tt"><a className="fl" href={fh(a)} target="_blank" rel="noreferrer"><Ic d={CLIP} /> {a.name}</a></td><td className="nw">{a.url ? "Link" : Math.ceil(a.size / 1024) + " KB"}</td><td>{a.by}</td><td className="nw">{fmt(a.at)}</td><td className="nw">{a.ticket || "-"}</td>
              <td className="ra"><a className="ic" href={fh(a)} target="_blank" rel="noreferrer">{a.url ? "Open link" : "Download"}</a>{canEdit && <button className="ic dl" onClick={() => confirm("Delete " + a.name + "?") && adm("filedel", { id: a.id })}><Ic d={TRASH} /></button>}</td></tr>))}
            {!files.some((x) => x.cat === CATS[fc]) && <tr><td colSpan="6" className="empty">No files in this category yet.</td></tr>}</tbody></table></div>
        </section>) : view === "activity" ? (<section className="panel"><div className="wrap"><table className="tm"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr></thead><tbody>
          {audit.map((a, i) => (<tr key={i}><td className="nw">{new Date(a.at).toLocaleString("en-GB")}</td><td>{a.who}</td><td className="tt">{a.act}</td><td>
            {Array.isArray(a.detail) ? <div className="audit-diff">{a.detail.map((change, j) => <div className="audit-change" key={j}>
              <b>{change.field}</b><span className="audit-value old"><small>Old</small>{change.old}</span><span className="audit-value new"><small>New</small>{change.new}</span>
            </div>)}</div> : a.detail}
          </td></tr>))}
          {!audit.length && <tr><td colSpan="4" className="empty">No activity yet.</td></tr>}</tbody></table></div></section>) : view === "team" ? (<>
          {admin && (<section className="panel"><h3>Invite a member to {activeProject?.name}</h3>
            <p className="note">This invitation is for <b>{activeProject?.name}</b> only. Members can have different roles in other projects.</p>
            <form className="tools" onSubmit={sendInvite}>
              <input required type="email" placeholder="Email address" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
              <button className="btn">Send invite</button></form>
            <div className="acts"><button type="button" className="btn alt" onClick={async () => { setMsg("Sending test email..."); const r = await api("testmail", {}, key, projectId); setMsg(r.sent ? "Test email sent to " + r.to + " using " + r.provider + ". Check your inbox (and spam folder)." : "Test email failed: " + (r.error || "unknown error")); }}>Send test email</button></div>
            {msg && <p className="note">{msg}</p>}
            {invites.map((i) => (<div className="inv" key={i.token}><span>{i.email} <em>({i.role} · {activeProject?.name}, pending)</em></span>
              <button className="ic" onClick={() => navigator.clipboard.writeText(location.origin + "/?invite=" + i.token)}>Copy link</button>
              <button className="ic dl" onClick={() => adm("remove", { token: i.token })}>Revoke</button></div>))}
          </section>)}
          <section className="panel"><div className="wrap"><table className="tm"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
            {members.map((m) => (<tr key={m.id}><td className="tt">{m.name}</td><td>{m.email}</td><td>{m.phone || "-"}</td>
              <td><select disabled={!admin || m.id === me.id} value={m.role} onChange={(e) => adm("role", { id: m.id, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></td>
              <td><span className={"pill " + (m.status === "disabled" ? "Low" : "rDeveloper")}>{m.status === "disabled" ? "Disabled" : "Active"}</span></td>
              <td className="ra">{admin && m.id !== me.id && (<>
                <button className="ic" onClick={async () => { const r = await api("adminreset", { id: m.id }, key, projectId); setMsg(r.sent ? "Reset link emailed to " + m.email : (r.emailError || "Email could not be sent.") + " Send this link to " + m.name + ": " + r.link); }}>Reset password</button>
                <button className="ic" onClick={() => adm("status", { id: m.id, disabled: m.status !== "disabled" })}>{m.status === "disabled" ? "Enable" : "Disable"}</button>
                <button className="ic dl" onClick={() => confirm("Remove " + m.name + "?") && adm("remove", { id: m.id })}><Ic d={TRASH} /></button></>)}</td></tr>))}
          </tbody></table></div>
          <p className="note">Roles and team membership apply only to {activeProject?.name} in {activeOrganization?.name}. Admin: full access. Developer: create, edit, assign, change status. Collaborator: create tickets, view and add attachments. For meeting cards, saved meeting notes, and task details, only Admins and Collaborators can edit; other team members can change status on tasks assigned to them or request one-hour admin-approved edit access. Client: sees only tickets they raised in this project; can create, update and reopen them. Nobody can delete a ticket assigned to themselves.</p></section>
        </>) : (<>
          {view === "all" && (<>
            <section className="cards">{stats.map(([l, n, c]) => (<div key={l} className={"card " + c}><span>{l}</span><b>{n}</b></div>))}</section>
            <div className="tools"><b className="note">Analytics for:</b><select value={aa} onChange={(e) => setAa(e.target.value)}><option value="">All team members</option>{members.filter((x) => x.role !== "Client").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
            <section className="charts"><Chart title={"Issues analytics" + aN} list={base.filter((t) => t.type === "issue" && (!aa || (t.assignees || []).includes(aa)))} /><Chart title={"Features analytics" + aN} list={base.filter((t) => t.type === "feature" && (!aa || (t.assignees || []).includes(aa)))} /></section>
          </>)}
          <section className="panel">
            <div className="tools">
              <input placeholder="Search by ID, title, details..." value={q} onChange={(e) => setQ(e.target.value)} />
              <select value={fm} onChange={(e) => setFm(e.target.value)}><option value="">All months</option>{months.map((m) => <option key={m} value={m}>{ml(m)}</option>)}</select>
              <select value={fs} onChange={(e) => setFs(e.target.value)}><option value="">All statuses</option>{STATUS.map((s) => <option key={s}>{s}</option>)}</select>
              <select value={fp} onChange={(e) => setFp(e.target.value)}><option value="">All priorities</option>{PRIO.map((s) => <option key={s}>{s}</option>)}</select>
              <select value={fa} onChange={(e) => setFa(e.target.value)}><option value="">All assignees</option><option value="none">Unassigned</option>{members.filter((x) => x.role !== "Client").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            </div>
            <div className="wrap"><table>
              <thead><tr><th>ID</th><th>Ticket</th><th>Raised</th><th>Priority</th><th>Assignee</th><th>Release</th><th>Status</th><th>Completed</th><th>Actions</th></tr></thead>
              <tbody>
                {rows.flatMap((t) => {
                  const m = (t.date || "").slice(0, 7), out = [];
                  const groupedByMonth = view === "all";
                  if (groupedByMonth && m !== last) { last = m; out.push(<tr key={"m" + m} className="mh" onClick={() => setCol({ ...col, [m]: !col[m] })}><td colSpan="9">{m ? ml(m) : "No date"} <em>{counts[m]} tickets</em><span>{col[m] ? "Show" : "Hide"}</span></td></tr>); }
                  if (!groupedByMonth || !col[m]) out.push(<tr key={t.id}>
                    <td><b className={"id " + t.type}>{t.id}</b></td>
                    <td><div className="tt">{t.title}</div></td>
                    <td className="nw">{fmt(t.date)}<div className="dd">{t.by}</div></td>
                    <td>{t.by === "Client" ? <select className={"psel " + (t.priority || "none")} disabled={!canEdit} value={t.priority || ""} onChange={(e) => patch(t.id, { priority: e.target.value })}><option value="">Set priority</option>{PRIO.map((x) => <option key={x}>{x}</option>)}</select> : <span className={"pill " + t.priority}>{t.priority}</span>}</td>
                    <td><Assign t={t} members={members.filter((x) => x.role !== "Client")} can={canEdit} onChange={(v) => patch(t.id, { assignees: v })} /></td>
                    <td className="nw">{t.version || "-"}<div className="dd">{fmt(t.deployed)}</div></td>
                    <td><select className={"st " + t.status.replace(" ", "")} disabled={!canEdit} value={t.status} onChange={(e) => setStatus(t, e.target.value)}>{STATUS.map((s) => <option key={s}>{s}</option>)}</select></td>
                    <td className="nw">{fmt(t.closed)}{t.deadline && <div className="dd">Due {fmt(t.deadline)}</div>}</td>
                    <td className="ra">
                      <button className="ic" title="View details and attachments" onClick={() => setDetail(t.id)}><Ic d={EYE} /></button>
                      {canEdit && <button className="ic" title="Edit" onClick={() => setModal({ ...t })}><Ic d={PEN} /></button>}
                      <button className="ic dl" disabled={!canDel(t)} title={canDel(t) ? "Delete" : (t.assignees || []).includes(me.id) ? "You cannot delete a ticket assigned to you" : "Only admins can delete"} onClick={() => del(t)}><Ic d={TRASH} /></button>
                    </td></tr>);
                  return out;
                })}
                {!rows.length && <tr><td colSpan="9" className="empty">No tickets found.</td></tr>}
              </tbody>
            </table></div>
          </section>
        </>)}
      </main>

      {modal && (<div className="ov" onClick={() => setModal(null)}><form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{modal.id ? "Edit " + modal.id : "New " + (modal.type === "issue" ? "Issue" : "Feature")}</h2>
        <div className="g">
          <label className="full">Title<input required {...f("title")} /></label>
          {!client && (<>
          <label>Priority<select {...f("priority")}>{modal.by === "Client" && <option value="">Not set</option>}{PRIO.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label>Status<select {...f("status")}>{STATUS.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label>Raised by<select {...f("by")}><option>Team</option><option>Client</option></select></label>
          <label>Assignees<Assign t={modal} members={members.filter((x) => x.role !== "Client")} can onChange={(v) => setModal({ ...modal, assignees: v })} /></label>
          <label>Raised / requested on<input type="date" {...f("date")} /></label>
          <label>Version<input placeholder="1.0.1" {...f("version")} /></label>
          <label>Deployed on<input type="date" {...f("deployed")} /></label>
          <label>Deadline<input type="date" {...f("deadline")} /></label>
          <label>Client (notified when closed)<select {...f("createdBy")}><option value="">None</option>{members.filter((x) => x.role === "Client").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          </>)}
          {client && <p className="note full">The date is added automatically.</p>}
          <label className="full">{client ? "Description" : "Description / fix details"}<textarea rows="4" {...f("details")} /></label>
          {!client && <label className="full">Resolution / solution (shown to the client)<textarea rows="3" {...f("resolution")} /></label>}
          <div className="full ab"><b>Attachments</b>
            <div className="tools up"><select value={modal._cat || CATS[CATS.length - 1]} onChange={(e) => setModal({ ...modal, _cat: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
              <input type="file" multiple onChange={(e) => setModal({ ...modal, _files: [...e.target.files] })} /></div>
            <div className="tools up"><input placeholder="Or paste a link (Google Drive, Docs...)" value={modal._url || ""} onChange={(e) => setModal({ ...modal, _url: e.target.value })} />
              <input placeholder="Link name (optional)" value={modal._uname || ""} onChange={(e) => setModal({ ...modal, _uname: e.target.value })} /></div></div>
        </div>
        <div className="acts end"><button type="button" className="btn alt" onClick={() => setModal(null)}>Cancel</button><button className="btn">Save ticket</button></div>
      </form></div>)}

      {projectModal && (<div className="ov" onClick={() => setProjectModal(false)}><form className="modal project-modal" onClick={(e) => e.stopPropagation()} onSubmit={createProject}>
        <h2>Add a project</h2>
        <p className="note">Each company can have multiple isolated projects. Project members, notes, tasks, files, and meetings stay scoped to their project.</p>
        <label>Company<select required value={projectOrganizationId} onChange={(event) => setProjectOrganizationId(event.target.value)}>{organizations.filter((item) => item.canCreateProject || item.id === projectOrganizationId).map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
        <label>Project name<input autoFocus required maxLength={60} value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="e.g. DocuTect" /></label>
        <div className="acts end"><button type="button" className="btn alt" onClick={() => setProjectModal(false)}>Cancel</button><button className="btn">Create project</button></div>
      </form></div>)}
      {organizationModal && (<div className="ov" onClick={() => setOrganizationModal(false)}><form className="modal project-modal" onClick={(e) => e.stopPropagation()} onSubmit={createOrganization}>
        <h2>Add a company</h2>
        <p className="note">Create an isolated company workspace, then add multiple projects under it. You will be its initial company admin.</p>
        <label>Company name<input autoFocus required maxLength={80} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} placeholder="e.g. Northstar Labs" /></label>
        <div className="acts end"><button type="button" className="btn alt" onClick={() => setOrganizationModal(false)}>Cancel</button><button className="btn">Create company</button></div>
      </form></div>)}

      {dt && (<div className="ov" onClick={() => setDetail(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2><b className={"id " + dt.type}>{dt.id}</b> {dt.title}</h2>
        <div className="meta">{!client && <span className={"pill " + dt.priority}>{dt.priority}</span>}<span className={"pill st " + dt.status.replace(" ", "")}>{dt.status}</span>
          <span>Raised {fmt(dt.date)} by {dt.by}</span>{!client && <span>Assignees: {anames(dt.assignees)}</span>}{dt.deadline && <span>Deadline: {fmt(dt.deadline)}</span>}{dt.owner && !client && <span>Worked by: {dt.owner}</span>}</div>
        <h4>Description</h4><p className="desc">{dt.details || "No description."}</p>
        {dt.resolution && <><h4>Resolution</h4><p className="desc">{dt.resolution}</p></>}
        {(dt.notes || []).length > 0 && <><h4>History</h4>{dt.notes.map((n, i) => <p key={i} className="dd">{fmt(n.at)} - {n.by}: {n.text}</p>)}</>}
        <h4>Attachments</h4>
        {files.filter((x) => x.ticket === dt.id).map((a) => (<div className="att" key={a.id}><a href={fh(a)} target="_blank" rel="noreferrer"><Ic d={CLIP} /> {a.name}</a><small>{a.cat}{a.url ? ", link" : ""}</small></div>))}
        {!files.some((x) => x.ticket === dt.id) && <small>No attachments</small>}
        <div className="acts end">{client && dt.status === "Completed" && <button className="btn" onClick={() => reopen(dt)}>Not satisfied? Reopen</button>}<button className="btn alt" onClick={() => setDetail(null)}>Close</button></div>
      </div></div>)}
    </div>
  );
}
