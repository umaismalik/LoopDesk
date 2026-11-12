"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Team communication for a project: public and private channels plus direct messages, shown as
// chat bubbles (your messages on the right, everyone else's on the left). The open conversation polls
// for new, edited and deleted messages every few seconds.
const POLL_MS = 2000;
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
const REPLY = "M9 17l-5-5 5-5M4 12h11a5 5 0 015 5v2";
const STAR = "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z";
const COPY = "M9 9h11v11H9zM5 15H4V4h11v1";
const BELL = "M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0";
const SMILE = "M12 22a10 10 0 100-20 10 10 0 000 20zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01";
const EMOJIS = "😀 😂 🙂 😊 😍 🤔 😅 😎 🙌 👏 👍 👎 🙏 💪 🔥 🎉 ✅ ❌ ⚠️ 🚀 💡 📌 📎 📅 ⏰ 🐞 🛠️ 📈 💯 ❤️ 👀 🤝 ☕ 🥳 😴 🤯".split(" ");
// A reply is stored as a marker in front of the message text, so no database change is needed.
const REPLY_RE = /^\[\[reply:([a-z0-9]+)\]\]\n?/;
const parseBody = (body) => {
  const match = String(body || "").match(REPLY_RE);
  return match ? { replyId: match[1], text: body.slice(match[0].length) } : { replyId: "", text: String(body || "") };
};
const Svg = ({ d, size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

export default function TeamChat({ projectId, keyValue, me, members, projectName, organizationName, pulseChannels, lastRead, onRead, onOpenTicket }) {
  const [channels, setChannels] = useState([]);
  const [teamIds, setTeamIds] = useState([]);
  const [reactionSet, setReactionSet] = useState(["👍", "✅", "🎉", "👀"]);
  const [activeId, setActiveId] = useState(() => { try { return localStorage.getItem(`rw-chat-active:${projectId}`) || ""; } catch { return ""; } });
  const [messages, setMessages] = useState([]);
  const [hasOlder, setHasOlder] = useState(false);
  const hasOlderRef = useRef(false);
  hasOlderRef.current = hasOlder;
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
  const [replyTo, setReplyTo] = useState(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState("");
  const [flashId, setFlashId] = useState("");
  const [newBelow, setNewBelow] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [savedOpen, setSavedOpen] = useState(false);
  const savedKey = `rw-chat-saved:${projectId}:${me.id}`;
  const [saved, setSaved] = useState(() => { try { return JSON.parse(localStorage.getItem(savedKey) || "[]"); } catch { return []; } });
  const [notify, setNotify] = useState(() => typeof Notification !== "undefined" && Notification.permission === "granted" && (() => { try { return localStorage.getItem("rw-chat-notify") !== "off"; } catch { return true; } })());
  const messagesRef = useRef([]);
  // Messages already loaded per conversation, so switching back to one is instant.
  const channelCacheRef = useRef(new Map());
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
    incoming.forEach((m) => { if (!m.pending) updatedRef.current = Math.max(updatedRef.current, m.updatedAt || m.createdAt); });
    return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
  });

  // Open a conversation: load its latest messages and remember where the unread ones start.
  useEffect(() => {
    if (!activeId) return;
    try { localStorage.setItem(`rw-chat-active:${projectId}`, activeId); } catch {}
    let cancelled = false;
    const cachedChannel = channelCacheRef.current.get(activeId);
    setEditing(null); setReactingTo(null); setMessageSearch(""); setReplyTo(null); setEmojiOpen(false); setNewBelow(0); setAtBottom(true); stickRef.current = true;
    setUnreadMarker(lastRead?.[activeId] || 0);
    if (cachedChannel) {
      // Show what we already have immediately, then fetch only what changed since.
      setMessages(cachedChannel.messages); setHasOlder(cachedChannel.hasOlder); updatedRef.current = cachedChannel.updated; setLoadingMessages(false);
      call(`channel=${encodeURIComponent(activeId)}&after=${cachedChannel.updated}&limit=200`).then((result) => {
        if (!cancelled && result.ok && result.messages?.length) merge(result.messages);
      });
    } else {
      setMessages([]); updatedRef.current = 0;
      setLoadingMessages(true);
      call(`channel=${encodeURIComponent(activeId)}&limit=80`).then((result) => {
        if (cancelled) return;
        setLoadingMessages(false);
        if (!result.ok) { setError(result.error || "Could not load messages"); return; }
        merge(result.messages || []);
        setHasOlder(!!result.hasMore);
      });
    }
    const channelId = activeId;
    return () => {
      cancelled = true;
      const loaded = messagesRef.current.filter((m) => !m.pending && m.channelId === channelId);
      if (loaded.length) channelCacheRef.current.set(channelId, { messages: loaded, updated: updatedRef.current, hasOlder: hasOlderRef.current });
    };
  }, [activeId, call]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the open conversation for new, edited and deleted messages.
  useEffect(() => {
    if (!activeId) return;
    let busy = false;
    const poll = async () => {
      if (document.hidden || !updatedRef.current || busy) return;
      busy = true;
      const result = await call(`channel=${encodeURIComponent(activeId)}&after=${updatedRef.current}&limit=200`);
      if (result.ok && result.messages?.length) {
        const known = new Set(messagesRef.current.map((m) => m.id));
        const fresh = result.messages.filter((m) => !known.has(m.id) && m.authorId !== me.id).length;
        if (fresh && !stickRef.current) setNewBelow((n) => n + fresh);
        merge(result.messages);
      }
      if (!result.ok && result.status === 404) loadChannels();
      busy = false;
    };
    const timer = setInterval(poll, POLL_MS);
    // Catch up straight away when the person comes back to the tab.
    const onVisible = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [activeId, call, loadChannels]);

  // Everything visible in the open conversation counts as read.
  const newest = messages.reduce((latest, m) => m.pending ? latest : Math.max(latest, m.createdAt), 0);
  useEffect(() => {
    if (activeId && newest && !document.hidden) onRead(activeId, Math.max(newest, active?.lastMessageAt || 0));
  }, [activeId, newest, active?.lastMessageAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stay pinned to the bottom unless the reader scrolled up to read history.
  useEffect(() => {
    messagesRef.current = messages;
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setNewBelow(0);
  };
  const scrollToBottom = () => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickRef.current = true; setNewBelow(0);
  };
  const jumpTo = (id) => {
    const el = document.getElementById("msg-" + id);
    if (!el) { setError("That message is further back — use “Load earlier messages”."); return; }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(id); setTimeout(() => setFlashId(""), 1600);
  };
  const toggleSaved = (m) => setSaved((list) => {
    const next = list.some((x) => x.id === m.id) ? list.filter((x) => x.id !== m.id)
      : [{ id: m.id, channelId: m.channelId, authorId: m.authorId, text: parseBody(m.body).text.slice(0, 300), createdAt: m.createdAt }, ...list].slice(0, 100);
    try { localStorage.setItem(savedKey, JSON.stringify(next)); } catch {}
    return next;
  });
  const copyText = async (m) => {
    try { await navigator.clipboard.writeText(parseBody(m.body).text); setActionsFor(""); } catch { setError("Could not copy the message"); }
  };
  const toggleNotify = async () => {
    if (typeof Notification === "undefined") { setError("This browser does not support desktop notifications."); return; }
    if (notify) { setNotify(false); try { localStorage.setItem("rw-chat-notify", "off"); } catch {} return; }
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") { setError("Notifications are blocked. Allow them for this site in the browser's address bar."); return; }
    setNotify(true); try { localStorage.setItem("rw-chat-notify", "on"); } catch {}
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

  // The message appears in the chat immediately (with a clock icon) and is confirmed when the server
  // answers; if sending fails it is marked so it can be retried. Several messages can be sent quickly.
  const deliver = async (temp) => {
    const result = await call("", { action: "send", channelId: temp.channelId, body: temp.body });
    setMessages((list) => list.filter((m) => m.id !== temp.id || !result.ok).map((m) => m.id === temp.id ? { ...m, failed: true } : m));
    if (!result.ok) { setError(result.error || "Message not sent. Tap “Retry” on the message."); return; }
    merge([result.message]);
    setChannels((list) => list.map((c) => c.id === temp.channelId ? { ...c, lastMessageAt: result.message.createdAt, lastAuthorId: me.id } : c));
  };
  const send = () => {
    const text = draft.trim();
    if (!text || !active) return;
    const body = (replyTo ? `[[reply:${replyTo.id}]]\n` : "") + text;
    const temp = { id: "tmp-" + Date.now() + Math.random().toString(36).slice(2, 6), channelId: active.id, authorId: me.id, body, reactions: {}, createdAt: Math.max(Date.now(), (messagesRef.current.at(-1)?.createdAt || 0) + 1), editedAt: null, deleted: false, pending: true };
    setError(""); setDraft(""); setMention(null); setReplyTo(null); setEmojiOpen(false); stickRef.current = true; setNewBelow(0);
    setMessages((list) => [...list, temp]);
    composerRef.current?.focus();
    deliver(temp);
  };
  const retry = (m) => {
    setMessages((list) => list.map((x) => x.id === m.id ? { ...x, failed: false } : x));
    deliver(m);
  };
  const saveEdit = async () => {
    if (!editing) return;
    const result = await call("", { action: "edit", messageId: editing.id, body: (editing.replyId ? `[[reply:${editing.replyId}]]\n` : "") + editing.body });
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
    if (message.pending) return;
    // Show the reaction straight away; the server's answer then confirms it.
    setMessages((list) => list.map((m) => {
      if (m.id !== message.id) return m;
      const reactions = { ...(m.reactions || {}) }, who = new Set(reactions[emoji] || []);
      if (who.has(me.id)) who.delete(me.id); else who.add(me.id);
      if (who.size) reactions[emoji] = [...who]; else delete reactions[emoji];
      return { ...m, reactions };
    }));
    const result = await call("", { action: "react", messageId: message.id, emoji });
    if (result.ok) merge([result.message]);
    else { setError(result.error || "Could not react"); merge([message]); }
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
    if (event.key === "Escape" && replyTo) { setReplyTo(null); return; }
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
    const re = new RegExp(`(https?:\\/\\/[^\\s<]+)|(\\*\\*[^*\\n]+\\*\\*)|(\`[^\`\\n]+\`)|(${mentionRe})|(\\b(?:ISS|FTR)[- ]?\\d+\\b)`, "gi");
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
        else if (m[5]) {
          const ticketId = m[5].toUpperCase().replace(/^(ISS|FTR)[- ]?0*(\d+)$/, (_, kind, n) => `${kind}-${n.padStart(2, "0")}`);
          out.push(<a key={k} href={"#" + ticketId} className="chat-ticket" title={`Open ${ticketId}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenTicket(ticketId); }}>{ticketId}</a>);
        }
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
  const shown = messageSearch.trim() ? messages.filter((m) => !m.deleted && parseBody(m.body).text.toLowerCase().includes(messageSearch.trim().toLowerCase())) : messages;
  const byId = new Map(messages.map((m) => [m.id, m]));
  const channelSaved = saved.filter((x) => x.channelId === activeId);
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
            <button type="button" className={"chat-tool" + (notify ? " on" : "")} title={notify ? "Desktop notifications on" : "Turn on desktop notifications"} aria-pressed={notify} onClick={toggleNotify}><Svg d={BELL} size={15} /></button>
            <button type="button" className={"chat-tool" + (savedOpen ? " on" : "")} title="Saved messages" aria-pressed={savedOpen} onClick={() => setSavedOpen((o) => !o)}><Svg d={STAR} size={15} />{channelSaved.length > 0 && <em>{channelSaved.length}</em>}</button>
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
            const prev = shown[i - 1], next = shown[i + 1];
            const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            const showUnread = !messageSearch && m.id === firstUnreadId;
            const sameAsPrev = !newDay && !showUnread && prev && prev.authorId === m.authorId && m.createdAt - prev.createdAt < GROUP_GAP_MS;
            const nextBreaks = !next || next.authorId !== m.authorId || next.createdAt - m.createdAt >= GROUP_GAP_MS || new Date(next.createdAt).toDateString() !== new Date(m.createdAt).toDateString() || (!messageSearch && next.id === firstUnreadId);
            const mine = m.authorId === me.id;
            const { replyId, text } = parseBody(m.body);
            const quoted = replyId ? byId.get(replyId) : null;
            const isSaved = saved.some((x) => x.id === m.id);
            const showName = !mine && !sameAsPrev && active.kind !== "dm";
            return <Fragment key={m.id}>
              {newDay && <div className="chat-day"><span>{dayLabel(m.createdAt)}</span></div>}
              {showUnread && <div className="chat-new"><span>New messages</span></div>}
              <article id={"msg-" + m.id} className={"bubble-row" + (mine ? " mine" : " theirs") + (sameAsPrev ? " cont" : "") + (nextBreaks ? " tail" : "") + (flashId === m.id ? " flash" : "") + (actionsFor === m.id ? " show-actions" : "")}>
                {!mine && <span className="bubble-avatar">{nextBreaks ? <span className="chat-avatar sm" style={{ "--av": colorFor(m.authorId) }} title={nameOf(m.authorId)}>{initials(nameOf(m.authorId))}</span> : null}</span>}
                <div className="bubble-stack">
                  <div className={"bubble" + (m.deleted ? " gone" : "") + (m.pending ? " pending" : "") + (m.failed ? " failed" : "") + (editing?.id === m.id ? " editing" : "")} onClick={(e) => { if (!e.target.closest("a,button,textarea") && !window.getSelection()?.toString()) setActionsFor((id) => id === m.id ? "" : m.id); }}>
                    {showName && <b className="bubble-name" style={{ color: colorFor(m.authorId) }}>{nameOf(m.authorId)}{memberById.get(m.authorId)?.role && <span>{memberById.get(m.authorId).role}</span>}</b>}
                    {!m.deleted && replyId && <button type="button" className="bubble-quote" style={{ "--q": colorFor(quoted?.authorId || "") }} onClick={() => jumpTo(replyId)}>
                      <b>{quoted ? (quoted.authorId === me.id ? "You" : nameOf(quoted.authorId)) : "Earlier message"}</b>
                      <span>{quoted ? (quoted.deleted ? "This message was deleted." : parseBody(quoted.body).text.slice(0, 140)) : "Tap to find it"}</span>
                    </button>}
                    {m.deleted ? <p className="bubble-text"><i>🚫 This message was deleted</i></p>
                      : editing?.id === m.id ? <div className="chat-edit">
                        <textarea autoFocus rows={Math.min(8, editing.body.split("\n").length + 1)} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); } if (e.key === "Escape") setEditing(null); }} />
                        <div><button type="button" className="btn alt" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="btn" onClick={saveEdit}>Save</button></div>
                      </div>
                      : <p className="bubble-text">{renderBody(text, messageSearch.trim())}</p>}
                    <span className="bubble-meta">{isSaved && <span title="Saved">★</span>}{m.editedAt && !m.deleted && <span>edited</span>}<time dateTime={new Date(m.createdAt).toISOString()} title={new Date(m.createdAt).toLocaleString("en-GB")}>{timeOf(m.createdAt)}</time>{mine && !m.deleted && (m.failed ? <button type="button" className="bubble-retry" onClick={() => retry(m)}>⚠ Retry</button> : m.pending ? <span className="bubble-clock" title="Sending…">🕓</span> : <span className="bubble-tick" title="Sent">✓✓</span>)}</span>
                  </div>
                  {!m.deleted && Object.keys(m.reactions || {}).length > 0 && <div className="chat-reactions">{Object.entries(m.reactions).map(([emoji, who]) => <button type="button" key={emoji} className={"chat-reaction" + (who.includes(me.id) ? " mine" : "")} title={who.map((id) => id === me.id ? "You" : nameOf(id)).join(", ")} onClick={() => react(m, emoji)}>{emoji} <b>{who.length}</b></button>)}</div>}
                </div>
                {!m.deleted && !m.pending && editing?.id !== m.id && <div className="bubble-actions">
                  <button type="button" title="Reply" aria-label="Reply" onClick={() => { setReplyTo(m); setActionsFor(""); composerRef.current?.focus(); }}><Svg d={REPLY} size={15} /></button>
                  <button type="button" title="React" aria-label="Add reaction" onClick={() => setReactingTo(reactingTo === m.id ? null : m.id)}><Svg d={SMILE} size={15} /></button>
                  <button type="button" title={isSaved ? "Remove from saved" : "Save message"} aria-label="Save message" className={isSaved ? "on" : ""} onClick={() => toggleSaved(m)}><Svg d={STAR} size={15} /></button>
                  <button type="button" title="Copy text" aria-label="Copy text" onClick={() => copyText(m)}><Svg d={COPY} size={15} /></button>
                  {mine && <button type="button" title="Edit" aria-label="Edit message" onClick={() => { setEditing({ id: m.id, body: text, replyId }); setActionsFor(""); }}><Svg d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" size={15} /></button>}
                  {(mine || me.role === "Admin") && <button type="button" title="Delete" aria-label="Delete message" className="danger" onClick={() => removeMessage(m)}><Svg d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" size={15} /></button>}
                  {reactingTo === m.id && <div className="chat-react-pick">{reactionSet.map((emoji) => <button type="button" key={emoji} onClick={() => { react(m, emoji); setActionsFor(""); }}>{emoji}</button>)}</div>}
                </div>}
              </article>
            </Fragment>;
          })}
        </div>

        {(!atBottom || newBelow > 0) && messages.length > 0 && <button type="button" className={"chat-jump" + (newBelow ? " has-new" : "")} onClick={scrollToBottom} aria-label="Jump to latest messages">{newBelow > 0 && <em>{newBelow > 99 ? "99+" : newBelow} new</em>}<Svg d="M6 9l6 6 6-6" size={18} /></button>}
        {savedOpen && <aside className="chat-saved" aria-label="Saved messages">
          <header><b><Svg d={STAR} size={14} /> Saved in this conversation</b><button type="button" onClick={() => setSavedOpen(false)} aria-label="Close">×</button></header>
          {!channelSaved.length && <p className="chat-saved-empty">Save important messages with the ☆ button — they stay here for you only.</p>}
          {channelSaved.map((x) => <div key={x.id} className="chat-saved-item"><button type="button" onClick={() => jumpTo(x.id)}><b>{x.authorId === me.id ? "You" : nameOf(x.authorId)}</b><small>{new Date(x.createdAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</small><span>{x.text}</span></button><button type="button" className="chat-saved-remove" aria-label="Remove" onClick={() => toggleSaved(x)}>×</button></div>)}
        </aside>}
        {error && <div className="chat-error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="Dismiss">×</button></div>}
        <div className="chat-composer">
          {mention && <ul className="chat-mention-pick" role="listbox">{mention.options.map((m, i) => <li key={m.id} role="option" aria-selected={i === mention.index}><button type="button" className={i === mention.index ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}><span className="chat-avatar xs" style={{ "--av": colorFor(m.id) }}>{initials(m.name)}</span>{m.name}<small>{m.role}</small></button></li>)}</ul>}
          {replyTo && <div className="chat-replying" style={{ "--q": colorFor(replyTo.authorId) }}><div><b>Replying to {replyTo.authorId === me.id ? "yourself" : nameOf(replyTo.authorId)}</b><span>{parseBody(replyTo.body).text.slice(0, 160)}</span></div><button type="button" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>×</button></div>}
          {emojiOpen && <div className="chat-emoji-pick" role="dialog" aria-label="Emoji">{EMOJIS.map((e) => <button type="button" key={e} onClick={() => { setDraft((d) => d + e); composerRef.current?.focus(); }}>{e}</button>)}</div>}
          {canPost ? <>
            <div className="chat-format">
              <button type="button" title="Emoji" aria-pressed={emojiOpen} className={emojiOpen ? "on" : ""} onClick={() => setEmojiOpen((o) => !o)}><Svg d={SMILE} size={15} /></button>
              <button type="button" title="Bold" onClick={() => wrapSelection("**")}><b>B</b></button>
              <button type="button" title="Code" onClick={() => wrapSelection("`")}><code>{"</>"}</code></button>
              <button type="button" title="Mention someone" onClick={() => { setDraft((d) => d + (d && !d.endsWith(" ") ? " @" : "@")); composerRef.current?.focus(); }}>@</button>
            </div>
            <textarea ref={composerRef} rows={Math.min(6, Math.max(1, draft.split("\n").length))} maxLength={4000} placeholder={`Message ${active.kind === "dm" ? titleOf(active) : "#" + active.name}`} value={draft} onChange={onDraftChange} onKeyDown={onComposerKey} />
            <button type="button" className="chat-send" disabled={!draft.trim()} onClick={send} aria-label="Send message"><Svg d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" size={16} /></button>
          </> : <p className="chat-readonly">Only admins and collaborators can post in #announcements.</p>}
        </div>
        <p className="chat-hint"><b>Enter</b> to send · <b>Shift + Enter</b> new line · <b>@</b> to mention · hover a message to reply, react or save · <b>ISS-01</b> becomes a link</p>
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
