// Lightweight storage for live updates and team chat.
//
// These requests run every few seconds from every open browser, so they never load the whole
// workspace: a session is checked with a few targeted row lookups and the data lives in its own
// small tables (chat_channels, chat_messages, project_pulse — see supabase.sql). Local development
// uses data/db.json for sessions and data/chat.json for chat.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { remote } from "./store";

const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
const H = (x = {}) => ({ apikey: K, ...(String(K).startsWith("sb_") ? {} : { Authorization: "Bearer " + K }), ...x });
const DIR = path.join(process.cwd(), "data"), DB = path.join(DIR, "db.json"), CHAT = path.join(DIR, "chat.json");
const SESSION_MS = 30 * 864e5;
const enc = encodeURIComponent;

export class ChatSetupError extends Error {}

async function rest(pathAndQuery, init = {}) {
  const response = await fetch(`${U}/rest/v1/${pathAndQuery}`, { cache: "no-store", ...init, headers: H(init.headers || {}) });
  if (!response.ok) {
    const text = await response.text();
    // PostgREST reports a table that does not exist yet (the updated supabase.sql was not run).
    if (response.status === 404 || /PGRST205|42P01|does not exist|Could not find the table/i.test(text)) {
      throw new ChatSetupError("Team chat tables are missing. Run the updated supabase.sql in the Supabase SQL Editor.");
    }
    throw new Error(`Live data request failed: ${response.status} ${text}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const readLocalDb = () => {
  try { return JSON.parse(fs.readFileSync(DB, "utf8")); } catch { return null; }
};
const tokenLive = (token) => {
  const issued = Number(String(token).split(".")[1]);
  return !issued || Date.now() - issued < SESSION_MS;
};

// Short-lived in-memory caches. Chat and live-update requests arrive every few seconds from every
// open browser, so repeating the same session and team lookups each time made the chat feel slow.
// A disabled member or removed session stops working within AUTH_TTL_MS.
const AUTH_TTL_MS = 60 * 1000, TEAM_TTL_MS = 60 * 1000, CHANNEL_TTL_MS = 30 * 1000;
const cacheStore = globalThis.__loopdeskLiveCache || (globalThis.__loopdeskLiveCache = { auth: new Map(), team: new Map(), channel: new Map() });
const cached = (map, key) => {
  const hit = map.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (hit) map.delete(key);
  return undefined;
};
const remember = (map, key, value, ttl) => {
  if (map.size > 2000) map.clear();
  map.set(key, { value, expires: Date.now() + ttl });
  return value;
};

// Returns { id, name, email, role } for an active member of the project, or null.
export async function lightAuth(token, projectId) {
  if (!token || !projectId) return null;
  const cacheKey = token + "|" + projectId;
  const hit = cached(cacheStore.auth, cacheKey);
  if (hit !== undefined) return hit;
  if (!remote) {
    const d = readLocalDb();
    if (!d) return null;
    const member = (d.members || []).find((m) => m.status !== "disabled" && (m.key === token || ((m.sessions || []).includes(token) && tokenLive(token))));
    const project = (d.projects || []).find((p) => p.id === projectId);
    const entry = project?.members?.find((x) => x.memberId === member?.id && x.status !== "disabled");
    return member && entry ? { id: member.id, name: member.name, email: member.email, role: entry.role, organizationId: project.organizationId || "" } : null;
  }
  if (!tokenLive(token)) return null;
  let result = null;
  try {
    // One round trip: the session, its member and that member's role in this project.
    const [row] = (await rest(`member_sessions?token=eq.${enc(token)}&select=member_id,expires_at,members(id,name,email,status,project_members(project_id,role,status,projects(organization_id)))&members.project_members.project_id=eq.${enc(projectId)}&limit=1`)) || [];
    if (row && !(row.expires_at != null && Number(row.expires_at) <= Date.now())) {
      const member = row.members, entry = member?.project_members?.[0];
      if (member && member.status !== "disabled" && entry && entry.status !== "disabled") result = { id: member.id, name: member.name, email: member.email, role: entry.role, organizationId: entry.projects?.organization_id || "" };
    }
  } catch (error) {
    if (error instanceof ChatSetupError) throw error;
    // Fallback if the embedded lookup is not available: three plain lookups.
    const [session] = (await rest(`member_sessions?token=eq.${enc(token)}&select=member_id,expires_at&limit=1`)) || [];
    if (session && !(session.expires_at != null && Number(session.expires_at) <= Date.now())) {
      const [members, memberships] = await Promise.all([
        rest(`members?id=eq.${enc(session.member_id)}&select=id,name,email,status&limit=1`),
        rest(`project_members?project_id=eq.${enc(projectId)}&member_id=eq.${enc(session.member_id)}&select=role,status&limit=1`),
      ]);
      const member = members?.[0], entry = memberships?.[0];
      if (member && member.status !== "disabled" && entry && entry.status !== "disabled") result = { id: member.id, name: member.name, email: member.email, role: entry.role };
    }
  }
  // Only successful checks are cached, so a fresh login works immediately.
  return result ? remember(cacheStore.auth, cacheKey, result, AUTH_TTL_MS) : null;
}

// Active non-client members of a project (chat participants).
export async function projectTeam(projectId) {
  const hit = cached(cacheStore.team, projectId);
  if (hit) return hit;
  if (!remote) {
    const d = readLocalDb();
    const project = (d?.projects || []).find((p) => p.id === projectId);
    return (project?.members || []).filter((x) => x.status !== "disabled" && x.role !== "Client")
      .map((x) => d.members.find((m) => m.id === x.memberId && m.status !== "disabled")).filter(Boolean).map((m) => m.id);
  }
  const rows = await rest(`project_members?project_id=eq.${enc(projectId)}&status=neq.disabled&role=neq.Client&select=member_id`);
  return remember(cacheStore.team, projectId, (rows || []).map((row) => row.member_id), TEAM_TTL_MS);
}

// ---------------------------------------------------------------------------------------------
// Project version: bumped after every successful write so open browsers know to refresh.
// ---------------------------------------------------------------------------------------------
const localPulse = globalThis.__loopdeskPulse || (globalThis.__loopdeskPulse = new Map());

export async function bumpProjectVersion(projectId) {
  if (!projectId) return;
  const version = Date.now();
  if (!remote) { localPulse.set(projectId, version); return; }
  try {
    await rest("project_pulse?on_conflict=project_id", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ project_id: projectId, version }),
    });
  } catch (error) {
    if (!(error instanceof ChatSetupError)) console.warn("Could not record project change:", error?.message || error);
  }
}

export async function projectVersion(projectId) {
  if (!remote) {
    const d = readLocalDb();
    const project = (d?.projects || []).find((p) => p.id === projectId);
    return `${localPulse.get(projectId) || 0}:${project?.audit?.[0]?.at || ""}:${project?.tickets?.length || 0}`;
  }
  // The audit position (a timestamp) also covers changes made before project_pulse existed.
  const [pulse, audit] = await Promise.all([
    rest(`project_pulse?project_id=eq.${enc(projectId)}&select=version&limit=1`).catch((error) => {
      if (error instanceof ChatSetupError) return [];
      throw error;
    }),
    rest(`project_audit?project_id=eq.${enc(projectId)}&select=position&order=position.desc&limit=1`),
  ]);
  return `${pulse?.[0]?.version || 0}:${audit?.[0]?.position || 0}`;
}

// ---------------------------------------------------------------------------------------------
// Team chat
// ---------------------------------------------------------------------------------------------
const uid = () => crypto.randomBytes(12).toString("hex");
const readChat = () => {
  try { return JSON.parse(fs.readFileSync(CHAT, "utf8")); } catch { return { channels: [], messages: [] }; }
};
const writeChat = (data) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CHAT + ".tmp", JSON.stringify(data, null, 1));
  fs.renameSync(CHAT + ".tmp", CHAT);
};
const fromRow = (row) => row && ({
  id: row.id, projectId: row.project_id, name: row.name, topic: row.topic || "", kind: row.kind,
  isPrivate: !!row.is_private, memberIds: row.member_ids || [], createdBy: row.created_by || "",
  createdAt: Number(row.created_at) || 0, lastMessageAt: Number(row.last_message_at) || 0, lastAuthorId: row.last_author_id || "",
});
const toRow = (c) => ({
  id: c.id, project_id: c.projectId, name: c.name, topic: c.topic, kind: c.kind, is_private: c.isPrivate,
  member_ids: c.memberIds, created_by: c.createdBy, created_at: c.createdAt, last_message_at: c.lastMessageAt, last_author_id: c.lastAuthorId,
});
const msgFromRow = (row) => row && ({
  id: row.id, channelId: row.channel_id, authorId: row.author_id, body: row.body,
  reactions: row.reactions || {}, createdAt: Number(row.created_at) || 0, editedAt: row.edited_at ? Number(row.edited_at) : null,
  updatedAt: Number(row.updated_at) || Number(row.created_at) || 0, deleted: !!row.deleted,
});

export const canSeeChannel = (channel, memberId) => channel.kind === "channel" && !channel.isPrivate ? true : channel.memberIds.includes(memberId);

export async function listChannels(projectId) {
  if (!remote) return readChat().channels.filter((c) => c.projectId === projectId);
  return ((await rest(`chat_channels?project_id=eq.${enc(projectId)}&select=*&order=created_at`)) || []).map(fromRow);
}

// Channel membership and settings change rarely; a short cache keeps sending and polling quick.
export async function getChannel(projectId, channelId) {
  if (!remote) return readChat().channels.find((c) => c.projectId === projectId && c.id === channelId) || null;
  const hit = cached(cacheStore.channel, channelId);
  if (hit) return hit.projectId === projectId ? hit : null;
  const [row] = (await rest(`chat_channels?project_id=eq.${enc(projectId)}&id=eq.${enc(channelId)}&select=*&limit=1`)) || [];
  const channel = fromRow(row) || null;
  return channel ? remember(cacheStore.channel, channelId, channel, CHANNEL_TTL_MS) : null;
}

export async function createChannel(channel) {
  const created = { id: uid(), topic: "", isPrivate: false, memberIds: [], createdAt: Date.now(), lastMessageAt: 0, lastAuthorId: "", ...channel };
  if (!remote) {
    const data = readChat();
    data.channels.push(created);
    writeChat(data);
    return created;
  }
  const [row] = await rest("chat_channels", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(toRow(created)),
  });
  return fromRow(row);
}

export async function updateChannel(channelId, changes) {
  if (!remote) {
    const data = readChat();
    const channel = data.channels.find((c) => c.id === channelId);
    if (channel) Object.assign(channel, changes);
    writeChat(data);
    return channel;
  }
  const row = {};
  if ("topic" in changes) row.topic = changes.topic;
  if ("name" in changes) row.name = changes.name;
  if ("memberIds" in changes) row.member_ids = changes.memberIds;
  if ("lastMessageAt" in changes) row.last_message_at = changes.lastMessageAt;
  if ("lastAuthorId" in changes) row.last_author_id = changes.lastAuthorId;
  cacheStore.channel.delete(channelId);
  const [updated] = await rest(`chat_channels?id=eq.${enc(channelId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  return fromRow(updated);
}

export async function deleteChannel(channelId) {
  if (!remote) {
    const data = readChat();
    data.channels = data.channels.filter((c) => c.id !== channelId);
    data.messages = data.messages.filter((m) => m.channelId !== channelId);
    writeChat(data);
    return;
  }
  cacheStore.channel.delete(channelId);
  await rest(`chat_channels?id=eq.${enc(channelId)}`, { method: "DELETE" });
}

// Newest `limit` messages, or only those after `after` (polling) / before `before` (older history).
export async function listMessages(channelId, { after = 0, before = 0, limit = 80 } = {}) {
  if (!remote) {
    let rows = readChat().messages.filter((m) => m.channelId === channelId);
    if (after) rows = rows.filter((m) => (m.updatedAt || m.createdAt) > after);
    if (before) rows = rows.filter((m) => m.createdAt < before);
    return rows.sort((a, b) => a.createdAt - b.createdAt).slice(-limit);
  }
  let filter = `channel_id=eq.${enc(channelId)}`;
  if (after) filter += `&updated_at=gt.${after}`;
  if (before) filter += `&created_at=lt.${before}`;
  const rows = await rest(`chat_messages?${filter}&select=*&order=created_at.desc&limit=${limit}`);
  return (rows || []).map(msgFromRow).reverse();
}

export async function getMessage(messageId) {
  if (!remote) return readChat().messages.find((m) => m.id === messageId) || null;
  const [row] = (await rest(`chat_messages?id=eq.${enc(messageId)}&select=*&limit=1`)) || [];
  return msgFromRow(row) || null;
}

export async function addMessage(projectId, channelId, authorId, body) {
  const now = Date.now();
  const message = { id: uid(), channelId, authorId, body, reactions: {}, createdAt: now, editedAt: null, updatedAt: now, deleted: false };
  if (!remote) {
    const data = readChat();
    data.messages.push(message);
    const channel = data.channels.find((c) => c.id === channelId);
    if (channel) { channel.lastMessageAt = message.createdAt; channel.lastAuthorId = authorId; }
    writeChat(data);
    return message;
  }
  // Store the message and bump the channel's "last message" time at the same time.
  await Promise.all([
    rest("chat_messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: message.id, channel_id: channelId, project_id: projectId, author_id: authorId, body, reactions: {}, created_at: now, updated_at: now, deleted: false }),
    }),
    rest(`chat_channels?id=eq.${enc(channelId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ last_message_at: now, last_author_id: authorId }),
    }),
  ]);
  return message;
}

// Every change also moves updatedAt forward, so polling browsers pick up edits, reactions and deletions.
export async function updateMessage(messageId, changes) {
  changes = { ...changes, updatedAt: Date.now() };
  if (!remote) {
    const data = readChat();
    const message = data.messages.find((m) => m.id === messageId);
    if (message) Object.assign(message, changes);
    writeChat(data);
    return message;
  }
  const row = {};
  if ("body" in changes) row.body = changes.body;
  if ("reactions" in changes) row.reactions = changes.reactions;
  if ("editedAt" in changes) row.edited_at = changes.editedAt;
  if ("deleted" in changes) row.deleted = changes.deleted;
  row.updated_at = changes.updatedAt;
  const [updated] = await rest(`chat_messages?id=eq.${enc(messageId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  return msgFromRow(updated);
}

// Soft delete: the row stays (as "message deleted") so other open browsers see the removal.
export async function deleteMessage(messageId) {
  return updateMessage(messageId, { body: "", reactions: {}, deleted: true });
}

// ---------------------------------------------------------------------------------------------
// Read receipts: up to which time each member has read each conversation.
// ---------------------------------------------------------------------------------------------
export async function markRead(channelId, memberId, at) {
  if (!remote) {
    const data = readChat();
    data.reads = (data.reads || []).filter((r) => !(r.channelId === channelId && r.memberId === memberId));
    const previous = (readChat().reads || []).find((r) => r.channelId === channelId && r.memberId === memberId);
    data.reads.push({ channelId, memberId, lastReadAt: Math.max(at, previous?.lastReadAt || 0) });
    writeChat(data);
    return;
  }
  try {
    await rest("chat_reads?on_conflict=channel_id,member_id", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ channel_id: channelId, member_id: memberId, last_read_at: at }),
    });
  } catch (error) {
    if (!(error instanceof ChatSetupError)) throw error;
  }
}

export async function listReads(channelId) {
  if (!remote) return (readChat().reads || []).filter((r) => r.channelId === channelId).map(({ memberId, lastReadAt }) => ({ memberId, lastReadAt }));
  try {
    const rows = await rest(`chat_reads?channel_id=eq.${enc(channelId)}&select=member_id,last_read_at`);
    return (rows || []).map((row) => ({ memberId: row.member_id, lastReadAt: Number(row.last_read_at) || 0 }));
  } catch (error) {
    // Before the SQL update there are simply no read receipts.
    if (error instanceof ChatSetupError) return [];
    throw error;
  }
}
