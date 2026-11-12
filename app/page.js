"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { correctTurnNames, generateEnglishKeyPoints, generateMeetingParticipantCards } from "../lib/local-transcription";
import MeetingNotes from "../components/MeetingNotes";
import ActivityLog from "../components/ActivityLog";
import TeamChat from "../components/TeamChat";
import PlatformConsole from "../components/PlatformConsole";
import Dashboard from "./dashboard";
import { ATTACHMENT_ACCEPT, ATTACHMENT_HINT, attachmentError, DESCRIPTION_CHAR_LIMIT, DESCRIPTION_WORD_LIMIT, descriptionError, wordCount } from "../lib/limits";

const LocalTranscriber = dynamic(() => import("../components/LocalTranscriber"), { ssr: false });

const STATUS = ["Open", "In Progress", "Testing", "Completed", "Reopened"], PRIO = ["High", "Medium", "Low"], ROLES = ["Admin", "Developer", "Collaborator", "Client"];
const CATS = ["Requirements & Design", "Reports & Releases", "Guides & Communication", "Other"];
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
    const resource = p.split("?")[0];
    const pageQuery = projectId && resource !== "db" && resource !== "tickets"
      ? "&ticketOffset=" + encodeURIComponent(localStorage.getItem("rw-ticket-offset") || "0")
      : "";
    const r = await fetch("/api/" + p + (projectId ? (p.includes("?") ? "&" : "?") + "project=" + encodeURIComponent(projectId) + pageQuery : ""), {
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

const BELL = "M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0";
const UPLOAD = "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12";
const VIDEO = "M23 7l-7 5 7 5V7zM14 5H3a2 2 0 00-2 2v10a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2z";
const LINK = "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71";
const toMs = (v) => (typeof v === "number" ? v : Date.parse(v || "")) || 0;
const timeAgo = (v) => {
  const ms = toMs(v);
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};

// Top-right notification bell. Admins see pending meeting-edit requests and approve/deny them here;
// other members see the outcome of their own requests. The bell shakes whenever the unread count rises.
function NotificationBell({ requests, isAdmin, meId, notice, onReview }) {
  const [open, setOpen] = useState(false);
  const [ring, setRing] = useState(false);
  const [seen, setSeen] = useState(() => {
    try { return JSON.parse(localStorage.getItem("rw-seen-notifications") || "[]"); } catch { return []; }
  });
  const ref = useRef(null);
  const items = useMemo(() => [...requests]
    .filter((r) => isAdmin ? r.status === "pending" : r.memberId === meId)
    .sort((a, b) => toMs(b.reviewedAt || b.requestedAt) - toMs(a.reviewedAt || a.requestedAt))
    .slice(0, 20), [requests, isAdmin, meId]);
  const tag = (r) => r.id + ":" + r.status;
  const unread = isAdmin ? items.length : items.filter((r) => r.status !== "pending" && !seen.includes(tag(r))).length;
  const previous = useRef(unread);
  useEffect(() => {
    if (unread > previous.current) {
      setRing(true);
      try { navigator.vibrate?.(180); } catch {}
      const t = setTimeout(() => setRing(false), 1200);
      previous.current = unread;
      return () => clearTimeout(t);
    }
    previous.current = unread;
  }, [unread]);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (e.type === "keydown" ? e.key === "Escape" : !ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  const toggle = () => {
    setOpen((o) => !o);
    if (!isAdmin && unread) {
      const next = [...new Set([...seen, ...items.map(tag)])].slice(-200);
      setSeen(next);
      try { localStorage.setItem("rw-seen-notifications", JSON.stringify(next)); } catch {}
    }
  };
  const statusText = { pending: "Waiting for an admin", approved: "Approved · edit access for 1 hour", denied: "Denied by an admin" };
  return (
    <div className="bell" ref={ref}>
      <button type="button" className={"bell-btn" + (ring ? " ring" : "") + (unread ? " has" : "")} aria-label={`Notifications${unread ? `, ${unread} new` : ""}`} aria-expanded={open} onClick={toggle}>
        <Ic d={BELL} />
        {unread > 0 && <span className="bell-count">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && <div className="bell-panel" role="dialog" aria-label="Notifications">
        <div className="bell-head"><b>Notifications</b><span>{isAdmin ? `${items.length} pending` : "Meeting edit access"}</span></div>
        {notice && <div className="bell-notice" role="status">{notice}</div>}
        <div className="bell-list">
          {items.map((r) => (
            <article key={r.id} className={"bell-item " + r.status}>
              <span className="bell-avatar">{(r.memberName || "?").split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase()}</span>
              <div className="bell-body">
                <p>{isAdmin ? <><b>{r.memberName}</b> asked for one-hour edit access to meeting cards and notes.</> : <>Your request for meeting edit access: <b>{r.status}</b></>}</p>
                <small>{isAdmin ? timeAgo(r.requestedAt) : `${statusText[r.status] || r.status} · ${timeAgo(r.reviewedAt || r.requestedAt)}`}</small>
                {isAdmin && <div className="bell-actions">
                  <button type="button" className="btn" onClick={() => onReview(r.id, "approve")}>Approve 1 hour</button>
                  <button type="button" className="btn alt" onClick={() => onReview(r.id, "deny")}>Deny</button>
                </div>}
              </div>
            </article>
          ))}
          {!items.length && <div className="bell-empty"><Ic d={BELL} /><b>You're all caught up</b><span>{isAdmin ? "No pending meeting edit requests." : "No notifications yet."}</span></div>}
        </div>
      </div>}
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
  const [organizationKind, setOrganizationKind] = useState("department");
  // Self sign-up: a new company creates its own workspace (confirmed by email).
  const [signup, setSignup] = useState({ companyName: "", name: "", email: "", password: "", projectName: "", accept: false });
  const [signupBusy, setSignupBusy] = useState(false);
  const [signupSentTo, setSignupSentTo] = useState("");
  const [projectOrganizationId, setProjectOrganizationId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [tickets, setTickets] = useState([]);
  const [ticketOffset, setTicketOffset] = useState(0);
  const [ticketTotal, setTicketTotal] = useState(0);
  const [ticketHasMore, setTicketHasMore] = useState(false);
  const [ticketPageLoading, setTicketPageLoading] = useState(false);
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [audit, setAudit] = useState([]);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [files, setFiles] = useState([]);
  const [fileOffset, setFileOffset] = useState(0);
  const [fileTotal, setFileTotal] = useState(0);
  const [fileHasMore, setFileHasMore] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fc, setFc] = useState(0);
  const [lk, setLk] = useState({ url: "", name: "" });
  const [fa, setFa] = useState("");
  const [amsg, setAmsg] = useState("");
  const [inv, setInv] = useState(null);
  const [invPassword, setInvPassword] = useState("");
  const [view, setView] = useState("all");
  const [navOpen, setNavOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [q, setQ] = useState(""), [fs, setFs] = useState(""), [fp, setFp] = useState(""), [fm, setFm] = useState("");
  const [modal, setModal] = useState(null);
  const [detail, setDetail] = useState(null);
  const [ucat, setUcat] = useState(CATS[0]);
  const [form, setForm] = useState({ name: "", email: "", role: "Developer" });
  const [msg, setMsg] = useState("");
  const [lf, setLf] = useState({ name: "", email: "", phone: "", password: "", id: "" });
  const [acct, setAcct] = useState(null);
  const [meetingMonth, setMeetingMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [meetings, setMeetings] = useState([]);
  const [meetingOffset, setMeetingOffset] = useState(0);
  const [meetingTotal, setMeetingTotal] = useState(0);
  const [meetingHasMore, setMeetingHasMore] = useState(false);
  const [meetingPageLoading, setMeetingPageLoading] = useState(false);
  const [meetingsLoading, setMeetingsLoading] = useState(false);
  const [meetingSelected, setMeetingSelected] = useState(null);
  const [meetingDraft, setMeetingDraft] = useState("");
  const [meetingFormOpen, setMeetingFormOpen] = useState(false);
  // "Start meeting now" asks who to invite first; nobody is invited unless picked.
  const [instantPickerOpen, setInstantPickerOpen] = useState(false);
  const [instantAttendeeIds, setInstantAttendeeIds] = useState([]);
  const [instantTitle, setInstantTitle] = useState("");
  const [instantAgenda, setInstantAgenda] = useState("");
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
  // Extra spellings of team members' names (per project), so a spoken name opens the right card.
  const [nameAliases, setNameAliases] = useState({});
  // Live updates: the project's change version (bumps whenever anyone changes something) and the
  // chat channels' latest-message times, both from the lightweight /api/pulse poll.
  const [liveVersion, setLiveVersion] = useState("");
  const [pulseChannels, setPulseChannels] = useState([]);
  const [chatRead, setChatRead] = useState({});
  const [pwOpen, setPwOpen] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
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
  // Shared notes stay out of the way until the meeting actually starts (join or record) or already has notes.
  const [meetingNotesOpen, setMeetingNotesOpen] = useState(false);
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

  // Workspace fields shared by a full load and a silent live refresh. A live refresh never touches the
  // current view, forms the user is typing in, or the page they are on.
  const applyWorkspace = useCallback((data) => {
      setMe(data.me); setIsPlatformAdmin(!!data.isPlatformAdmin); setCanUseMeetings(data.canUseMeetings === undefined ? data.me.role !== "Client" : data.canUseMeetings); setCanManageMeetings(!!data.canManageMeetings); setMeetingEditAccess(!!data.meetingEditAccess); setMeetingEditAccessExpiresAt(data.meetingEditAccessExpiresAt || null); setMeetingEditRequests(data.meetingEditRequests || []); setGoogleCalendarConfigured(!!data.googleCalendarConfigured); setGoogleCalendarConnected(!!data.googleCalendarConnected); setGoogleCalendarEmail(data.googleCalendarEmail || ""); setNameAliases(data.nameAliases || {}); setProjects(data.projects || []); setOrganizations(data.organizations || []); setProjectId(data.projectId); localStorage.setItem("rw-project", data.projectId);
      setTickets(data.tickets); setTicketOffset(data.ticketPagination?.offset || 0); setTicketTotal(data.ticketPagination?.total ?? data.tickets.length); setTicketHasMore(!!data.ticketPagination?.hasMore); setMembers(data.members); setInvites(data.invites || []);
  }, []);
  const load = useCallback(async (k, requestedProject) => {
    const selectedProject = requestedProject || localStorage.getItem("rw-project") || "";
    localStorage.setItem("rw-ticket-offset", "0");
    setMeetingOffset(0);
    const r = await api("db", null, k, selectedProject);
    if (r.loginRequired) return setScreen("login");
    if (r.setup) return setScreen("setup");
    if (r.status === 401) {
      localStorage.removeItem("rw-key");
      setKey("");
      return setScreen("login");
    }
    if (r.suspended) { setMsg(r.error); return setScreen("suspended"); }
    if (!r.ok && r.status === 403) {
      // The remembered project belongs to someone else (for example a shared computer, or a project
      // this person was removed from): forget it and open their own project instead.
      localStorage.removeItem("rw-project");
      const fallback = selectedProject ? await api("db", null, k) : r;
      if (fallback.ok) return applyDb(fallback);
      if (fallback.suspended) { setMsg(fallback.error); return setScreen("suspended"); }
      // This login has no project at all: show the sign-in / sign-up screen, never a dead-end popup.
      localStorage.removeItem("rw-key");
      setKey("");
      setMsg("This account is not part of any project yet. Sign in with another account, ask your admin for an invitation, or create your own company workspace.");
      return setScreen("login");
    }
    if (!r.ok) { if (r.status === 401) setScreen("login"); else alert(r.error || "Unable to load project"); return; }
    applyDb(r);
    function applyDb(data) {
      applyWorkspace(data);
      setView((v) => data.me.role === "Client" && v !== "account" ? "portal" : v); setAcct({ name: data.me.name, phone: data.me.phone || "", current: "", password: "", confirm: "" }); setAudit(data.audit || []); setAuditOffset(0); setAuditTotal(data.audit.length); setAuditHasMore(false); setFiles(data.files || []); setFileOffset(0); setFileTotal(data.files.length); setFileHasMore(false); setScreen("app");
    }
  }, []);
  useEffect(() => {
    const sp = new URLSearchParams(location.search), t = sp.get("invite");
    if (sp.get("reset")) { setScreen("reset"); return; }
    if (sp.get("signup")) {
      setScreen("verifying");
      api("signup", { action: "verify", token: sp.get("signup") }).then((r) => {
        history.replaceState(null, "", "/");
        if (!r.key) { setMsg(r.error || "We could not confirm your sign-up."); setScreen("login"); return; }
        localStorage.setItem("rw-key", r.key); localStorage.setItem("rw-project", r.projectId);
        setKey(r.key); load(r.key, r.projectId);
      });
      return;
    }
    if (sp.has("google-meet")) {
      setView("meetings");
      if (sp.get("google-meet") === "connected") setMeetingNotice("Google Calendar connected. New online meetings can now create shareable Google Meet rooms automatically.");
      else setMeetingError(`Google Calendar connection did not complete (${sp.get("reason") || "cancelled"}). Check the OAuth setup and try again.`);
      history.replaceState(null, "", "/");
    }
    if (t) {
      // Only a 404 means the invite is gone; retry transient server/network failures instead of reporting them as expired.
      const openInvite = async () => {
        let r;
        for (const delay of [0, 800, 2000, 4000]) {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          r = await api("invite?t=" + encodeURIComponent(t));
          if (r.email || (r.status >= 400 && r.status < 500)) break;
        }
        setInv({ ...r, token: t });
        setScreen(r.email ? "accept" : r.status >= 400 && r.status < 500 ? "denied" : "inviteError");
      };
      openInvite();
    }
    else { const k = localStorage.getItem("rw-key") || ""; setKey(k); load(k); }
  }, [load]);
  // ---- Live updates -------------------------------------------------------------------------
  // Every 5 seconds (while the tab is visible) ask the server for the project's change version. When
  // someone changes anything, quietly reload what is on screen; nobody has to press refresh.
  const liveRef = useRef({});
  liveRef.current = { key, projectId, view, ticketOffset, fileOffset, auditOffset, meetingOffset, meetingMonth, meetingSelected, role: me?.role, meId: me?.id, members };
  const silentRefresh = useCallback(async () => {
    const c = liveRef.current;
    if (!c.key || !c.projectId) return;
    const r = await api(`db?ticketOffset=${c.ticketOffset || 0}`, null, c.key, c.projectId);
    if (!r.ok || !r.me || r.projectId !== c.projectId || liveRef.current.projectId !== c.projectId) return;
    applyWorkspace(r);
    if (c.view === "files") {
      const f = await api(`files?offset=${c.fileOffset}&limit=100`, null, c.key, c.projectId);
      if (f.ok) { setFiles(f.files || []); setFileTotal(f.pagination?.total ?? (f.files || []).length); setFileHasMore(!!f.pagination?.hasMore); }
    } else setFiles(r.files || []);
    if (c.view === "activity" && c.role === "Admin") {
      const a = await api(`activity?offset=${c.auditOffset}&limit=100`, null, c.key, c.projectId);
      if (a.ok) { setAudit(a.audit || []); setAuditTotal(a.pagination?.total ?? (a.audit || []).length); setAuditHasMore(!!a.pagination?.hasMore); }
    }
    if (c.view === "meetings" && !c.meetingSelected) {
      const m = await api(`meetings?month=${monthKey(c.meetingMonth)}&offset=${c.meetingOffset}&limit=100`, null, c.key, c.projectId);
      if (m.ok && !liveRef.current.meetingSelected) { setMeetings(m.meetings || []); setMeetingTotal(m.pagination?.total ?? (m.meetings || []).length); setMeetingHasMore(!!m.pagination?.hasMore); }
    }
  }, [applyWorkspace]);
  useEffect(() => {
    if (screen !== "app" || !key || !projectId) return;
    let stopped = false, busy = false, last = "", timer;
    const tick = async () => {
      clearTimeout(timer);
      if (!document.hidden && !busy) {
        busy = true;
        const r = await api("pulse", null, key, projectId);
        busy = false;
        if (stopped) return;
        if (r.ok) {
          if (r.channels) {
            notifyNewMessages(r.channels);
            setPulseChannels((previous) => JSON.stringify(previous) === JSON.stringify(r.channels) ? previous : r.channels);
          }
          if (last && r.v !== last) { setLiveVersion(r.v); silentRefresh(); }
          last = r.v;
        }
      }
      if (!stopped) timer = setTimeout(tick, 5000);
    };
    tick();
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [screen, key, projectId, silentRefresh]);
  // Desktop notification for a chat message from someone else while the chat is not on screen
  // (only after the person turned notifications on in Team Chat).
  const chatSeenRef = useRef({});
  const notifyNewMessages = (channels) => {
    const c = liveRef.current, seen = chatSeenRef.current, first = !seen.__init;
    seen.__init = true;
    channels.forEach((channel) => {
      const before = seen[channel.id];
      seen[channel.id] = channel.lastMessageAt;
      if (first || before === undefined || channel.lastMessageAt <= before || channel.lastAuthorId === c.meId) return;
      if (!document.hidden && c.view === "chat") return;
      let enabled = false;
      try { enabled = typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem("rw-chat-notify") !== "off"; } catch {}
      if (!enabled) return;
      const author = c.members.find((m) => m.id === channel.lastAuthorId)?.name || "A teammate";
      try {
        const note = new Notification(channel.kind === "dm" ? `${author} sent you a message` : `New message in #${channel.name}`, { body: channel.kind === "dm" ? "Open Team Chat to reply." : `${author} posted in #${channel.name}`, icon: "/loopdesk-mark.svg", tag: "chat-" + channel.id });
        note.onclick = () => { window.focus(); setView("chat"); note.close(); };
      } catch {}
    });
  };
  // Chat "last read" times live in this browser, per project and person.
  const chatReadKey = me && projectId ? `rw-chat-read:${projectId}:${me.id}` : "";
  useEffect(() => {
    if (!chatReadKey) return;
    try { setChatRead(JSON.parse(localStorage.getItem(chatReadKey) || "{}")); } catch { setChatRead({}); }
  }, [chatReadKey]);
  const markChatRead = useCallback((channelId, at) => {
    setChatRead((current) => {
      if ((current[channelId] || 0) >= at) return current;
      const next = { ...current, [channelId]: at };
      try { localStorage.setItem(chatReadKey, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [chatReadKey]);
  const chatUnread = pulseChannels.filter((c) => c.lastMessageAt > (chatRead[c.id] || 0) && c.lastAuthorId !== me?.id).length;

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
    // Admins get new access requests in the header bell on every page, not only on the dashboard.
    if (me?.role !== "Admin" || !key || !projectId) return;
    const timer = setInterval(async () => {
      if (document.hidden) return;
      const result = await api("meeting-notes?month=" + monthKey(meetingMonth), null, key, projectId);
      if (result.ok) setMeetingEditRequests(result.requests || []);
    }, 20000);
    return () => clearInterval(timer);
  }, [me, key, projectId, meetingMonth]);
  useEffect(() => {
    if (view !== "meetings" || !key || !projectId) return;
    let cancelled = false;
    setMeetingsLoading(true);
    api(`meetings?month=${monthKey(meetingMonth)}&offset=${meetingOffset}&limit=100`, null, key, projectId).then((r) => {
      if (cancelled) return;
      if (!r.ok) { setMeetingError(r.error || "Unable to load meetings"); return; }
      setMeetings(r.meetings || []);
      setMeetingOffset(r.pagination?.offset || 0);
      setMeetingTotal(r.pagination?.total ?? r.meetings.length);
      setMeetingHasMore(!!r.pagination?.hasMore);
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
  const loadTicketPage = async (offset) => {
    setTicketPageLoading(true);
    const result = await api(`tickets?offset=${offset}&limit=100`, null, key, projectId);
    setTicketPageLoading(false);
    if (!result.ok) { alert(result.error || "Unable to load tickets"); return; }
    setTickets(result.tickets || []);
    setTicketOffset(result.pagination?.offset || 0);
    localStorage.setItem("rw-ticket-offset", String(result.pagination?.offset || 0));
    setTicketTotal(result.pagination?.total ?? result.tickets.length);
    setTicketHasMore(!!result.pagination?.hasMore);
  };
  const loadFilePage = async (offset) => {
    setFileLoading(true);
    const result = await api(`files?offset=${offset}&limit=100`, null, key, projectId);
    setFileLoading(false);
    if (!result.ok) { alert(result.error || "Unable to load files"); return; }
    setFiles(result.files || []);
    setFileOffset(result.pagination?.offset || 0);
    setFileTotal(result.pagination?.total ?? result.files.length);
    setFileHasMore(!!result.pagination?.hasMore);
  };
  const loadAuditPage = async (offset) => {
    setAuditLoading(true);
    const result = await api(`activity?offset=${offset}&limit=100`, null, key, projectId);
    setAuditLoading(false);
    if (!result.ok) { alert(result.error || "Unable to load activity"); return; }
    setAudit(result.audit || []);
    setAuditOffset(result.pagination?.offset || 0);
    setAuditTotal(result.pagination?.total ?? result.audit.length);
    setAuditHasMore(!!result.pagination?.hasMore);
  };
  const loadMeetingPage = async (month, offset) => {
    setMeetingPageLoading(true);
    const result = await api(`meetings?month=${month}&offset=${offset}&limit=100`, null, key, projectId);
    setMeetingPageLoading(false);
    if (!result.ok) { setMeetingError(result.error || "Unable to load meetings"); return; }
    setMeetings(result.meetings || []);
    setMeetingOffset(result.pagination?.offset || 0);
    setMeetingTotal(result.pagination?.total ?? result.meetings.length);
    setMeetingHasMore(!!result.pagination?.hasMore);
    setMeetingSelected((selected) => selected && (result.meetings || []).some((item) => item.id === selected.id && item.occurrenceDate === selected.occurrenceDate)
      ? (result.meetings || []).find((item) => item.id === selected.id && item.occurrenceDate === selected.occurrenceDate)
      : null);
  };
  useEffect(() => {
    if (!key || !projectId) return;
    if (view === "files") loadFilePage(0);
    if (view === "activity" && admin) loadAuditPage(0);
  }, [view, projectId, key]);
  const commit = async (next) => {
    const previousCount = tickets.length;
    setTickets(next);
    const result = await api(`tickets?offset=${ticketOffset}&limit=100`, { tickets: next }, key, projectId);
    if (!result.ok) { alert(result.error || "Save failed"); load(key); return; }
    const total = Math.max(0, ticketTotal + next.length - previousCount);
    setTicketTotal(total);
    setTicketHasMore(ticketOffset + next.length < total);
    if (!next.length && ticketOffset > 0) loadTicketPage(Math.max(0, ticketOffset - 100));
    return result;
  };

  const admin = me && me.role === "Admin", client = me && me.role === "Client";
  // Admins and Collaborators manage every ticket; other team members update only tickets assigned to
  // them or raised by them, and cannot reassign or delete. The server enforces the same rules.
  const manager = !!me && ["Admin", "Collaborator"].includes(me.role);
  const ownsTicket = (t) => !!me && ((t.assignees || []).includes(me.id) || t.raisedBy === me.id);
  const canEditTicket = (t) => manager || (!!me && !client && ownsTicket(t));
  const canDeleteFiles = !!me && !["Collaborator", "Client"].includes(me.role);
  const canEditMeetingContent = !!me && (["Admin", "Collaborator"].includes(me.role) || meetingEditAccess);
  const activeProject = projects.find((p) => p.id === projectId);
  const activeOrganization = organizations.find((organization) => organization.id === activeProject?.organizationId);
  // The main company (tenant) of the open project, and every organization in display order:
  // each main company followed by its departments and sub-companies.
  const activeTenant = activeOrganization?.parentId ? organizations.find((item) => item.id === activeOrganization.parentId) || null : activeOrganization;
  const orgLabel = (item) => item.parentId ? `${item.parentName ? item.parentName + " › " : ""}${item.name}` : item.name;
  const KIND_LABEL = { department: "Department", subsidiary: "Sub-company" };
  const orderedOrganizations = [
    ...organizations.filter((item) => !item.parentId).flatMap((tenant) => [tenant, ...organizations.filter((child) => child.parentId === tenant.id)]),
    ...organizations.filter((item) => item.parentId && !organizations.some((tenant) => tenant.id === item.parentId)),
  ];
  const canDel = () => manager;
  // Dashboard lists cover the whole project; a ticket outside the loaded page opens via its log search.
  // Opens a ticket from anywhere (dashboard, chat links like "ISS-01", "iss-1" or "FTR 3"): goes to the
  // Issues or Features page with filters cleared and opens that ticket's details.
  const openTicket = (raw) => {
    const match = String(raw || "").trim().toUpperCase().match(/^(ISS|FTR)[- ]?0*(\d+)$/);
    if (!match) return;
    const type = match[1] === "FTR" ? "feature" : "issue", number = Number(match[2]);
    const found = tickets.find((t) => t.type === type && ticketNumber(t) === number);
    setView(type); setFs(""); setFp(""); setFa(""); setFm(""); setNavOpen(false);
    if (found) { setQ(""); setDetail(found.id); }
    else setQ(`${match[1]}-${String(number).padStart(2, "0")}`);
  };
  const base = useMemo(() => tickets.filter((t) => view === "all" || t.type === view), [tickets, view]);
  const months = useMemo(() => [...new Set(base.map((t) => (t.date || "").slice(0, 7)).filter(Boolean))].sort(), [base]);
  const rows = useMemo(() => base.filter((t) =>
    (!fs || t.status === fs) && (!fp || t.priority === fp) && (!fa || (fa === "none" ? !(t.assignees || []).length : (t.assignees || []).includes(fa))) && (!fm || (t.date || "").startsWith(fm)) &&
    (!q || (t.id + t.title + t.details + members.filter((m) => (t.assignees || []).includes(m.id)).map((m) => m.name).join(" ")).toLowerCase().includes(q.toLowerCase()))
  ).sort((a, b) => view === "issue" || view === "feature"
    ? ticketNumber(a) - ticketNumber(b) || a.id.localeCompare(b.id)
    : (a.date || "").localeCompare(b.date || "") || a.id.localeCompare(b.id)), [base, q, fs, fp, fm, fa, members, view]);

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
    const descriptionProblem = descriptionError(t.details);
    if (descriptionProblem) return alert(descriptionProblem);
    setModal(null);
    if (me.role === "Client") {
      const r = await api("client", { ticket: t }, key, projectId);
      if (!r.id) return alert(r.error || "Failed");
      await attachAll(r.id, m); return load(key);
    }
    t.closed = t.status === "Completed" ? (t.closed || today()) : "";
    let savedId = t.id;
    if (!t.id) {
      t.id = nextId(tickets, t.type);
      const result = await commit([...tickets, t]);
      if (!result) return;
      // The server may renumber the ticket if its id is already used outside the loaded page.
      savedId = result.renamed?.[t.id] || t.id;
    } else if (!(await commit(tickets.map((x) => x.id === t.id ? t : x)))) return;
    await attachAll(savedId, m); load(key);
  };
  const deleteOwnTicket = async (t) => {
    if (!confirm(`Delete ${t.clientRef || t.id} "${t.title}"? It will be removed for the support team as well.`)) return;
    const r = await api("client", { action: "delete", id: t.id }, key, projectId);
    if (!r.ok) alert(r.error || "Could not delete the ticket");
    setDetail(null); load(key);
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
    setLk({ url: "", name: "" }); await load(key); await loadFilePage(fileOffset);
  };
  // Exports exactly what the Issues or Features table shows (current filters and search applied).
  const exportCsv = () => {
    const cols = [["id", "ID"], ["date", "Raised on"], ["by", "Raised by"], ["title", "Title"], ["priority", "Priority"], ["assignee", "Assignees"], ["details", "Description"], ["version", "Version"], ["deployed", "Deployed on"], ["deadline", "Deadline"], ["status", "Status"], ["closed", "Completed on"]];
    const cell = (value) => { let text = String(value ?? ""); if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
    const csv = "﻿" + [cols.map(([, label]) => cell(label)).join(","), ...rows.map((t) => cols.map(([c]) => cell(c === "assignee" ? anames(t.assignees) : t[c] || "")).join(","))].join("\r\n");
    const projectSlug = (activeProject?.name || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `${projectSlug}-${view === "feature" ? "features" : "issues"}-${today()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const dt = tickets.find((t) => t.id === detail);
  // Used by both the file picker and drag-and-drop on the Attachments page.
  const uploadOne = async (f) => {
    const problem = attachmentError(f);
    if (problem) return alert(problem);
    setUploading(true);
    try {
      const fd = new FormData(); fd.append("file", f); fd.append("cat", CATS[fc]);
      const r = await api("upload", fd, key, projectId);
      if (!r.ok) alert(r.error || "Upload failed");
      await load(key); await loadFilePage(fileOffset);
    } finally { setUploading(false); }
  };
  const uploadFile = (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) uploadOne(f);
  };
  const saveAcct = async (e, pw) => {
    e.preventDefault(); setAmsg("");
    if (pw && acct.password !== acct.confirm) return setAmsg("Passwords do not match");
    const r = await api("account", pw ? { current: acct.current, password: acct.password } : { name: acct.name, phone: acct.phone }, key, projectId);
    if (!r.ok) return setAmsg(r.error || "Failed");
    setAmsg(pw ? "Password changed" : "Profile saved"); if (pw) setPwOpen(false); load(key);
  };
  const adm = async (p, body) => {
    const r = await api(p, body, key, projectId);
    if (!r.ok) return alert(r.error || "Action failed");
    if (p === "filedel") { await loadFilePage(fileOffset); return; }
    load(key);
  };
  const refreshMeetings = async (month = monthKey(meetingMonth)) => {
    setMeetingOffset(0);
    const r = await api("meetings?month=" + month + "&offset=0&limit=100", null, key, projectId);
    if (!r.ok) { setMeetingError(r.error || "Unable to load meetings"); return; }
    setMeetings(r.meetings || []);
    setMeetingTotal(r.pagination?.total ?? r.meetings.length);
    setMeetingHasMore(!!r.pagination?.hasMore);
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
      const calendarText = r.calendarSynced ? " Added to Google Calendar — every participant gets a calendar invitation and reminder notifications." : "";
      if (r.inviteEmailsSent < r.inviteEmailsTotal || r.calendarError) setMeetingError(`Meeting scheduled.${calendarText} ${r.calendarError ? r.calendarError + " " : ""}${r.inviteEmailsSent < r.inviteEmailsTotal ? `Invitation emails were delivered to ${r.inviteEmailsSent} of ${r.inviteEmailsTotal} invitees. ${r.emailErrors?.[0] || "Check the server email configuration."}` : ""}`.trim());
      else setMeetingNotice(`Meeting scheduled.${calendarText}${r.inviteEmailsTotal ? ` Invitation emails sent to ${r.inviteEmailsSent} team member(s).` : ""}${!r.calendarConnected ? " Ask a project admin to connect Google Calendar so meetings appear on everyone's calendar." : ""}`);
      await refreshMeetings(meetingForm.date.slice(0, 7));
    } catch (error) { setMeetingError(error.message || "Could not create meeting"); }
    finally { setMeetingBusy(false); }
  };
  // One click: create a Google Meet room for "now", open it in a new tab, and open the meeting workspace here.
  // The tab is opened synchronously (before the API call) so browsers do not block it as a popup.
  const startInstantMeeting = async (attendeeIds, title, agenda) => {
    setMeetingError(""); setMeetingNotice(""); setMeetingBusy(true);
    const tab = window.open("", "_blank");
    try {
      tab?.document.write('<title>Starting meeting…</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#334155"><p>Creating your Google Meet room…</p></body>');
    } catch {}
    try {
      const now = new Date();
      const date = localDateKey(now), time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      // Only the team members picked in the start dialog; clients and the starter are never added.
      const team = attendeeIds.filter((id) => members.some((m) => m.id === id && m.status === "active" && m.role !== "Client" && m.id !== me.id));
      const r = await api("meetings", { action: "create", title: String(title || "").trim().slice(0, 120) || `${activeProject?.name || "Team"} meeting`, date, time, duration: 60, agenda: String(agenda || "").trim().slice(0, 3000), online: true, roomProvider: "google-meet", roomUrl: "", attendeeIds: team, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }, key, projectId);
      if (!r.ok || !r.meeting?.roomUrl) { tab?.close(); setMeetingError(r.error || "Could not create the Google Meet room."); return; }
      if (tab && !tab.closed) tab.location.href = r.meeting.roomUrl; else window.open(r.meeting.roomUrl, "_blank", "noopener");
      setMeetingMonth(new Date(now.getFullYear(), now.getMonth(), 1));
      await refreshMeetings(date.slice(0, 7));
      openMeeting({ ...r.meeting, occurrenceDate: date });
      setMeetingNotesOpen(true);
      setMeetingNotice(`Google Meet started and opened in a new tab.${r.inviteEmailsTotal ? ` Invitations with the join link sent to ${r.inviteEmailsSent} of ${r.inviteEmailsTotal} team member(s).` : ""}`);
    } catch (error) { tab?.close(); setMeetingError(error.message || "Could not start the meeting."); }
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
  // Recording or unsaved clips pin the user to the open meeting so captured audio is not lost.
  const meetingLocked = recordingState !== "idle" || (!!recordingClips.length && !recordingSaved);
  const resetMeetingSession = () => {
    setRecordingTranscript(""); recordingClips.forEach((clip) => URL.revokeObjectURL(clip.url)); setRecordingClips([]);
    setRecordingSaved(false); setRecordingNoteId(""); setRecordingCards([]); setConferenceJoined(false);
    setMeetingError(""); setMeetingNotice(""); setMeetingVoiceError(""); setHasRecordedVoiceNote(false);
    setRecordingSeconds(0); setFailedRecording(null);
  };
  const openMeeting = (meeting) => {
    if (meetingLocked) return;
    resetMeetingSession();
    const cards = meetingCards(meeting, members);
    setMeetingSelected(meeting); setMeetingDraft(meeting.notes || ""); setParticipantSummaries(cards);
    setSelectedMeetingMemberId(cards[0]?.memberId || ""); setMeetingCardView("selected");
    setMeetingNotesOpen(!!String(meeting.notes || "").trim());
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const closeMeeting = () => {
    if (meetingLocked) return;
    resetMeetingSession();
    setMeetingSelected(null); setMeetingDraft(""); setParticipantSummaries([]); setSelectedMeetingMemberId("");
  };
  const deleteMeeting = async (meeting) => {
    if (!confirm("Delete this meeting" + (meeting.weekly ? " series" : "") + "?")) return;
    const r = await api("meetings", { action: "delete", id: meeting.id }, key, projectId);
    if (!r.ok) { setMeetingError(r.error || "Could not delete meeting"); return; }
    if (r.calendarError) setMeetingError(r.calendarError);
    else if (meeting.googleCalendarEventId) setMeetingNotice("Meeting deleted and removed from Google Calendar; participants were notified of the cancellation.");
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
    setMeetingNotesOpen(true);
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
  // Team members with their extra name spellings, for the speech model and card routing.
  const voiceAttendees = useMemo(() => meetingVoiceAttendees(members, me).map((member) => ({ ...member, aliases: nameAliases[member.id] || [] })), [members, me, nameAliases]);
  const onTranscriptionComplete = useCallback((text) => {
    const attendees = voiceAttendees;
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
      setMeetingNotice("Transcript added to shared meeting notes. To fill a member's card automatically, address them by name (for example \"Ali, tell me about your tasks\") or select their card before recording.");
    } else {
      setMeetingNotice(`English notes ready. Filled ${cards.length === 1 ? "the card" : "cards"} for ${cards.map((card) => card.name).join(", ")} from the names heard in the recording — review them before sharing.`);
    }
    setRecordingState("idle");
    setTranscriptionProgress("");
    setFailedRecording(null);
    setPendingRecording(null);
  }, [key, meetingSelected, pendingRecording, projectId, voiceAttendees, selectedMeetingMemberId]);
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
    const result = await api("organization", { name: organizationName, kind: organizationKind, parentId: activeTenant?.id }, key, projectId);
    if (!result.ok) return alert(result.error || "Could not create it");
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
  const fh = (a) => a.url || fl(a);
  const fl = (a) => "/api/file?f=" + encodeURIComponent(a.id) + "&n=" + encodeURIComponent(a.name) + "&project=" + encodeURIComponent(projectId);
  const openFile = async (file) => {
    if (file.url) {
      window.open(file.url, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      const response = await fetch(fl(file), { headers: { "x-key": key }, cache: "no-store" });
      if (!response.ok) throw new Error((await response.text()) || response.statusText);
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = file.name || "download";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (error) {
      setMsg("Could not download file: " + (error.message || "request failed"));
    }
  };
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
  const S = (k) => ({ value: signup[k], onChange: (e) => setSignup({ ...signup, [k]: e.target.value }) });
  const submitSignup = async (e) => {
    e?.preventDefault();
    setMsg(""); setSignupBusy(true);
    const r = await api("signup", { action: "request", ...signup });
    setSignupBusy(false);
    if (!r.ok) { setMsg(r.error || "Sign-up failed"); return; }
    setSignupSentTo(r.email); setScreen("signupSent");
  };
  if (screen !== "app") return (
    <div className="gate"><div className={"modal" + (screen === "signup" ? " gate-wide" : "")}>
      <div className="brand dk"><span className="brand-mark"><img src="/loopdesk-mark.svg" alt="" /></span><div><b>LoopDesk</b><small>Team &amp; project management</small></div></div>
      {screen === "loading" && <p>Loading...</p>}
      {screen === "suspended" && <div className="signup-sent"><span className="signup-mail" aria-hidden="true">⏸</span><h2>Workspace paused</h2><p>{msg || "This company workspace is suspended."}</p><div className="acts end"><button type="button" className="btn alt" onClick={async () => { await api("logout", {}, key); localStorage.removeItem("rw-key"); location.reload(); }}>Sign out</button></div></div>}
      {screen === "verifying" && <div className="signup-wait"><span className="signup-spinner" /><p>Confirming your email and creating your workspace…</p></div>}
      {screen === "signup" && (<form className="signup" onSubmit={submitSignup}>
        <h2>Create your company workspace</h2>
        <p className="note">Free to start. You become the owner and admin of your company; invite your team and clients afterwards.</p>
        <div className="g">
          <label className="full">Company name<input required maxLength={80} autoComplete="organization" placeholder="e.g. Acme Technologies" {...S("companyName")} /></label>
          <label>Your name<input required maxLength={80} autoComplete="name" {...S("name")} /></label>
          <label>Work email<input required type="email" autoComplete="email" {...S("email")} /></label>
          <label>Password<input required type="password" minLength={8} autoComplete="new-password" placeholder="8+ characters, letter and number" {...S("password")} /></label>
          <label>First project <small>(optional)</small><input maxLength={60} placeholder="My first project" {...S("projectName")} /></label>
          <label className="full signup-terms"><input type="checkbox" checked={signup.accept} onChange={(e) => setSignup({ ...signup, accept: e.target.checked })} /> <span>I agree to the Terms of Service and Privacy Policy.</span></label>
        </div>
        <p className="note">Already use LoopDesk with this email (for example, invited by another company)? Enter that account's password and the new company is added to your existing login.</p>
        <div className="acts end"><button type="button" className="ic" onClick={() => { setMsg(""); setScreen("login"); }}>I already have an account</button><button className="btn" disabled={signupBusy || !signup.accept}>{signupBusy ? "Sending…" : "Create workspace"}</button></div>
      </form>)}
      {screen === "signupSent" && (<div className="signup-sent">
        <span className="signup-mail" aria-hidden="true">✉</span>
        <h2>Check your inbox</h2>
        <p>We sent a confirmation link to <b>{signupSentTo}</b>. Open it to create <b>{signup.companyName}</b> and sign in. The link expires in 24 hours.</p>
        <p className="note">Nothing arrived? Check your spam folder, or send the email again.</p>
        <div className="acts end"><button type="button" className="ic" onClick={() => { setMsg(""); setScreen("signup"); }}>Change details</button><button type="button" className="btn alt" disabled={signupBusy} onClick={submitSignup}>{signupBusy ? "Sending…" : "Send again"}</button></div>
      </div>)}
      {screen === "denied" && <p>This invitation is invalid or has expired. Please ask an admin for a new one.</p>}
      {screen === "inviteError" && <><p>We could not open this invitation because the server had a temporary problem. Your invitation is still valid.</p>{inv?.error && <p className="muted">{inv.error}</p>}<div className="acts end"><button className="btn" onClick={() => location.reload()}>Try again</button></div></>}
      {screen === "login" && (<form onSubmit={(e) => { e.preventDefault(); join("login", { id: lf.id, password: lf.password }); }}><h2>Sign in</h2>
        <div className="g"><label className="full">Email or phone number<input required autoComplete="username" {...L("id")} /></label>
          <label className="full">Password<input required type="password" autoComplete="current-password" {...L("password")} /></label></div>
        <div className="acts end"><button type="button" className="ic" onClick={() => { setMsg(""); setScreen("forgot"); }}>Forgot password?</button><button className="btn">Sign in</button></div>
        <div className="signup-cta"><span>New to LoopDesk?</span><button type="button" className="ic" onClick={() => { setMsg(""); setScreen("signup"); }}>Create your company workspace →</button></div></form>)}
      {screen === "forgot" && (<form onSubmit={async (e) => { e.preventDefault(); await api("forgot", { id: lf.id }); setMsg("If an account exists for that email or phone, a reset link has been sent."); }}><h2>Forgot password</h2>
        <div className="g"><label className="full">Email or phone number<input required {...L("id")} /></label></div>
        <div className="acts end"><button type="button" className="ic" onClick={() => { setMsg(""); setScreen("login"); }}>Back to sign in</button><button className="btn">Send reset link</button></div></form>)}
      {screen === "reset" && (<form onSubmit={async (e) => { e.preventDefault(); const r = await api("reset", { token: new URLSearchParams(location.search).get("reset"), password: lf.password }); if (!r.ok) return setMsg(r.error || "Failed"); history.replaceState(null, "", "/"); setLf({ ...lf, password: "" }); setMsg("Password updated. Please sign in."); setScreen("login"); }}><h2>Set a new password</h2>
        <div className="g"><label className="full">New password (8+ characters, letter and number)<input required type="password" minLength={8} autoComplete="new-password" {...L("password")} /></label></div>
        <div className="acts end"><button className="btn">Update password</button></div></form>)}
      {screen === "setup" && <p>No admin account exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in the .env.local file, restart the server, then sign in.</p>}
      {screen === "accept" && inv && (<form onSubmit={acceptInvite}><div className="invite-card">
          <span className="invite-from">Invitation from {inv.companyName || "your team"}</span>
          <h2>Join {inv.unitName ? `${inv.companyName} · ${inv.unitName}` : inv.companyName || inv.projectName}</h2>
          <dl>
            {inv.companyName && <><dt>Company</dt><dd>{inv.companyName}</dd></>}
            {inv.unitName && <><dt>{inv.unitKind === "subsidiary" ? "Sub-company" : "Department"}</dt><dd>{inv.unitName}</dd></>}
            <dt>Project</dt><dd>{inv.projectName}</dd>
            <dt>Your role</dt><dd>{inv.role}</dd>
            {inv.invitedBy && <><dt>Invited by</dt><dd>{inv.invitedBy}</dd></>}
            <dt>Email</dt><dd>{inv.email}</dd>
          </dl>
        </div>
        <div className="g">{inv.existing ? <label className="full">Enter your existing account password<input required type="password" autoComplete="current-password" value={invPassword} onChange={(e) => setInvPassword(e.target.value)} /></label> : <>
          <label className="full">Your name<input required {...L("name")} /></label>
          <label className="full">Create password (8+ characters, letter and number)<input required type="password" minLength={8} autoComplete="new-password" {...L("password")} /></label></>}
        </div>
        {msg && <p className="err">{msg}</p>}
        <div className="acts end"><button className="btn">{inv.existing ? "Join project" : "Create account and join"}</button></div></form>)}
      {msg && screen !== "suspended" && <p className="err">{msg}</p>}
    </div></div>
  );

  const nav = client ? [["portal", "My Tickets"], ...(canUseMeetings ? [["meetings", "Meetings"]] : [])] : [["all", "Dashboard"], ["issue", "Issues"], ["feature", "Features"], ["files", "Attachments"], ["team", "Team"], ["chat", "Team Chat"], ...(canUseMeetings ? [["meetings", "Meetings"], ["meeting-notes", "Meeting Notes"]] : []), ...(admin ? [["activity", "Activity"]] : []), ...(isPlatformAdmin ? [["platform", "Platform Admin"]] : [])];
  const firstOfMonth = new Date(meetingMonth.getFullYear(), meetingMonth.getMonth(), 1);
  const calendarStart = new Date(firstOfMonth); calendarStart.setDate(firstOfMonth.getDate() - ((firstOfMonth.getDay() + 6) % 7));
  const calendarDates = Array.from({ length: 42 }, (_, i) => { const date = new Date(calendarStart); date.setDate(calendarStart.getDate() + i); return date; });
  return (
    <div className={"app" + (navOpen ? " nav-open" : "")}>
      <div className="side-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <aside className="side" onClick={(e) => { if (e.target.closest(".nav")) setNavOpen(false); }}>
        <div className="brand"><span className="brand-mark"><img src="/loopdesk-mark.svg" alt="" /></span><div><b>LoopDesk</b><small>Team &amp; project management</small></div></div>
        <div className="project-picker">
          <label htmlFor="organization-select">COMPANY</label>
          <select id="organization-select" value={activeOrganization?.id || ""} onChange={(event) => {
            const value = event.target.value;
            if (value === "__add_child__") { setOrganizationName(""); setOrganizationKind("department"); setOrganizationModal(true); return; }
            const nextProject = projects.find((item) => item.organizationId === value);
            if (nextProject) { setProjectId(nextProject.id); setMeetingSelected(null); setMeetingDraft(""); setParticipantSummaries([]); setView(client ? "portal" : "all"); setModal(null); setDetail(null); load(key, nextProject.id); return; }
            // A department or sub-company without projects yet: offer to create its first project.
            if (organizations.find((item) => item.id === value)?.canCreateProject) { setProjectName(""); setProjectOrganizationId(value); setProjectModal(true); }
          }}>
            {orderedOrganizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.parentId ? `\u00a0\u00a0↳ ${organization.name} · ${KIND_LABEL[organization.kind] || "Unit"}` : organization.name}</option>)}
            {activeTenant?.canAddChild && <option value="__add_child__">＋ Add department or sub-company…</option>}
          </select>
          {activeOrganization?.parentId && <small className="org-trail">{activeOrganization.parentName || activeTenant?.name} › {activeOrganization.name}</small>}
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
        }}>{l}{k === "platform" ? null : k === "chat" ? chatUnread > 0 && <em className="nav-unread">{chatUnread > 9 ? "9+" : chatUnread}</em> : k !== "meeting-notes" && <em>{k === "files" ? fileTotal : k === "activity" ? auditTotal : k === "team" ? members.length : k === "meetings" ? meetingTotal : tickets.filter((t) => k === "all" || k === "portal" || t.type === k).length}</em>}</button>))}
        <button className={"nav ghost " + (view === "account" ? "on" : "")} onClick={() => { setAmsg(""); setView("account"); }}>My account</button>
        <button className="nav ghost" onClick={async () => { await api("logout", {}, key); localStorage.removeItem("rw-key"); location.reload(); }}>Sign out</button>
      </aside>
      <main className="main">
        <div className="mobile-bar">
          <button type="button" className="menu-btn" aria-label="Open menu" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <span className="brand-mark"><img src="/loopdesk-mark.svg" alt="" /></span><b>LoopDesk</b>
          <span className="mobile-view">{activeProject?.name}</span>
        </div>
        <header className="top">
          <div><h1>{{ all: "Support Dashboard", issue: "Issues Log", feature: "Features Log", team: "Team & Roles", meetings: "Meeting Calendar", "meeting-notes": "Meeting Notes & Tasks", activity: "Activity Log", files: "Attachments", account: "My Account", portal: "My Tickets", chat: "Team Chat", platform: "Platform Admin" }[view]}</h1><p><b>{activeOrganization?.name}</b> · <b>{activeProject?.name}</b> · Signed in as <b>{me.name}</b> <span className={"pill r" + me.role}>{me.role}</span></p></div>
          <div className="top-actions">
            {["issue", "feature", "portal"].includes(view) && <div className="acts">
              {view !== "issue" && <button className={"btn" + (view === "portal" ? " alt" : "")} onClick={() => setModal(blank("feature"))}>+ New Feature</button>}
              {view !== "feature" && <button className="btn" onClick={() => setModal(blank("issue"))}>+ New Issue</button>}
            </div>}
            <span className="live-dot" title="Live: changes from your team appear automatically">Live</span>
            {!client && <NotificationBell requests={meetingEditRequests.filter((item) => item.projectId === projectId)} isAdmin={!!admin} meId={me.id} notice={dashboardNotice} onReview={reviewMeetingEditRequest} />}
          </div>
        </header>

        {view === "meetings" ? (<section className="meeting-page">
          {!meetingSelected && <>
          <div className="meeting-hero">
            <div><span className="meeting-eyebrow">TEAM WORKSPACE</span><h2>One place for every team meeting</h2><p>Plan shared meetings, capture decisions, and keep follow-ups in one place across all projects.</p></div>
            <div className="meeting-hero-badge"><b>{meetings.length}</b><span>{meetings.length === 1 ? "meeting this month" : "meetings this month"}</span></div>
          </div>
          <div className="panel">
            <div className="meeting-toolbar">
              <div className="meeting-month"><button className="btn alt" aria-label="Previous month" onClick={() => { setMeetingOffset(0); setMeetingMonth(new Date(meetingMonth.getFullYear(), meetingMonth.getMonth() - 1, 1)); }}>‹</button><h2>{meetingMonth.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h2><button className="btn alt" aria-label="Next month" onClick={() => { setMeetingOffset(0); setMeetingMonth(new Date(meetingMonth.getFullYear(), meetingMonth.getMonth() + 1, 1)); }}>›</button><button className="btn alt meeting-today" onClick={() => { setMeetingOffset(0); setMeetingMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); }}>Today</button></div>
              <div className="meeting-toolbar-actions">
                <button className="btn alt" onClick={() => { setMeetingError(""); setMeetingForm({ title: "Team meeting", date: localDateKey(new Date()), time: "10:00", duration: "60", agenda: "", online: true, roomProvider: "google-meet", roomUrl: "", attendeeIds: [] }); setMeetingFormOpen((open) => !open); setInstantPickerOpen(false); }}>+ Schedule meeting</button>
                {googleCalendarConnected && <button className="btn meeting-instant" disabled={meetingBusy || meetingLocked} aria-expanded={instantPickerOpen} onClick={() => { setInstantPickerOpen((open) => !open); setMeetingFormOpen(false); }}><Ic d={VIDEO} />{meetingBusy ? "Starting…" : "Start meeting now"}</button>}
              </div>
            </div>
            {instantPickerOpen && googleCalendarConnected && <div className="meeting-create instant-picker">
              <h3>Start a Google Meet now</h3>
              <p className="meeting-invite-hint">Give the meeting a title and agenda, then select who should get the invitation and the join link. Only the people you tick are invited.</p>
              <div className="meeting-form-grid">
                <label className="meeting-agenda">Meeting title<input required maxLength={120} value={instantTitle} onChange={(e) => setInstantTitle(e.target.value)} placeholder="e.g. Sprint 12 planning" /></label>
                <label className="meeting-agenda">Agenda<textarea rows="3" maxLength="3000" value={instantAgenda} onChange={(e) => setInstantAgenda(e.target.value)} placeholder="Topics to discuss — shown in the invitation and the calendar event" /></label>
              </div>
              <fieldset className="meeting-invitees">
                <legend>Invite team members</legend>
                {members.filter((member) => member.status === "active" && member.role !== "Client" && member.id !== me.id).map((member) => (
                  <label key={member.id}><input type="checkbox" checked={instantAttendeeIds.includes(member.id)} onChange={(event) => setInstantAttendeeIds((ids) => event.target.checked ? [...ids, member.id] : ids.filter((id) => id !== member.id))} /> {member.name} <span>{member.email}</span></label>
                ))}
                {!members.some((member) => member.status === "active" && member.role !== "Client" && member.id !== me.id) && <p>No other active team members in this project.</p>}
              </fieldset>
              <div className="acts end">
                <button type="button" className="btn alt" onClick={() => setInstantPickerOpen(false)}>Cancel</button>
                <button type="button" className="btn" disabled={meetingBusy || meetingLocked || !instantTitle.trim()} title={instantTitle.trim() ? undefined : "Enter a meeting title first"} onClick={() => { const ids = instantAttendeeIds, title = instantTitle, agenda = instantAgenda; setInstantPickerOpen(false); setInstantAttendeeIds([]); setInstantTitle(""); setInstantAgenda(""); startInstantMeeting(ids, title, agenda); }}>{instantAttendeeIds.length ? `Start & invite ${instantAttendeeIds.length}` : "Start without inviting"}</button>
              </div>
            </div>}
            {!googleCalendarConnected && <div className="meet-setup">
              <span className="files-drop-icon"><Ic d={VIDEO} /></span>
              <div>
                <b>Sync meetings with Google Calendar</b>
                <span>{canManageMeetings
                  ? googleCalendarConfigured
                    ? "Connect your Google account once. After that, every meeting you schedule is added to each participant's Google Calendar (they get Google's invitation and reminder notifications), online meetings get their own Meet link automatically, and \"Start meeting now\" opens a call in one click."
                    : "One-time setup: add your Google OAuth keys (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET) in Vercel, then connect your Google account here. No more copying links from Google Meet."
                  : "Ask a project admin to connect Google Calendar so meetings appear on everyone's calendar. Until then, paste a Meet or Zoom link when scheduling."}</span>
              </div>
              {canManageMeetings && googleCalendarConfigured && <button className="btn" onClick={connectGoogleCalendar}>Connect Google Calendar</button>}
            </div>}
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
                    {googleCalendarConnected
                      ? <span className="meeting-google-status">Connected to Google Calendar{googleCalendarEmail ? ` · ${googleCalendarEmail}` : ""}</span>
                      : canManageMeetings && googleCalendarConfigured
                        ? <button type="button" className="btn alt" onClick={connectGoogleCalendar}>Connect Google Calendar</button>
                        : canManageMeetings
                          ? <span className="meeting-invite-hint">Automatic Meet links are not set up yet (see the Google Meet card above). For now, paste a Meet link below.</span>
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
              <p className="meeting-invite-hint">{googleCalendarConnected ? "The meeting will be added to every invitee's Google Calendar (and yours); Google sends each of them an invitation and reminder notifications. " : ""}{meetingForm.online ? meetingForm.roomProvider === "google-meet" ? googleCalendarConnected ? "A Google Meet room and shareable link will be created automatically when you schedule." : "Connect Google Calendar to create a shareable Meet room automatically, or paste a Meet link above. Meetings are limited to 60 minutes." : "Open Zoom, create a meeting there, then paste its shareable invite link. Meetings are limited to 60 minutes." : "This is an in-person meeting; invitees receive the date and time by email. Meetings are limited to 60 minutes."} Recording uses this device's microphone; online-call audio is not captured unless the microphone can hear the room speakers.</p>
              <div className="acts end"><button type="button" className="btn alt" onClick={() => setMeetingFormOpen(false)}>Cancel</button><button className="btn" disabled={meetingBusy}>{meetingBusy ? "Saving…" : "Schedule"}</button></div>
            </form>}
            <div className="meeting-calendar">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <div className="meeting-weekday" key={day}>{day}</div>)}
              {calendarDates.map((date) => {
                const dateKey = localDateKey(date), inMonth = date.getMonth() === meetingMonth.getMonth();
                return <div className={"meeting-day" + (inMonth ? "" : " outside") + (dateKey === localDateKey(new Date()) ? " today" : "")} key={dateKey}>
                  <span className="meeting-day-number">{date.getDate()}</span>
                  {meetings.filter((meeting) => meeting.date === dateKey).map((meeting) => <button disabled={meetingLocked} className="meeting-event" key={meeting.id + dateKey} onClick={() => openMeeting(meeting)}>
                    <b>{meeting.time}</b> {meeting.title}{meeting.online && <small>Online</small>}
                  </button>)}
                </div>;
              })}
            </div>
            {meetingsLoading && <p className="meeting-empty">Loading calendar…</p>}
            {!meetingsLoading && !meetings.length && <p className="meeting-empty">No meetings scheduled for this month. Schedule a meeting on any date to get started.</p>}
            <div className="tools"><span className="note">Showing {meetings.length ? meetingOffset + 1 : 0}–{meetingOffset + meetings.length} of {meetingTotal} meetings</span><button className="btn alt" disabled={!meetingOffset || meetingPageLoading} onClick={() => loadMeetingPage(monthKey(meetingMonth), Math.max(0, meetingOffset - 100))}>Previous</button><button className="btn alt" disabled={!meetingHasMore || meetingPageLoading} onClick={() => loadMeetingPage(monthKey(meetingMonth), meetingOffset + 100)}>{meetingPageLoading ? "Loading…" : "Next"}</button></div>
          </div>
          </>}
          {meetingSelected && <div className="meeting-workspace">
            {pendingRecording && <LocalTranscriber audio={pendingRecording} names={voiceAttendees} model="best" onProgress={setTranscriptionProgress} onComplete={onTranscriptionComplete} onError={onTranscriptionError} />}
            <header className="panel meeting-workspace-head">
              <button type="button" className="btn alt meeting-back" disabled={meetingLocked} title={meetingLocked ? "Finish or save the recording first" : undefined} onClick={closeMeeting}>← Calendar</button>
              <div className="meeting-workspace-title">
                <h2>{meetingSelected.title}</h2>
                <p>{fmt(meetingSelected.occurrenceDate)} · {meetingSelected.time} · {meetingSelected.duration} min{activeProject?.name ? ` · ${activeProject.name}` : ""}{meetingSelected.online ? " · Online" : " · In person"}</p>
              </div>
              {(meetingSelected.createdBy === me.id || canManageMeetings) && <button type="button" className="ic dl" disabled={meetingLocked} onClick={() => deleteMeeting(meetingSelected)}>Delete</button>}
            </header>
            {meetingError && <div className="meeting-alert" role="alert"><b>Action needed</b><span>{meetingError}</span></div>}
            {meetingNotice && <div className="meeting-success" role="status">{meetingNotice}</div>}
            {!canEditMeetingContent && <div className="meeting-access-banner"><div><b>View-only meeting cards</b><span>Only Admins and Collaborators can edit meeting cards and notes. Request a one-hour approval from a project admin; you can still change status on tasks assigned to you in Meeting Notes.</span></div><button type="button" className="btn" disabled={meetingBusy || meetingEditRequests.some((item) => item.projectId === projectId && item.memberId === me.id && item.status === "pending")} onClick={requestMeetingEditAccess}>{meetingEditRequests.some((item) => item.projectId === projectId && item.memberId === me.id && item.status === "pending") ? "Request pending" : "Request 1-hour edit access"}</button></div>}
            {!["Admin", "Collaborator"].includes(me.role) && meetingEditAccess && meetingEditAccessExpiresAt && <div className="meeting-access-banner active"><div><b>Temporary edit access is active</b><span>Expires {new Date(meetingEditAccessExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</span></div></div>}
            <div className="meeting-workspace-grid">
              <div className="meeting-workspace-main">
                {!!recordingTranscript && <label className="meeting-transcript-review">English transcript (AI-generated; review and correct before sharing)<textarea disabled={!canEditMeetingContent} rows="6" value={recordingTranscript} onChange={(event) => {
                  const transcript = event.target.value;
                  setRecordingTranscript(transcript);
                  const keyPoints = generateEnglishKeyPoints(transcript);
                  const baseNotes = recordingNotesStartRef.current || "";
                  setMeetingDraft(keyPoints ? (baseNotes.trim() ? `${baseNotes.trimEnd()}\n\n` : "") + keyPoints : baseNotes);
                  const suggestions = generateMeetingParticipantCards(transcript, voiceAttendees, selectedMeetingMemberId);
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
                      <label>Previous task update (one per line)<textarea disabled={!canEditMeetingContent || (!["Admin", "Collaborator"].includes(me.role) && card.memberId !== me.id)} rows="2" value={(card.points || []).join("\n")} onChange={(event) => setParticipantSummaries((items) => items.map((item) => item.memberId === card.memberId ? { ...item, points: event.target.value.split("\n") } : item))} placeholder="Summarize progress or blockers from the last task" /></label>
                      <label>Task description / context<textarea disabled={!canEditMeetingContent || (!["Admin", "Collaborator"].includes(me.role) && card.memberId !== me.id)} rows="2" value={card.description || ""} onChange={(event) => setParticipantSummaries((items) => items.map((item) => item.memberId === card.memberId ? { ...item, description: event.target.value } : item))} placeholder="Add notes or context for the assigned task" /></label>
                      <label>Priority for upcoming tasks<select disabled={!canEditMeetingContent || (!["Admin", "Collaborator"].includes(me.role) && card.memberId !== me.id)} value={card.priority || "Medium"} onChange={(event) => setParticipantSummaries((items) => items.map((item) => item.memberId === card.memberId ? { ...item, priority: event.target.value } : item))}><option>High</option><option>Medium</option><option>Low</option></select></label>
                      <label>Next tasks (one per line)<textarea disabled={!canEditMeetingContent || (!["Admin", "Collaborator"].includes(me.role) && card.memberId !== me.id)} rows="2" value={(card.tasks || []).join("\n")} onChange={(event) => setParticipantSummaries((items) => items.map((item) => item.memberId === card.memberId ? { ...item, tasks: event.target.value.split("\n") } : item))} placeholder="Write the next action; details and deadline can be managed in Meeting Notes" /></label>
                    </article>;
                  })}
                    {!selectedMeetingMemberId && <div className="meeting-member-empty"><b>Ready for the next update?</b><span>Click a team member's card above, or start recording and their turn will be selected when their name is recognized.</span></div>}
                  </div>
                </section>
                {meetingNotesOpen && <section className="panel meeting-notes-panel">
                  <label className="meeting-notes-label">Shared meeting notes<textarea disabled={!["Admin", "Collaborator"].includes(me.role)} rows="10" maxLength="20000" value={meetingDraft} onChange={(e) => setMeetingDraft(e.target.value)} placeholder="Capture decisions, action items, and follow-ups here." /></label>
                </section>}
                <div className="meeting-notes-actions">
                    {canEditMeetingContent && (!recordingClips.length || recordingSaved) && <button className="btn" disabled={meetingBusy || recordingState !== "idle"} onClick={saveMeetingNotes}>{meetingBusy ? "Saving…" : "Save notes"}</button>}
                </div>
              </div>
              <aside className="meeting-workspace-side">
                <section className="panel meeting-side-card" aria-label="Meeting details">
                  <h3>Details</h3>
                      {meetingSelected.online && <section className="meeting-room">
                        <div className="meeting-room-toolbar"><div><h3>{meetingSelected.roomProvider === "jitsi" ? "Jitsi conference room" : `${meetingSelected.roomProvider === "google-meet" ? "Google Meet" : meetingSelected.roomProvider === "zoom" ? "Zoom" : "Microsoft Teams"} conference`}</h3>{meetingSelected.roomUrl ? <a href={meetingSelected.roomUrl} target="_blank" rel="noreferrer">{meetingSelected.roomUrl}</a> : <span className="meeting-invite-hint">No shared invite link is saved.</span>}</div>
                          {meetingSelected.roomProvider === "jitsi" ? <button className="btn" onClick={() => { setMeetingNotesOpen(true); setConferenceJoined((joined) => !joined); }}>{conferenceJoined ? "Close room" : "Join in dashboard"}</button> : <a className="btn" href={meetingSelected.roomUrl || conferenceLaunchUrl(meetingSelected.roomProvider)} target="_blank" rel="noreferrer" onClick={() => setMeetingNotesOpen(true)}>{meetingSelected.roomUrl ? "Join meeting" : `Open ${meetingSelected.roomProvider === "google-meet" ? "Google Meet" : meetingSelected.roomProvider === "zoom" ? "Zoom" : "Teams"}`}</a>}
                          {meetingSelected.roomProvider === "jitsi" && <a className="btn alt" href={meetingSelected.roomUrl} target="_blank" rel="noreferrer">Open in new tab</a>}
                        </div>
                        {conferenceJoined && meetingSelected.roomProvider === "jitsi" && <JitsiMeetingEmbed roomUrl={meetingSelected.roomUrl} title={meetingSelected.title} />}
                        <p className="meeting-invite-hint">{meetingSelected.roomProvider === "jitsi" ? "Public Jitsi room: anyone with the link may join, and duration/availability is not guaranteed." : meetingSelected.roomUrl ? "The conference opens in a new tab; meeting duration and recording depend on that provider's account." : "The button opens the conference service, but does not create a shared room or send an invite link. Create the room there and share its join link with invitees."}</p>
                      </section>}
                  {meetingSelected.agenda && <div className="meeting-agenda-read"><b>Agenda</b><p>{meetingSelected.agenda}</p></div>}
                  <div className="meeting-attendee-list"><b>Meeting invitees</b><span>{(meetingSelected.attendees || []).length ? meetingSelected.attendees.map((attendee) => attendee.name).join(", ") : "No invitees selected"}</span></div>
                </section>
                <section className="panel meeting-side-card meeting-recorder" aria-label="Recording">
                  <h3>Recording</h3>
                  <div className="meeting-note-tools">
                    <p className="meeting-invite-hint">Speak in Urdu, English or a mix — notes are written in English. To fill a member's card automatically, address them by name: "Ali, apne tasks batao" / "Ali, your update".</p>
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
                    <span className={"meeting-record-status " + recordingState} aria-live="polite">{recordingState === "recording" ? `Recording · ${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")} · max 60 minutes` : recordingState === "paused" ? `Recording paused · ${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}` : recordingState === "transcribing" ? transcriptionProgress || "Translating and preparing English key points…" : "Speak in Urdu, English or a mix. Review the transcript and member cards before saving."}</span>
                  </div>
                  {!!recordingClips.length && <div className="meeting-audio-preview"><span>Recording clips ({recordingClips.length})</span><div>{recordingClips.map((clip, index) => <div key={clip.id}><label>Clip {index + 1}</label><audio controls preload="metadata" src={clip.url}>Audio preview unavailable in this browser.</audio></div>)}</div></div>}
                  {!!recordingClips.length && !recordingSaved && <div className="meeting-record-save"><span>{recordingNoteId ? "The note is saved. Retry to finish uploading its clips." : `${recordingClips.filter((clip) => clip.transcript).length} of ${recordingClips.length} clip(s) transcribed. Add more clips, then save them together as one monthly note. Cancel removes this set's generated text from Shared meeting notes.`}</span><div>{!recordingNoteId && <button className="btn alt" disabled={meetingBusy || recordingState !== "idle"} onClick={cancelRecordingNotes}>Cancel recording notes</button>}{recordingNoteId || (recordingClips.every((clip) => clip.transcript) && recordingTranscript) ? <button className="btn" disabled={!["Admin", "Collaborator"].includes(me.role) || meetingBusy || recordingState !== "idle"} onClick={saveRecordingAsNote}>{meetingBusy ? "Saving…" : "Save recording as note"}</button> : null}</div></div>}
                  {meetingVoiceError && <div className="meeting-alert meeting-voice-alert" role="alert"><b>Voice note unavailable</b><span>{meetingVoiceError}</span></div>}
                </section>
              </aside>
            </div>
          </div>}
        </section>) : view === "meeting-notes" ? <MeetingNotes projectId={projectId} keyValue={key} members={members} canDelete={admin} canManageContent={!!me && ["Admin", "Collaborator"].includes(me.role)} me={me} onAccessChange={handleMeetingAccessChange} refreshKey={liveVersion} /> : view === "portal" ? (<section className="panel"><div className="wrap"><table className="tm"><thead><tr><th>ID</th><th>Ticket</th><th>Type</th><th>Raised</th><th>Status</th><th>Completed</th><th className="ra-h">Actions</th></tr></thead><tbody>
          {[...tickets].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((t) => (<tr key={t.id}>
            <td><b className={"id " + t.type}>{t.clientRef || t.id}</b></td><td className="tt">{t.title}</td><td>{t.type === "issue" ? "Issue" : "Feature"}</td><td className="nw">{fmt(t.date)}</td>
            <td><span className={"pill st " + t.status.replace(" ", "")}>{t.status}</span></td><td className="nw">{fmt(t.closed)}</td>
            <td className="ra"><div className="row-actions">
              {t.status === "Completed"
                ? <button className="ic reopen" title="Not satisfied? Reopen this ticket" onClick={() => reopen(t)}>Reopen</button>
                : <button className="ic" title="Edit" aria-label="Edit" onClick={() => setModal({ ...t })}><Ic d={PEN} /></button>}
              <button className="ic" title="View details, solution and attachments" aria-label="View details" onClick={() => setDetail(t.id)}><Ic d={EYE} /></button>
              <button className="ic dl" title="Delete ticket" aria-label="Delete ticket" onClick={() => deleteOwnTicket(t)}><Ic d={TRASH} /></button></div></td></tr>))}
          {!tickets.length && <tr><td colSpan="7" className="empty">You have not raised any tickets yet. Use the buttons above to raise one.</td></tr>}</tbody></table></div>
          <div className="tools"><span className="note">Showing {tickets.length ? ticketOffset + 1 : 0}–{ticketOffset + tickets.length} of {ticketTotal} tickets</span><button className="btn alt" disabled={ticketOffset === 0 || ticketPageLoading} onClick={() => loadTicketPage(Math.max(0, ticketOffset - 100))}>Previous</button><button className="btn alt" disabled={!ticketHasMore || ticketPageLoading} onClick={() => loadTicketPage(ticketOffset + 100)}>{ticketPageLoading ? "Loading…" : "Next"}</button></div></section>) : view === "account" ? (<section className="acc">
          <div className="panel"><h3>Profile</h3>
            <div className="prof"><span className="av">{me.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span><div><b>{me.name}</b><div className="dd">{me.email}</div><span className={"pill r" + me.role}>{me.role}</span></div></div>
            <form onSubmit={(e) => saveAcct(e, false)}><div className="g">
              <label>Full name<input required {...A("name")} /></label><label>Phone number<input type="tel" {...A("phone")} /></label>
              <label>Email<input disabled value={me.email} /></label><label>Role<input disabled value={me.role} /></label></div>
              <div className="acts end"><button className="btn">Save profile</button></div></form></div>
          <div className="panel"><h3>Security</h3>
            {!pwOpen ? <div className="pw-closed"><div><b>Password</b><span>Use a strong password you do not use anywhere else.</span></div><button type="button" className="btn" onClick={() => { setAmsg(""); setAcct({ ...acct, current: "", password: "", confirm: "" }); setPwOpen(true); }}>Change password</button></div>
            : <form className="pw-form" onSubmit={(e) => saveAcct(e, true)}><div className="g">
              {me.hasPw && <label className="full">Current password<input required type="password" autoComplete="current-password" {...A("current")} /></label>}
              <label>New password<input required type="password" minLength={8} autoComplete="new-password" {...A("password")} /></label>
              <label>Confirm new password<input required type="password" minLength={8} autoComplete="new-password" {...A("confirm")} /></label></div>
              <p className="note">8+ characters with at least one letter and one number.</p>
              <div className="acts end"><button type="button" className="btn alt" onClick={() => { setPwOpen(false); setAmsg(""); }}>Cancel</button><button className="btn">Update password</button></div></form>}
            <div className="acts"><button className="btn alt" onClick={async () => { if (confirm("Sign out of all devices?")) { await api("logoutall", {}, key); localStorage.removeItem("rw-key"); location.reload(); } }}>Sign out of all devices</button></div>
            {amsg && <p className="err">{amsg}</p>}</div>
        </section>) : view === "files" ? (<section className="panel files-page">
          <div className="subtabs" role="tablist">{CATS.map((c, i) => (<button key={c} role="tab" aria-selected={fc === i} className={"tab " + (fc === i ? "on" : "")} onClick={() => setFc(i)}>{c}<em>{files.filter((x) => x.cat === c).length}</em></button>))}</div>
          <div className="files-add">
            <label className={"files-drop" + (dragOver ? " over" : "") + (uploading ? " busy" : "")}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) uploadOne(f); }}>
              <input type="file" className="sr-only" accept={ATTACHMENT_ACCEPT} disabled={uploading} onChange={uploadFile} />
              <span className="files-drop-icon"><Ic d={UPLOAD} /></span>
              <span className="files-drop-text"><b>{uploading ? "Uploading…" : <>Click to upload <span>or drag a file here</span></>}</b><small>Saved to <strong>{CATS[fc]}</strong></small><small>{ATTACHMENT_HINT}</small></span>
            </label>
            <form className="files-link" onSubmit={(e) => { e.preventDefault(); addLink(); }}>
              <div className="files-link-head"><span className="files-drop-icon small"><Ic d={LINK} /></span><div><b>Add a document link</b><small>Google Drive, Docs, Figma, Notion…</small></div></div>
              <div className="files-link-fields">
                <input type="url" required placeholder="https://…" aria-label="Document link" value={lk.url} onChange={(e) => setLk({ ...lk, url: e.target.value })} />
                <input placeholder="Name (optional)" aria-label="Link name" value={lk.name} onChange={(e) => setLk({ ...lk, name: e.target.value })} />
                <button className="btn">Add link</button>
              </div>
            </form>
          </div>
          {files.some((x) => x.cat === CATS[fc]) ? <div className="wrap files-wrap"><table className="tm files-table"><thead><tr><th>File</th><th>Size</th><th>Uploaded by</th><th>Date</th><th>Ticket</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
            {files.filter((x) => x.cat === CATS[fc]).map((a) => (<tr key={a.id}><td className="tt files-name">{a.url ? <a className="fl" href={fh(a)} target="_blank" rel="noreferrer"><Ic d={a.url ? LINK : CLIP} /> <span>{a.name}</span></a> : <button type="button" className="fl" onClick={() => openFile(a)}><Ic d={CLIP} /> <span>{a.name}</span></button>}</td><td className="nw" data-label="Size">{a.url ? "Link" : Math.ceil(a.size / 1024) + " KB"}</td><td data-label="Uploaded by">{a.by}</td><td className="nw" data-label="Date">{fmt(a.at)}</td><td className="nw" data-label="Ticket">{a.ticket || "-"}</td>
              <td className="ra files-actions">{a.url ? <a className="ic" href={fh(a)} target="_blank" rel="noreferrer">Open link</a> : <button type="button" className="ic" onClick={() => openFile(a)}>Download</button>}{canDeleteFiles && <button type="button" className="ic dl" aria-label={"Delete " + a.name} onClick={() => confirm("Delete " + a.name + "?") && adm("filedel", { id: a.id })}><Ic d={TRASH} /></button>}</td></tr>))}
            </tbody></table></div> : <div className="files-empty"><span className="files-drop-icon"><Ic d={CLIP} /></span><b>No files in {CATS[fc]} yet</b><span>Upload a file or add a link above. Ticket attachments appear here too.</span></div>}
          <div className="tools"><span className="note">Showing {files.length ? fileOffset + 1 : 0}–{fileOffset + files.length} of {fileTotal} files</span><button className="btn alt" disabled={!fileOffset || fileLoading} onClick={() => loadFilePage(Math.max(0, fileOffset - 100))}>Previous</button><button className="btn alt" disabled={!fileHasMore || fileLoading} onClick={() => loadFilePage(fileOffset + 100)}>{fileLoading ? "Loading…" : "Next"}</button></div>
        </section>) : view === "platform" && isPlatformAdmin ? <PlatformConsole keyValue={key} /> : view === "activity" ? <ActivityLog audit={audit} offset={auditOffset} total={auditTotal} hasMore={auditHasMore} loading={auditLoading} onPage={loadAuditPage} /> : view === "chat" ? <TeamChat key={projectId} projectId={projectId} keyValue={key} me={me} members={members} projectName={activeProject?.name || ""} organizationName={activeOrganization?.name || ""} pulseChannels={pulseChannels} lastRead={chatRead} onRead={markChatRead} onOpenTicket={openTicket} /> : view === "team" ? (<>
          {admin && (<section className="panel"><h3>Invite a member to {activeProject?.name}</h3>
            <p className="note">This invitation is for <b>{activeProject?.name}</b> only. Members can have different roles in other projects.</p>
            <form className="tools" onSubmit={sendInvite}>
              <input required type="email" placeholder="Email address" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
              <button className="btn">Send invite</button></form>
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
          <p className="note">Roles and team membership apply only to {activeProject?.name} in {activeOrganization?.name}. Admin and Collaborator: full access to tickets (create, edit, assign, change status, delete). Developer: sees only the tickets assigned to them or raised by them (with their attachments and meeting-note tasks), can create tickets and edit or change the status of their own tickets; cannot reassign or delete. Assignees are emailed the full task when they are assigned. For meeting cards, saved meeting notes, and task details, only Admins and Collaborators can edit; other team members can change status on tasks assigned to them or request one-hour admin-approved edit access. Client: sees only tickets they raised in this project; can create, update, reopen and delete them.</p></section>
        </>) : (<>
          {view === "all" ? <Dashboard key={projectId} apiGet={(path) => api(path, null, key, projectId)} members={members} projectName={activeProject?.name || ""} onOpenTicket={openTicket} refreshKey={liveVersion} /> : (
          <section className="panel">
            <div className="tools">
              <input placeholder="Search by ID, title, details..." value={q} onChange={(e) => setQ(e.target.value)} />
              <select value={fm} onChange={(e) => setFm(e.target.value)}><option value="">All months</option>{months.map((m) => <option key={m} value={m}>{ml(m)}</option>)}</select>
              <select value={fs} onChange={(e) => setFs(e.target.value)}><option value="">All statuses</option>{STATUS.map((s) => <option key={s}>{s}</option>)}</select>
              <select value={fp} onChange={(e) => setFp(e.target.value)}><option value="">All priorities</option>{PRIO.map((s) => <option key={s}>{s}</option>)}</select>
              <select value={fa} onChange={(e) => setFa(e.target.value)}><option value="">All assignees</option><option value="none">Unassigned</option>{members.filter((x) => x.role !== "Client").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
              <button type="button" className="btn alt export-btn" disabled={!rows.length} title={`Download the ${rows.length} ticket(s) shown below as an Excel CSV`} onClick={exportCsv}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>Export CSV</button>
            </div>
            <p className="note">Showing {tickets.length ? ticketOffset + 1 : 0}–{ticketOffset + tickets.length} of {ticketTotal} tickets. Search and filters apply to this page.{me.role === "Developer" && " You see only the tickets assigned to you or raised by you."}</p>
            <div className="wrap"><table>
              <thead><tr><th>ID</th><th>Ticket</th><th>Raised</th><th>Priority</th><th>Assignee</th><th>Release</th><th>Status</th><th>Completed</th><th className="ra-h">Actions</th></tr></thead>
              <tbody>
                {rows.map((t) => (<tr key={t.id}>
                    <td><b className={"id " + t.type}>{t.id}</b></td>
                    <td><div className="tt">{t.title}</div></td>
                    <td className="nw">{fmt(t.date)}<div className="dd">{t.by}</div></td>
                    <td>{t.by === "Client" ? <select className={"psel " + (t.priority || "none")} disabled={!canEditTicket(t)} value={t.priority || ""} onChange={(e) => patch(t.id, { priority: e.target.value })}><option value="">Set priority</option>{PRIO.map((x) => <option key={x}>{x}</option>)}</select> : <span className={"pill " + t.priority}>{t.priority}</span>}</td>
                    <td><Assign t={t} members={members.filter((x) => x.role !== "Client")} can={manager} onChange={(v) => patch(t.id, { assignees: v })} /></td>
                    <td className="nw">{t.version || "-"}<div className="dd">{fmt(t.deployed)}</div></td>
                    <td><select className={"st " + t.status.replace(" ", "")} disabled={!canEditTicket(t)} title={canEditTicket(t) ? undefined : "Only the assignee, an admin or a collaborator can change this"} value={t.status} onChange={(e) => setStatus(t, e.target.value)}>{STATUS.map((s) => <option key={s}>{s}</option>)}</select></td>
                    <td className="nw">{fmt(t.closed)}{t.deadline && <div className="dd">Due {fmt(t.deadline)}</div>}</td>
                    <td className="ra"><div className="row-actions">
                      <button className="ic" title="View details and attachments" aria-label="View details" onClick={() => setDetail(t.id)}><Ic d={EYE} /></button>
                      <button className={"ic" + (canEditTicket(t) ? "" : " ghost-slot")} title="Edit" aria-label="Edit" disabled={!canEditTicket(t)} aria-hidden={!canEditTicket(t)} tabIndex={canEditTicket(t) ? 0 : -1} onClick={() => setModal({ ...t })}><Ic d={PEN} /></button>
                      <button className="ic dl" disabled={!canDel(t)} title={canDel(t) ? "Delete" : "Only admins and collaborators can delete tickets"} aria-label="Delete" onClick={() => del(t)}><Ic d={TRASH} /></button>
                    </div></td></tr>))}
                {!rows.length && <tr><td colSpan="9" className="empty">No tickets found.</td></tr>}
              </tbody>
            </table></div>
            <div className="tools">
              <button className="btn alt" disabled={ticketOffset === 0 || ticketPageLoading} onClick={() => loadTicketPage(Math.max(0, ticketOffset - 100))}>Previous</button>
              <button className="btn alt" disabled={!ticketHasMore || ticketPageLoading} onClick={() => loadTicketPage(ticketOffset + 100)}>{ticketPageLoading ? "Loading…" : "Next"}</button>
            </div>
          </section>)}
        </>)}
      </main>

      {modal && (<div className="ov" onClick={() => setModal(null)}><form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{modal.id ? "Edit " + modal.id : "New " + (modal.type === "issue" ? "Issue" : "Feature")}</h2>
        <div className="g">
          <label className="full">Title<input required {...f("title")} /></label>
          {!client && (<>
          <label>Priority<select {...f("priority")}>{modal.by === "Client" && <option value="">Not set</option>}{PRIO.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label>Status<select {...f("status")}>{STATUS.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label>Raised by<select disabled={!manager && !!modal.id} {...f("by")}><option>Team</option><option>Client</option></select></label>
          <label>Assignees<Assign t={modal} members={members.filter((x) => x.role !== "Client")} can={manager || !modal.id} onChange={(v) => setModal({ ...modal, assignees: v })} /></label>
          <label>Raised / requested on<input type="date" {...f("date")} /></label>
          <label>Version<input placeholder="1.0.1" {...f("version")} /></label>
          <label>Deployed on<input type="date" {...f("deployed")} /></label>
          <label>Deadline<input type="date" {...f("deadline")} /></label>
          <label>Client (notified when closed)<select disabled={!manager && !!modal.id} {...f("createdBy")}><option value="">None</option>{members.filter((x) => x.role === "Client").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          </>)}
          {client && <p className="note full">The date is added automatically.</p>}
          <label className="full">{client ? "Description" : "Description / fix details"}<textarea rows="4" maxLength={DESCRIPTION_CHAR_LIMIT} aria-invalid={wordCount(modal.details) > DESCRIPTION_WORD_LIMIT} {...f("details")} />
            <small className={"word-count" + (wordCount(modal.details) > DESCRIPTION_WORD_LIMIT ? " over" : "")} aria-live="polite">{wordCount(modal.details)} / {DESCRIPTION_WORD_LIMIT} words{wordCount(modal.details) > DESCRIPTION_WORD_LIMIT ? " — please shorten the description" : ""}</small></label>
          {!client && <label className="full">Resolution / solution (shown to the client)<textarea rows="3" {...f("resolution")} /></label>}
          <div className="full ab"><b>Attachments</b>
            <div className="tools up"><select value={modal._cat || CATS[CATS.length - 1]} onChange={(e) => setModal({ ...modal, _cat: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
              <input type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={(e) => {
                const picked = [...e.target.files];
                const problems = picked.map(attachmentError).filter(Boolean);
                if (problems.length) { alert(problems.join("\n")); e.target.value = ""; }
                setModal({ ...modal, _files: problems.length ? [] : picked });
              }} /></div>
            <p className="note">{ATTACHMENT_HINT}</p>
            <div className="tools up"><input placeholder="Or paste a link (Google Drive, Docs...)" value={modal._url || ""} onChange={(e) => setModal({ ...modal, _url: e.target.value })} />
              <input placeholder="Link name (optional)" value={modal._uname || ""} onChange={(e) => setModal({ ...modal, _uname: e.target.value })} /></div></div>
        </div>
        <div className="acts end"><button type="button" className="btn alt" onClick={() => setModal(null)}>Cancel</button><button className="btn" disabled={!!descriptionError(modal.details)}>Save ticket</button></div>
      </form></div>)}

      {projectModal && (<div className="ov" onClick={() => setProjectModal(false)}><form className="modal project-modal" onClick={(e) => e.stopPropagation()} onSubmit={createProject}>
        <h2>Add a project</h2>
        <p className="note">Each company can have multiple isolated projects. Project members, notes, tasks, files, and meetings stay scoped to their project.</p>
        <label>Company, department or sub-company<select required value={projectOrganizationId} onChange={(event) => setProjectOrganizationId(event.target.value)}>{orderedOrganizations.filter((item) => item.canCreateProject || item.id === projectOrganizationId).map((organization) => <option key={organization.id} value={organization.id}>{orgLabel(organization)}</option>)}</select></label>
        <label>Project name<input autoFocus required maxLength={60} value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="e.g. DocuTect" /></label>
        <div className="acts end"><button type="button" className="btn alt" onClick={() => setProjectModal(false)}>Cancel</button><button className="btn">Create project</button></div>
      </form></div>)}
      {organizationModal && (<div className="ov" onClick={() => setOrganizationModal(false)}><form className="modal project-modal" onClick={(e) => e.stopPropagation()} onSubmit={createOrganization}>
        <h2>Add to {activeTenant?.name}</h2>
        <p className="note">Organize {activeTenant?.name} into departments or sub-companies. Each one gets its own projects; {activeTenant?.name}'s admins can manage all of them.</p>
        <div className="org-kind" role="radiogroup" aria-label="Type">
          {[["department", "Department", "A team inside the company, e.g. Marketing, Development, HR"], ["subsidiary", "Sub-company", "A separate business owned by the company, e.g. a branch or brand"]].map(([value, label, hint]) =>
            <label key={value} className={organizationKind === value ? "on" : ""}><input type="radio" name="org-kind" value={value} checked={organizationKind === value} onChange={() => setOrganizationKind(value)} /><b>{label}</b><small>{hint}</small></label>)}
        </div>
        <label>{organizationKind === "subsidiary" ? "Sub-company name" : "Department name"}<input autoFocus required maxLength={80} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} placeholder={organizationKind === "subsidiary" ? "e.g. Solexes Dubai" : "e.g. Mobile Development"} /></label>
        <div className="acts end"><button type="button" className="btn alt" onClick={() => setOrganizationModal(false)}>Cancel</button><button className="btn">Create {organizationKind === "subsidiary" ? "sub-company" : "department"}</button></div>
      </form></div>)}

      {dt && (<div className="ov" onClick={() => setDetail(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2><b className={"id " + dt.type}>{client ? dt.clientRef || dt.id : dt.id}</b> {dt.title}{!client && dt.clientRef && <small className="muted"> (client's {dt.clientRef})</small>}</h2>
        <div className="meta">{!client && <span className={"pill " + dt.priority}>{dt.priority}</span>}<span className={"pill st " + dt.status.replace(" ", "")}>{dt.status}</span>
          <span>Raised {fmt(dt.date)} by {dt.by}</span>{!client && <span>Assignees: {anames(dt.assignees)}</span>}{dt.deadline && <span>Deadline: {fmt(dt.deadline)}</span>}{dt.owner && !client && <span>Worked by: {dt.owner}</span>}</div>
        <h4>Description</h4><p className="desc">{dt.details || "No description."}</p>
        {dt.resolution && <><h4>Resolution</h4><p className="desc">{dt.resolution}</p></>}
        {(dt.notes || []).length > 0 && <><h4>History</h4>{dt.notes.map((n, i) => <p key={i} className="dd">{fmt(n.at)} - {n.by}: {n.text}</p>)}</>}
        <h4>Attachments</h4>
        {files.filter((x) => x.ticket === dt.id).map((a) => (<div className="att" key={a.id}>{a.url ? <a href={fh(a)} target="_blank" rel="noreferrer"><Ic d={CLIP} /> {a.name}</a> : <button type="button" className="att-link" onClick={() => openFile(a)}><Ic d={CLIP} /> {a.name}</button>}<small>{a.cat}{a.url ? ", link" : ""}</small></div>))}
        {!files.some((x) => x.ticket === dt.id) && <small>No attachments</small>}
        <div className="acts end">{client && dt.status === "Completed" && <button className="btn" onClick={() => reopen(dt)}>Not satisfied? Reopen</button>}<button className="btn alt" onClick={() => setDetail(null)}>Close</button></div>
      </div></div>)}
    </div>
  );
}
