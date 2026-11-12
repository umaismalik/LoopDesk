"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Slack-style team communication for a project: public and private channels plus direct messages.
// The open conversation polls for new, edited and deleted messages every few seconds.
const POLL_MS = 2500;
const GROUP_GAP_MS = 5 * 60 * 1000;
const COLORS = ["#4f46e5", "#0f9f8f", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#dc2626"];
const colorFor = (id) => COLORS[[...String(id || "")].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % COLORS.length];
const initials = (name) => String(name || "?").split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayLabel = (ms) => {
  const d = new Date(ms), today = new Date(), yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};
const HASH = "M4 9h16M4 15h16M10 3L8 21M16 3l-2 18";
const LOCK = "M5 11h14v10H5zM8 11V7a4 4 0 018 0v4";
const PLUS = "M12 5v14M5 12h14";
const Svg = ({ d, size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

export default function TeamChat({ projectId, keyValue, me, members, projectName, organizationName, pulseChannels, lastRead, onRead, onOpenTicket }) {
  const [channels, setChannels] = useState([]);
  const [teamIds, setTeamIds] = useState([]);
  const [reactionSet, setReactionSet] = useState(["👍", "✅", "🎉", "👀"]);
  const [activeId, setActiveId] = useState(() => { try { return localStorage.getItem(`rw-chat-active:${projectId}`) || ""; } catch { return ""; } });
  const [messages, setMessages] = useState([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [filter, setFilter] = useState("");
  const [messageSearch, setMessageSearch] = useState("");
  const [editing, setEditing] = useState(null);
  const [reactingTo, setReactingTo] = useState(null);
  const [modal, setModal] = useState(null);
  const [mention, setMention] = useState(null);
  const [mobilePane, setMobilePane] = useState("list");
  const [unreadMarker, setUnreadMarker] = useState(0);
  const listRef = useRef(null);
  const composerRef = useRef(null);
  const updatedRef = useRef(0);
  const stickRef = useRef(true);

  const call = useCallback(async (query, body) => {
    try {
      const response = await fetch(`/api/chat?project=${encodeURIComponent(projectId)}${query ? "&" + query : ""}`, {
        method: body ? "POST" : "GET",
        headers: { "x-key": keyValue, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      const result = await response.json().catch(() => ({}));
      if (result.setup) setSetupNeeded(true);
      return { ...result, ok: response.ok, status: response.status };
    } catch (e) {
      return { ok: false, error: "Unable to reach the server" };
    }
  }, [projectId, keyValue]);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const team = useMemo(() => teamIds.map((id) => memberById.get(id)).filter(Boolean), [teamIds, memberById]);
  const nameOf = (id) => memberById.get(id)?.name || (id === me.id ? me.name : "Former member");
  const dmPartner = (channel) => channel.memberIds.find((id) => id !== me.id) || me.id;
  const titleOf = (channel) => channel ? (channel.kind === "dm" ? nameOf(dmPartner(channel)) : channel.name) : "";
  const active = channels.find((c) => c.id === activeId) || null;

  const loadChannels = useCallback(async () => {
    const result = await call("");
    if (!result.ok) { setError(result.error || "Could not load channels"); return; }
    setSetupNeeded(false); setError("");
    setChannels(result.channels || []);
    setTeamIds(result.team || []);
    if (result.reactions?.length) setReactionSet(result.reactions);
    setActiveId((current) => (result.channels || []).some((c) => c.id === current) ? current : (result.channels || []).find((c) => c.name === "general")?.id || result.channels?.[0]?.id || "");
  }, [call]);
  useEffect(() => { loadChannels(); }, [loadChannels]);

  // A channel created elsewhere (or one we were just added to) shows up in the live pulse first.
  useEffect(() => {
    if (!pulseChannels?.length) return;
    const known = new Set(channels.map((c) => c.id));
    if (pulseChannels.some((c) => !known.has(c.id))) loadChannels();
    else setChannels((list) => list.map((c) => {
      const p = pulseChannels.find((x) => x.id === c.id);
      return p && p.lastMessageAt !== c.lastMessageAt ? { ...c, lastMessageAt: p.lastMessageAt, lastAuthorId: p.lastAuthorId } : c;
    }));
  }, [pulseChannels]); // eslint-disable-line react-hooks/exhaustive-deps

  const merge = (incoming) => setMessages((list) => {
    const map = new Map(list.map((m) => [m.id, m]));
    incoming.forEach((m) => map.set(m.id, m));
    incoming.forEach((m) => { updatedRef.current = Math.max(updatedRef.current, m.updatedAt || m.createdAt); });
    return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
  });

  // Open a conversation: load its latest messages and remember where the unread ones start.
  useEffect(() => {
    if (!activeId) return;
    try { localStorage.setItem(`rw-chat-active:${projectId}`, activeId); } catch {}
    let cancelled = false;
    setMessages([]); setEditing(null); setReactingTo(null); setMessageSearch(""); updatedRef.current = 0; stickRef.current = true;
    setUnreadMarker(lastRead?.[activeId] || 0);
    setLoadingMessages(true);
    call(`channel=${encodeURIComponent(activeId)}&limit=80`).then((result) => {
      if (cancelled) return;
      setLoadingMessages(false);
      if (!result.ok) { setError(result.error || "Could not load messages"); return; }
      merge(result.messages || []);
      setHasOlder(!!result.hasMore);
    });
    return () => { cancelled = true; };
  }, [activeId, call]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the open conversation for new, edited and deleted messages.
  useEffect(() => {
    if (!activeId) return;
    const timer = setInterval(async () => {
      if (document.hidden || !updatedRef.current) return;
      const result = await call(`channel=${encodeURIComponent(activeId)}&after=${updatedRef.current}&limit=200`);
      if (result.ok && result.messages?.length) merge(result.messages);
      if (!result.ok && result.status === 404) loadChannels();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [activeId, call, loadChannels]);

  // Everything visible in the open conversation counts as read.
  const newest = messages.length ? messages[messages.length - 1].createdAt : 0;
  useEffect(() => {
    if (activeId && newest && !document.hidden) onRead(activeId, Math.max(newest, active?.lastMessageAt || 0));
  }, [activeId, newest, active?.lastMessageAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stay pinned to the bottom unless the reader scrolled up to read history.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const onScroll = () => {
    const el = listRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const loadOlder = async () => {
    if (!messages.length) return;
    const el = listRef.current, before = el?.scrollHeight || 0;
    const result = await call(`channel=${encodeURIComponent(activeId)}&before=${messages[0].createdAt}&limit=80`);
    if (!result.ok) return;
    stickRef.current = false;
    merge(result.messages || []);
    setHasOlder(!!result.hasMore);
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - before; });
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || !active || sending) return;
    setSending(true); setError("");
    const result = await call("", { action: "send", channelId: active.id, body });
    setSending(false);
    if (!result.ok) { setError(result.error || "Message not sent"); return; }
    setDraft(""); setMention(null); stickRef.current = true;
    merge([result.message]);
    setChannels((list) => list.map((c) => c.id === active.id ? { ...c, lastMessageAt: result.message.createdAt, lastAuthorId: me.id } : c));
    composerRef.current?.focus();
  };
  const saveEdit = async () => {
    if (!editing) return;
    const result = await call("", { action: "edit", messageId: editing.id, body: editing.body });
    if (!result.ok) { setError(result.error || "Could not edit message"); return; }
    merge([result.message]); setEditing(null);
  };
  const removeMessage = async (message) => {
    if (!confirm("Delete this message for everyone?")) return;
    const result = await call("", { action: "delete-message", messageId: message.id });
    if (!result.ok) { setError(result.error || "Could not delete message"); return; }
    merge([result.message]);
  };
  const react = async (message, emoji) => {
    setReactingTo(null);
    const result = await call("", { action: "react", messageId: message.id, emoji });
    if (result.ok) merge([result.message]); else setError(result.error || "Could not react");
  };
  const openDm = async (memberId) => {
    const result = await call("", { action: "open-dm", memberId });
    if (!result.ok) { setError(result.error || "Could not open conversation"); return; }
    setChannels((list) => list.some((c) => c.id === result.channel.id) ? list : [...list, result.channel]);
    setActiveId(result.channel.id); setModal(null); setMobilePane("chat");
  };
  const submitChannel = async (event) => {
    event.preventDefault();
    const result = await call("", { action: "create-channel", name: modal.name, topic: modal.topic, isPrivate: modal.isPrivate, memberIds: modal.memberIds });
    if (!result.ok) { setModal({ ...modal, error: result.error || "Could not create channel" }); return; }
    setChannels((list) => [...list, result.channel]);
    setActiveId(result.channel.id); setModal(null); setMobilePane("chat");
  };
  const saveChannelDetails = async (event) => {
    event.preventDefault();
    const result = await call("", { action: "update-channel", channelId: active.id, topic: modal.topic, ...(active.isPrivate ? { memberIds: modal.memberIds } : {}) });
    if (!result.ok) { setModal({ ...modal, error: result.error || "Could not save" }); return; }
    setChannels((list) => list.map((c) => c.id === result.channel.id ? result.channel : c)); setModal(null);
  };
  const removeChannel = async () => {
    if (!confirm(`Delete #${active.name} and all of its messages? This cannot be undone.`)) return;
    const result = await call("", { action: "delete-channel", channelId: active.id });
    if (!result.ok) { setModal({ ...modal, error: result.error || "Could not delete channel" }); return; }
    setModal(null); setActiveId(""); loadChannels();
  };

  // @mention autocomplete in the composer.
  const onDraftChange = (event) => {
    const value = event.target.value;
    setDraft(value);
    const caret = event.target.selectionStart;
    const match = value.slice(0, caret).match(/(^|\s)@([\p{L} ]{0,20})$/u);
    if (match && !/\s{2}/.test(match[2])) {
      const q = match[2].toLowerCase();
      const options = team.filter((m) => m.id !== me.id && m.name.toLowerCase().startsWith(q.trimStart())).slice(0, 6);
      setMention(options.length ? { start: caret - match[2].length - 1, end: caret, options, index: 0 } : null);
    } else setMention(null);
  };
  const pickMention = (member) => {
    const next = draft.slice(0, mention.start) + "@" + member.name + " " + draft.slice(mention.end);
    setDraft(next); setMention(null);
    requestAnimationFrame(() => { const pos = mention.start + member.name.length + 2; composerRef.current?.focus(); composerRef.current?.setSelectionRange(pos, pos); });
  };
  const onComposerKey = (event) => {
    if (mention) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMention({ ...mention, index: (mention.index + (event.key === "ArrowDown" ? 1 : -1) + mention.options.length) % mention.options.length });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pickMention(mention.options[mention.index]); return; }
      if (event.key === "Escape") { setMention(null); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
  };
  const wrapSelection = (marker) => {
    const el = composerRef.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const next = draft.slice(0, s) + marker + draft.slice(s, e) + marker + draft.slice(e);
    setDraft(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + marker.length, e + marker.length); });
  };

  // Message text: **bold**, `code`, links, @mentions and clickable ticket IDs.
  const mentionRe = useMemo(() => {
    const names = [...new Set(members.flatMap((m) => [m.name, m.name.split(/\s+/)[0]]))].filter(Boolean).sort((a, b) => b.length - a.length).map(escapeRe);
    return names.length ? `@(?:${names.join("|")})` : "@\\u0000";
  }, [members]);
  const renderBody = (text, highlight) => {
    const re = new RegExp(`(https?:\\/\\/[^\\s<]+)|(\\*\\*[^*\\n]+\\*\\*)|(\`[^\`\\n]+\`)|(${mentionRe})|(\\b(?:ISS|FTR)-\\d+\\b)`, "g");
    const mark = (s, key) => {
      if (!highlight) return s;
      const parts = s.split(new RegExp(`(${escapeRe(highlight)})`, "ig"));
      return parts.map((p, i) => p.toLowerCase() === highlight.toLowerCase() ? <mark key={key + "m" + i}>{p}</mark> : p);
    };
    return text.split("\n").map((line, li) => {
      const out = [];
      let last = 0, m;
      while ((m = re.exec(line))) {
        if (m.index > last) out.push(mark(line.slice(last, m.index), `${li}t${last}`));
        const k = `${li}-${m.index}`;
        if (m[1]) out.push(<a key={k} href={m[1]} target="_blank" rel="noreferrer noopener">{m[1]}</a>);
        else if (m[2]) out.push(<strong key={k}>{mark(m[2].slice(2, -2), k)}</strong>);
        else if (m[3]) out.push(<code key={k}>{m[3].slice(1, -1)}</code>);
        else if (m[4]) out.push(<span key={k} className={"chat-mention" + (m[4].slice(1) === me.name || m[4].slice(1) === me.name.split(/\s+/)[0] ? " me" : "")}>{m[4]}</span>);
        else if (m[5]) out.push(<button key={k} type="button" className="chat-ticket" onClick={() => onOpenTicket(m[5])}>{m[5]}</button>);
        last = m.index + m[0].length;
      }
      if (last < line.length) out.push(mark(line.slice(last), `${li}t${last}`));
      return <Fragment key={li}>{li > 0 && <br />}{out}</Fragment>;
    });
  };

  const unread = (c) => c.lastMessageAt > (lastRead?.[c.id] || 0) && c.lastAuthorId !== me.id && c.id !== activeId;
  const f = filter.trim().toLowerCase();
  const publicChannels = channels.filter((c) => c.kind === "channel" && (!f || c.name.includes(f)));
  const dms = channels.filter((c) => c.kind === "dm" && (!f || titleOf(c).toLowerCase().includes(f)))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  const dmPartners = new Set(channels.filter((c) => c.kind === "dm").map(dmPartner));
  const shown = messageSearch.trim() ? messages.filter((m) => !m.deleted && m.body.toLowerCase().includes(messageSearch.trim().toLowerCase())) : messages;
  const firstUnreadId = useMemo(() => unreadMarker ? messages.find((m) => m.createdAt > unreadMarker && m.authorId !== me.id)?.id || "" : "", [messages, unreadMarker, me.id]);
  const canPost = !(active?.kind === "channel" && active?.name === "announcements" && !["Admin", "Collaborator"].includes(me.role));
  const canManageChannel = active?.kind === "channel" && (active.createdBy === me.id || me.role === "Admin");
  const memberCount = active ? (active.kind === "channel" && !active.isPrivate ? team.length : active.memberIds.length) : 0;

  if (setupNeeded) return <section className="panel chat-setup">
    <span className="chat-setup-icon"><Svg d={HASH} size={22} /></span>
    <h2>Team chat needs a one-time database update</h2>
    <p>Open the Supabase dashboard → <b>SQL Editor</b>, paste the contents of <code>supabase.sql</code> from this repository and run it. It adds the chat and live-update tables without touching existing data. Then reload this page.</p>
    <button type="button" className="btn" onClick={() => { setSetupNeeded(false); loadChannels(); }}>I have run it — try again</button>
  </section>;

  return <section className={"chat" + (mobilePane === "chat" ? " show-chat" : "")}>
    <aside className="chat-side">
      <div className="chat-workspace">
        <span className="chat-workspace-mark">{initials(projectName)}</span>
        <div><b>{projectName}</b><small>{organizationName}</small></div>
      </div>
      <div className="chat-find"><input type="search" placeholder="Jump to…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter conversations" /></div>
      <div className="chat-section">
        <div className="chat-section-head"><span>Channels</span><button type="button" className="chat-add" title="Create a channel" aria-label="Create a channel" onClick={() => setModal({ type: "channel", name: "", topic: "", isPrivate: false, memberIds: [] })}><Svg d={PLUS} size={14} /></button></div>
        {publicChannels.map((c) => <button type="button" key={c.id} className={"chat-link" + (c.id === activeId ? " on" : "") + (unread(c) ? " unread" : "")} onClick={() => { setActiveId(c.id); setMobilePane("chat"); }}>
          <Svg d={c.isPrivate ? LOCK : HASH} size={14} /><span>{c.name}</span>{unread(c) && <i className="chat-dot" aria-label="unread" />}
        </button>)}
      </div>
      <div className="chat-section">
        <div className="chat-section-head"><span>Direct messages</span><button type="button" className="chat-add" title="New message" aria-label="New direct message" onClick={() => setModal({ type: "dm" })}><Svg d={PLUS} size={14} /></button></div>
        {dms.map((c) => { const partner = dmPartner(c); return <button type="button" key={c.id} className={"chat-link dm" + (c.id === activeId ? " on" : "") + (unread(c) ? " unread" : "")} onClick={() => { setActiveId(c.id); setMobilePane("chat"); }}>
          <span className="chat-avatar xs" style={{ "--av": colorFor(partner) }}>{initials(nameOf(partner))}</span><span>{nameOf(partner)}{partner === me.id ? " (you)" : ""}</span>{unread(c) && <i className="chat-dot" aria-label="unread" />}
        </button>; })}
        {team.filter((m) => m.id !== me.id && !dmPartners.has(m.id) && (!f || m.name.toLowerCase().includes(f))).slice(0, 8).map((m) => <button type="button" key={m.id} className="chat-link dm muted" onClick={() => openDm(m.id)}>
          <span className="chat-avatar xs" style={{ "--av": colorFor(m.id) }}>{initials(m.name)}</span><span>{m.name}</span>
        </button>)}
      </div>
    </aside>

    <div className="chat-main">
      {active ? <>
        <header className="chat-head">
          <button type="button" className="chat-back" aria-label="Back to conversations" onClick={() => setMobilePane("list")}>‹</button>
          <div className="chat-head-title">
            <h2>{active.kind === "dm" ? <span className="chat-avatar sm" style={{ "--av": colorFor(dmPartner(active)) }}>{initials(titleOf(active))}</span> : <Svg d={active.isPrivate ? LOCK : HASH} size={17} />}{titleOf(active)}</h2>
            <p>{active.kind === "dm" ? `Direct message · ${memberById.get(dmPartner(active))?.role || ""}` : (active.topic || "No topic yet")}</p>
          </div>
          <div className="chat-head-tools">
            <label className="chat-search"><Svg d="M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-3.5-3.5" size={14} /><input type="search" placeholder="Search messages" value={messageSearch} onChange={(e) => setMessageSearch(e.target.value)} aria-label="Search messages in this conversation" /></label>
            {active.kind === "channel" && <button type="button" className="chat-members" title="Channel details" onClick={() => setModal({ type: "details", topic: active.topic, memberIds: active.memberIds })}>
              <span className="chat-stack">{(active.isPrivate ? active.memberIds : teamIds).slice(0, 3).map((id) => <span key={id} className="chat-avatar xs" style={{ "--av": colorFor(id) }}>{initials(nameOf(id))}</span>)}</span>{memberCount}
            </button>}
          </div>
        </header>

        <div className="chat-messages" ref={listRef} onScroll={onScroll}>
          {hasOlder && !messageSearch && <button type="button" className="chat-older" onClick={loadOlder}>Load earlier messages</button>}
          {!loadingMessages && !messages.length && <div className="chat-welcome">
            <span className="chat-welcome-icon">{active.kind === "dm" ? <span className="chat-avatar lg" style={{ "--av": colorFor(dmPartner(active)) }}>{initials(titleOf(active))}</span> : <Svg d={active.isPrivate ? LOCK : HASH} size={26} />}</span>
            <h3>{active.kind === "dm" ? `This is the start of your conversation with ${titleOf(active)}` : `Welcome to #${active.name}`}</h3>
            <p>{active.kind === "dm" ? "Messages here are only visible to the two of you." : active.topic || "Start the conversation — share updates, ask questions and mention teammates with @."}</p>
          </div>}
          {loadingMessages && <div className="chat-loading"><span /><span /><span /></div>}
          {messageSearch && <p className="chat-search-note">{shown.length} message{shown.length === 1 ? "" : "s"} matching “{messageSearch}”</p>}
          {shown.map((m, i) => {
            const prev = shown[i - 1];
            const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            const showUnread = !messageSearch && m.id === firstUnreadId;
            const grouped = !newDay && !showUnread && prev && prev.authorId === m.authorId && m.createdAt - prev.createdAt < GROUP_GAP_MS && !prev.deleted;
            const mine = m.authorId === me.id;
            return <Fragment key={m.id}>
              {newDay && <div className="chat-day"><span>{dayLabel(m.createdAt)}</span></div>}
              {showUnread && <div className="chat-new"><span>New</span></div>}
              <article className={"chat-msg" + (grouped ? " grouped" : "") + (m.deleted ? " deleted" : "") + (editing?.id === m.id ? " editing" : "")}>
                {grouped ? <time className="chat-hover-time" dateTime={new Date(m.createdAt).toISOString()}>{timeOf(m.createdAt)}</time>
                  : <span className="chat-avatar" style={{ "--av": colorFor(m.authorId) }}>{initials(nameOf(m.authorId))}</span>}
                <div className="chat-msg-body">
                  {!grouped && <div className="chat-msg-meta"><b>{nameOf(m.authorId)}</b>{memberById.get(m.authorId)?.role && <span className="chat-role">{memberById.get(m.authorId).role}</span>}<time dateTime={new Date(m.createdAt).toISOString()} title={new Date(m.createdAt).toLocaleString("en-GB")}>{timeOf(m.createdAt)}</time></div>}
                  {m.deleted ? <p className="chat-text gone">This message was deleted.</p>
                    : editing?.id === m.id ? <div className="chat-edit">
                      <textarea autoFocus rows={Math.min(8, editing.body.split("\n").length + 1)} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); } if (e.key === "Escape") setEditing(null); }} />
                      <div><button type="button" className="btn alt" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="btn" onClick={saveEdit}>Save</button><small>Enter to save · Esc to cancel</small></div>
                    </div>
                    : <p className="chat-text">{renderBody(m.body, messageSearch.trim())}{m.editedAt && <small className="chat-edited"> (edited)</small>}</p>}
                  {!m.deleted && Object.keys(m.reactions || {}).length > 0 && <div className="chat-reactions">{Object.entries(m.reactions).map(([emoji, who]) => <button type="button" key={emoji} className={"chat-reaction" + (who.includes(me.id) ? " mine" : "")} title={who.map(nameOf).join(", ")} onClick={() => react(m, emoji)}>{emoji} <b>{who.length}</b></button>)}</div>}
                </div>
                {!m.deleted && editing?.id !== m.id && <div className="chat-msg-actions">
                  <button type="button" title="Add reaction" aria-label="Add reaction" onClick={() => setReactingTo(reactingTo === m.id ? null : m.id)}>☺</button>
                  {mine && <button type="button" title="Edit" aria-label="Edit message" onClick={() => setEditing({ id: m.id, body: m.body })}>✎</button>}
                  {(mine || me.role === "Admin") && <button type="button" title="Delete" aria-label="Delete message" className="danger" onClick={() => removeMessage(m)}>🗑</button>}
                  {reactingTo === m.id && <div className="chat-react-pick">{reactionSet.map((emoji) => <button type="button" key={emoji} onClick={() => react(m, emoji)}>{emoji}</button>)}</div>}
                </div>}
              </article>
            </Fragment>;
          })}
        </div>

        {error && <div className="chat-error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="Dismiss">×</button></div>}
        <div className="chat-composer">
          {mention && <ul className="chat-mention-pick" role="listbox">{mention.options.map((m, i) => <li key={m.id} role="option" aria-selected={i === mention.index}><button type="button" className={i === mention.index ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}><span className="chat-avatar xs" style={{ "--av": colorFor(m.id) }}>{initials(m.name)}</span>{m.name}<small>{m.role}</small></button></li>)}</ul>}
          {canPost ? <>
            <div className="chat-format">
              <button type="button" title="Bold" onClick={() => wrapSelection("**")}><b>B</b></button>
              <button type="button" title="Code" onClick={() => wrapSelection("`")}><code>{"</>"}</code></button>
              <button type="button" title="Mention someone" onClick={() => { setDraft((d) => d + (d && !d.endsWith(" ") ? " @" : "@")); composerRef.current?.focus(); }}>@</button>
            </div>
            <textarea ref={composerRef} rows={Math.min(6, Math.max(1, draft.split("\n").length))} maxLength={4000} placeholder={`Message ${active.kind === "dm" ? titleOf(active) : "#" + active.name}`} value={draft} onChange={onDraftChange} onKeyDown={onComposerKey} />
            <button type="button" className="chat-send" disabled={!draft.trim() || sending} onClick={send} aria-label="Send message"><Svg d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" size={16} /></button>
          </> : <p className="chat-readonly">Only admins and collaborators can post in #announcements.</p>}
        </div>
        <p className="chat-hint"><b>Enter</b> to send · <b>Shift + Enter</b> for a new line · type <b>@</b> to mention · ticket IDs like <b>ISS-01</b> become links</p>
      </> : <div className="chat-welcome center"><h3>Select a conversation</h3><p>Pick a channel or a teammate on the left.</p></div>}
    </div>

    {modal?.type === "channel" && <div className="ov" onClick={() => setModal(null)}><form className="modal chat-modal" onClick={(e) => e.stopPropagation()} onSubmit={submitChannel}>
      <h2>Create a channel</h2>
      <p className="note">Channels are where the team talks about a topic — a feature, a release, a client.</p>
      <label>Name<div className="chat-name-input"><Svg d={modal.isPrivate ? LOCK : HASH} size={15} /><input autoFocus required maxLength={40} placeholder="e.g. release-planning" value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })} /></div></label>
      <label>Topic <small>(optional)</small><input maxLength={200} placeholder="What is this channel about?" value={modal.topic} onChange={(e) => setModal({ ...modal, topic: e.target.value })} /></label>
      <label className="chat-toggle"><input type="checkbox" checked={modal.isPrivate} onChange={(e) => setModal({ ...modal, isPrivate: e.target.checked })} /><span><b>Make private</b><small>Only invited members can see and join this channel.</small></span></label>
      {modal.isPrivate && <fieldset className="chat-pick-members"><legend>Add members</legend>{team.filter((m) => m.id !== me.id).map((m) => <label key={m.id}><input type="checkbox" checked={modal.memberIds.includes(m.id)} onChange={(e) => setModal({ ...modal, memberIds: e.target.checked ? [...modal.memberIds, m.id] : modal.memberIds.filter((id) => id !== m.id) })} /><span className="chat-avatar xs" style={{ "--av": colorFor(m.id) }}>{initials(m.name)}</span>{m.name}<small>{m.role}</small></label>)}</fieldset>}
      {modal.error && <p className="err">{modal.error}</p>}
      <div className="acts end"><button type="button" className="btn alt" onClick={() => setModal(null)}>Cancel</button><button className="btn" disabled={!modal.name.trim()}>Create channel</button></div>
    </form></div>}

    {modal?.type === "dm" && <div className="ov" onClick={() => setModal(null)}><div className="modal chat-modal" onClick={(e) => e.stopPropagation()}>
      <h2>New direct message</h2>
      <div className="chat-dm-pick">{team.filter((m) => m.id !== me.id).map((m) => <button type="button" key={m.id} onClick={() => openDm(m.id)}><span className="chat-avatar sm" style={{ "--av": colorFor(m.id) }}>{initials(m.name)}</span><span><b>{m.name}</b><small>{m.role} · {m.email}</small></span></button>)}
        {team.length <= 1 && <p className="note">No other team members in this project yet.</p>}</div>
      <div className="acts end"><button type="button" className="btn alt" onClick={() => setModal(null)}>Close</button></div>
    </div></div>}

    {modal?.type === "details" && active && <div className="ov" onClick={() => setModal(null)}><form className="modal chat-modal" onClick={(e) => e.stopPropagation()} onSubmit={saveChannelDetails}>
      <h2><Svg d={active.isPrivate ? LOCK : HASH} size={18} /> {active.name}</h2>
      <p className="note">Created by {nameOf(active.createdBy)}{active.createdAt ? ` on ${new Date(active.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}` : ""}.</p>
      <label>Topic<input disabled={!canManageChannel} maxLength={200} value={modal.topic} onChange={(e) => setModal({ ...modal, topic: e.target.value })} placeholder="What is this channel about?" /></label>
      <fieldset className="chat-pick-members"><legend>{active.isPrivate ? "Members" : `Everyone in the project (${team.length})`}</legend>
        {team.filter((m) => !active.isPrivate || canManageChannel || modal.memberIds.includes(m.id)).map((m) => <label key={m.id}>
          {active.isPrivate && canManageChannel && <input type="checkbox" disabled={m.id === active.createdBy} checked={modal.memberIds.includes(m.id)} onChange={(e) => setModal({ ...modal, memberIds: e.target.checked ? [...modal.memberIds, m.id] : modal.memberIds.filter((id) => id !== m.id) })} />}
          <span className="chat-avatar xs" style={{ "--av": colorFor(m.id) }}>{initials(m.name)}</span>{m.name}<small>{m.role}</small></label>)}
      </fieldset>
      {modal.error && <p className="err">{modal.error}</p>}
      <div className="acts end">
        {canManageChannel && active.name !== "general" && <button type="button" className="ic dl" onClick={removeChannel}>Delete channel</button>}
        <button type="button" className="btn alt" onClick={() => setModal(null)}>Close</button>
        {canManageChannel && <button className="btn">Save</button>}
      </div>
    </form></div>}
  </section>;
}
