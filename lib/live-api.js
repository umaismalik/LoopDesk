// API for live updates ("pulse") and team chat. These run on a lightweight session check instead
// of the full workspace load, because every open browser calls them every few seconds.
import { tenantSuspended } from "./tenant-store";
import { isPlatformAdmin } from "./platform-api";
import {
  ChatSetupError, addMessage, bumpProjectVersion, canSeeChannel, createChannel, deleteChannel, deleteMessage, getChannel,
  getMessage, lightAuth, listChannels, listMessages, listReads, markRead, projectTeam, projectVersion, updateChannel, updateMessage,
} from "./live-store";

const J = (o, s = 200) => Response.json(o, { status: s, headers: { "Cache-Control": "no-store" } });
export const REACTIONS = ["👍", "✅", "🎉", "👀", "🙏", "❤️", "😂", "🚀"];
const channelName = (value) => String(value || "").trim().toLowerCase().replace(/^#+/, "").replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const publicChannel = (c) => ({ id: c.id, name: c.name, topic: c.topic, kind: c.kind, isPrivate: c.isPrivate, memberIds: c.memberIds, createdBy: c.createdBy, createdAt: c.createdAt, lastMessageAt: c.lastMessageAt, lastAuthorId: c.lastAuthorId });

// A new project starts with #general (everyone) and #announcements.
async function ensureDefaults(projectId, me) {
  let channels = await listChannels(projectId);
  if (!channels.some((c) => c.kind === "channel" && c.name === "general")) {
    await createChannel({ projectId, name: "general", topic: "Team-wide conversation for this project", kind: "channel", createdBy: me.id });
    if (!channels.some((c) => c.kind === "channel" && c.name === "announcements")) {
      await createChannel({ projectId, name: "announcements", topic: "Releases, deadlines and important updates", kind: "channel", createdBy: me.id });
    }
    channels = await listChannels(projectId);
  }
  return channels;
}

export async function liveRequest(req, resource, method, key, url) {
  try {
    const projectId = url.searchParams.get("project") || "";
    const me = await lightAuth(key, projectId);
    if (!me) return J({ error: "denied" }, 401);
    if (me.organizationId && !isPlatformAdmin(me.email) && await tenantSuspended(me.organizationId)) return J({ error: "This company workspace is suspended. Please contact LoopDesk support.", suspended: true }, 403);

    if (resource === "pulse") {
      const version = await projectVersion(projectId);
      if (me.role === "Client") return J({ v: version });
      let channels = [];
      try {
        channels = (await listChannels(projectId)).filter((c) => canSeeChannel(c, me.id))
          .map((c) => ({ id: c.id, name: c.name, kind: c.kind, lastMessageAt: c.lastMessageAt, lastAuthorId: c.lastAuthorId }));
      } catch (error) {
        if (!(error instanceof ChatSetupError)) throw error;
      }
      return J({ v: version, channels });
    }

    if (me.role === "Client") return J({ error: "Team chat is available to project team members only" }, 403);
    // The team list is only needed to list or create conversations, not to read or send messages.
    let teamPromise;
    const getTeam = () => (teamPromise ||= projectTeam(projectId));

    if (method === "GET") {
      const channelId = url.searchParams.get("channel");
      if (!channelId) {
        const [all, team] = await Promise.all([ensureDefaults(projectId, me), getTeam()]);
        const channels = all.filter((c) => canSeeChannel(c, me.id));
        return J({ channels: channels.map(publicChannel), team, reactions: REACTIONS });
      }
      const channel = await getChannel(projectId, channelId);
      if (!channel || !canSeeChannel(channel, me.id)) return J({ error: "Channel not found" }, 404);
      const after = Number(url.searchParams.get("after") || 0), before = Number(url.searchParams.get("before") || 0);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 80)));
      // Messages and read receipts load together, so polling stays a single round trip.
      const [messages, reads] = await Promise.all([listMessages(channel.id, { after, before, limit }), before ? Promise.resolve(null) : listReads(channel.id)]);
      return J({ channel: publicChannel(channel), messages, hasMore: !after && messages.length === limit, ...(reads ? { reads: reads.filter((r) => r.memberId !== me.id) } : {}) });
    }

    const b = await req.json();
    const action = String(b.action || "");
    const loadVisibleChannel = async (id) => {
      const channel = await getChannel(projectId, String(id || ""));
      return channel && canSeeChannel(channel, me.id) ? channel : null;
    };
    const loadOwnMessage = async (id) => {
      const message = await getMessage(String(id || ""));
      const channel = message && await loadVisibleChannel(message.channelId);
      return channel ? { message, channel } : {};
    };

    if (action === "create-channel") {
      const name = channelName(b.name);
      if (!name) return J({ error: "Enter a channel name (letters, numbers and dashes)" }, 400);
      const existing = await listChannels(projectId);
      if (existing.some((c) => c.kind === "channel" && c.name === name)) return J({ error: `#${name} already exists` }, 400);
      const isPrivate = !!b.isPrivate, team = await getTeam();
      const memberIds = isPrivate ? [...new Set([me.id, ...(Array.isArray(b.memberIds) ? b.memberIds : []).filter((id) => team.includes(id))])] : [];
      const channel = await createChannel({ projectId, name, topic: String(b.topic || "").trim().slice(0, 200), kind: "channel", isPrivate, memberIds, createdBy: me.id });
      return J({ ok: true, channel: publicChannel(channel) });
    }
    if (action === "open-dm") {
      const other = String(b.memberId || ""), team = await getTeam();
      if (!team.includes(other) || other === me.id) return J({ error: "Choose a team member" }, 400);
      const pair = [me.id, other].sort();
      const existing = (await listChannels(projectId)).find((c) => c.kind === "dm" && c.memberIds.length === 2 && [...c.memberIds].sort().join() === pair.join());
      const channel = existing || await createChannel({ projectId, name: pair.join("-"), kind: "dm", isPrivate: true, memberIds: pair, createdBy: me.id });
      return J({ ok: true, channel: publicChannel(channel) });
    }
    if (action === "update-channel") {
      const channel = await loadVisibleChannel(b.channelId);
      if (!channel || channel.kind !== "channel") return J({ error: "Channel not found" }, 404);
      if (channel.createdBy !== me.id && me.role !== "Admin") return J({ error: "Only the channel creator or an admin can edit this channel" }, 403);
      const changes = {}, team = await getTeam();
      if (typeof b.topic === "string") changes.topic = b.topic.trim().slice(0, 200);
      if (channel.isPrivate && Array.isArray(b.memberIds)) changes.memberIds = [...new Set([channel.createdBy, me.id, ...b.memberIds.filter((id) => team.includes(id))])].filter(Boolean);
      return J({ ok: true, channel: publicChannel(await updateChannel(channel.id, changes)) });
    }
    if (action === "delete-channel") {
      const channel = await loadVisibleChannel(b.channelId);
      if (!channel || channel.kind !== "channel") return J({ error: "Channel not found" }, 404);
      if (channel.name === "general") return J({ error: "#general cannot be deleted" }, 400);
      if (channel.createdBy !== me.id && me.role !== "Admin") return J({ error: "Only the channel creator or an admin can delete this channel" }, 403);
      await deleteChannel(channel.id);
      return J({ ok: true });
    }
    if (action === "read") {
      const channel = await loadVisibleChannel(b.channelId);
      if (!channel) return J({ error: "Channel not found" }, 404);
      await markRead(channel.id, me.id, Math.min(Number(b.at) || 0, Date.now()));
      return J({ ok: true });
    }
    if (action === "send") {
      const channel = await loadVisibleChannel(b.channelId);
      if (!channel) return J({ error: "Channel not found" }, 404);
      const body = String(b.body || "").replace(/\r\n/g, "\n").trim().slice(0, 4000);
      if (!body) return J({ error: "Write a message first" }, 400);
      if (channel.name === "announcements" && channel.kind === "channel" && !["Admin", "Collaborator"].includes(me.role)) {
        return J({ error: "Only admins and collaborators can post in #announcements" }, 403);
      }
      return J({ ok: true, message: await addMessage(projectId, channel.id, me.id, body) });
    }
    if (action === "edit") {
      const { message } = await loadOwnMessage(b.messageId);
      if (!message || message.deleted) return J({ error: "Message not found" }, 404);
      if (message.authorId !== me.id) return J({ error: "You can only edit your own messages" }, 403);
      const body = String(b.body || "").replace(/\r\n/g, "\n").trim().slice(0, 4000);
      if (!body) return J({ error: "A message cannot be empty" }, 400);
      return J({ ok: true, message: await updateMessage(message.id, { body, editedAt: Date.now() }) });
    }
    if (action === "delete-message") {
      const { message } = await loadOwnMessage(b.messageId);
      if (!message) return J({ error: "Message not found" }, 404);
      if (message.authorId !== me.id && me.role !== "Admin") return J({ error: "You can only delete your own messages" }, 403);
      return J({ ok: true, message: await deleteMessage(message.id) });
    }
    if (action === "react") {
      const { message } = await loadOwnMessage(b.messageId);
      if (!message || message.deleted) return J({ error: "Message not found" }, 404);
      const emoji = String(b.emoji || "");
      if (!REACTIONS.includes(emoji)) return J({ error: "Unsupported reaction" }, 400);
      const reactions = { ...(message.reactions || {}) };
      const who = new Set(reactions[emoji] || []);
      if (who.has(me.id)) who.delete(me.id); else who.add(me.id);
      if (who.size) reactions[emoji] = [...who]; else delete reactions[emoji];
      return J({ ok: true, message: await updateMessage(message.id, { reactions }) });
    }
    return J({ error: "Unknown chat action" }, 400);
  } catch (error) {
    if (error instanceof ChatSetupError) return J({ error: error.message, setup: true }, 503);
    console.error("Live request failed:", error);
    return J({ error: `Request failed: ${error?.message || error}` }, 500);
  }
}

export { bumpProjectVersion };
