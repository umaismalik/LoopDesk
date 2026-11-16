// Cloud meeting transcription.
//
// 1. The browser cuts the recording into ~75-second WAV parts at natural pauses and sends several at once.
// 2. Each part goes to a large speech model (Whisper Large v3 on Groq, or OpenAI's transcription model),
//    with the team's names as a spelling hint.
// 3. Claude turns each part into clean English, spelling team names exactly as on the roster.
// 4. Claude then reads the whole English transcript and fills the shared notes and each member's card
//    (key points and action items), choosing members only from the project roster.
//
// Environment:
//   GROQ_API_KEY or OPENAI_API_KEY   speech recognition (Groq is preferred when both are set;
//                                    OPENAI_BASE_URL can point the OpenAI option at a compatible service)
//   ANTHROPIC_API_KEY                English clean-up and card filling (optional but recommended)
//   MEETING_SPEECH_LANGUAGE          language hint for speech recognition, default "ur"; "auto" to detect
// Without a speech key the app keeps using on-device transcription.
import Anthropic from "@anthropic-ai/sdk";
import { tenantSuspended } from "./tenant-store";
import { isPlatformAdmin } from "./platform-api";
import { lightAuth, projectTeam } from "./live-store";

const J = (o, s = 200) => Response.json(o, { status: s, headers: { "Cache-Control": "no-store" } });
const MODEL = "claude-opus-5-5";
const MAX_PART_BYTES = 4_000_000;

const speechProvider = () => process.env.GROQ_API_KEY ? "groq" : process.env.OPENAI_API_KEY ? "openai" : "";
const claudeReady = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
let claudeClient = null;
const claude = () => (claudeClient ||= new Anthropic({ maxRetries: 1 }));

// Per-member request budget so one browser cannot run up the speech bill.
const usage = new Map();
function withinBudget(memberId, cost = 1) {
  const now = Date.now(), hour = 3600_000;
  const entry = usage.get(memberId);
  if (!entry || now - entry.start > hour) { usage.set(memberId, { start: now, count: cost }); return true; }
  if (entry.count + cost > 400) return false;
  entry.count += cost;
  return true;
}

const cleanNames = (value) => (Array.isArray(value) ? value : [])
  .map((name) => String(name || "").replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 40)).filter(Boolean).slice(0, 40);

// ---------------------------------------------------------------------------------------------
// Speech recognition
// ---------------------------------------------------------------------------------------------

async function recognise(file, names, english) {
  const provider = speechProvider();
  const language = (process.env.MEETING_SPEECH_LANGUAGE ?? "ur").trim();
  const prompt = names.length ? `Software team meeting with ${names.join(", ")}. Tickets like ISS-01 and FTR-02.` : "Software team meeting.";
  const form = new FormData();
  form.append("file", file, "part.wav");
  form.append("prompt", prompt);
  form.append("temperature", "0");
  form.append("response_format", "json");
  let url;
  if (provider === "groq") {
    form.append("model", "whisper-large-v3");
    url = `https://api.groq.com/openai/v1/audio/${english ? "translations" : "transcriptions"}`;
  } else {
    form.append("model", english ? "whisper-1" : "gpt-4o-transcribe");
    url = `${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/audio/${english ? "translations" : "transcriptions"}`;
  }
  if (!english && language && language !== "auto") form.append("language", language);
  const key = provider === "groq" ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY;
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(45_000) }).catch((error) => ({ ok: false, status: 0, error }));
    if (response.ok) return String((await response.json()).text || "").trim();
    lastError = response.status ? `speech service returned ${response.status}` : "speech service unreachable";
    if (response.status && response.status !== 429 && response.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
  throw new Error(`Speech recognition failed (${lastError}).`);
}

// ---------------------------------------------------------------------------------------------
// Claude: English clean-up and card filling
// ---------------------------------------------------------------------------------------------

function textOf(message) {
  if (message.stop_reason === "refusal") throw new Error("The AI declined to process this part.");
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
}

const TRANSLATE_SYSTEM = `You convert raw speech-recognition output from a software company's team meeting into accurate written English.

The speakers mix Urdu and English. The raw text may be in Urdu script, Roman Urdu, Hindi (Devanagari) script, English, or a mix, and it contains recognition mistakes.

Rules:
- Translate faithfully and completely, sentence by sentence. Do not summarise, shorten, or add anything that was not said.
- Spell every team member's name exactly as it appears in the roster, even when the raw text spells it differently or in another script. Only use a roster name when the raw text clearly refers to that person.
- Keep technical terms, product and feature names, ticket IDs (such as ISS-01 or FTR-12), numbers, dates and deadlines exactly.
- When someone is addressed ("Adil, what is your update?") or names themselves, keep the name in the sentence so it is clear who is speaking or being asked.
- Drop filler words, false starts and obvious recognition noise (repeated phrases, "thank you for watching", subtitles credits).
- Output only the English text as plain sentences. If nothing meaningful was said, output nothing.`;

async function toEnglish(raw, names, previous) {
  if (!raw) return "";
  const message = await claude().beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: TRANSLATE_SYSTEM,
    messages: [{
      role: "user",
      content: `Team roster: ${names.join(", ") || "(not given)"}\n\n${previous ? `End of the previous part, for context only (do not repeat it):\n<previous>${previous}</previous>\n\n` : ""}Raw speech recognition of this part:\n<raw>${raw}</raw>`,
    }],
  }, { timeout: 45_000 });
  return textOf(message);
}

const STRUCTURE_SYSTEM = `You write the minutes of a software team's meeting from its English transcript, and fill one card per team member with what concerns them.

The meeting is usually a stand-up or review: a lead asks each member for their update ("Adil, what did you do?") and the member answers, then the next member is asked. Use the conversation to decide who said or owns what:
- A member's points are THEIR updates: work done, work in progress, blockers, and decisions that concern them. Write each point as one short, specific sentence in third person or neutral form ("Finished the login API and deployed it to staging").
- A member's tasks are action items assigned to or promised by them ("Fix the payment bug by Friday"). Start each with a verb; keep deadlines, ticket IDs and names exactly.
- Only create a card for a roster member who was actually discussed. Never invent facts, members, dates or tickets. If the owner of an item is unclear, leave it out of the cards and keep it only in the shared notes.
- priority is High when the member's items include an urgent issue, a blocker or a near deadline, Low for minor items, otherwise Medium.
- Shared notes: decisions made, overall progress, blockers/risks, and next steps for the whole meeting, each item one sentence. Use empty lists when there is nothing.`;

const STRUCTURE_SCHEMA = (memberIds) => ({
  type: "object",
  additionalProperties: false,
  required: ["notes", "cards"],
  properties: {
    notes: {
      type: "object",
      additionalProperties: false,
      required: ["decisions", "progress", "blockers", "nextSteps"],
      properties: {
        decisions: { type: "array", items: { type: "string" } },
        progress: { type: "array", items: { type: "string" } },
        blockers: { type: "array", items: { type: "string" } },
        nextSteps: { type: "array", items: { type: "string" } },
      },
    },
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["memberId", "points", "tasks", "priority"],
        properties: {
          memberId: { type: "string", enum: memberIds },
          points: { type: "array", items: { type: "string" } },
          tasks: { type: "array", items: { type: "string" } },
          priority: { type: "string", enum: ["High", "Medium", "Low"] },
        },
      },
    },
  },
});

async function structure(transcript, roster, selected) {
  const stream = claude().beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: STRUCTURE_SCHEMA(roster.map((member) => member.id)) } },
    system: STRUCTURE_SYSTEM,
    messages: [{
      role: "user",
      content: `Roster (use these ids for memberId):\n${roster.map((member) => `- ${member.id}: ${member.name}`).join("\n")}\n${selected ? `\nThe recorder selected ${selected.name}'s card before recording, so speech before anyone is addressed most likely belongs to ${selected.name}.\n` : ""}\nTranscript:\n<transcript>${transcript}</transcript>`,
    }],
  }, { timeout: 55_000 });
  const parsed = JSON.parse(textOf(await stream.finalMessage()));
  const lines = (value, limit) => [...new Set((Array.isArray(value) ? value : []).map((line) => String(line).trim().slice(0, 500)).filter(Boolean))].slice(0, limit);
  const byId = new Map();
  for (const card of parsed.cards || []) {
    const member = roster.find((item) => item.id === card.memberId);
    if (!member) continue;
    const earlier = byId.get(member.id) || { memberId: member.id, name: member.name, points: [], tasks: [], priority: "Medium" };
    byId.set(member.id, {
      ...earlier,
      points: lines([...earlier.points, ...(card.points || [])], 10),
      tasks: lines([...earlier.tasks, ...(card.tasks || [])], 10),
      priority: ["High", "Medium", "Low"].includes(card.priority) ? card.priority : earlier.priority,
    });
  }
  const notes = parsed.notes || {};
  return {
    notes: { decisions: lines(notes.decisions, 8), progress: lines(notes.progress, 10), blockers: lines(notes.blockers, 8), nextSteps: lines(notes.nextSteps, 10) },
    cards: [...byId.values()].filter((card) => card.points.length || card.tasks.length),
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP handler: /api/meeting-ai
// ---------------------------------------------------------------------------------------------

export async function meetingAiRequest(req, method, key, url) {
  try {
    const projectId = url.searchParams.get("project") || "";
    const me = await lightAuth(key, projectId);
    if (!me) return J({ error: "denied" }, 401);
    if (me.role === "Client") return J({ error: "Team access required" }, 403);
    if (me.organizationId && !isPlatformAdmin(me.email) && await tenantSuspended(me.organizationId)) return J({ error: "This company workspace is suspended.", suspended: true }, 403);

    if (method === "GET") return J({ ok: true, speech: !!speechProvider(), ai: claudeReady() });
    if (!speechProvider()) return J({ error: "Cloud transcription is not configured" }, 501);

    const type = req.headers.get("content-type") || "";
    if (type.startsWith("multipart/form-data")) {
      // One part of the recording: speech recognition, then English.
      const form = await req.formData();
      const file = form.get("file");
      if (!file || typeof file.arrayBuffer !== "function" || file.size < 1 || file.size > MAX_PART_BYTES) return J({ error: "Recording part is missing or too large" }, 400);
      if (!withinBudget(me.id)) return J({ error: "Too many transcription requests. Please wait a few minutes." }, 429);
      let names = [];
      try { names = cleanNames(JSON.parse(String(form.get("names") || "[]"))); } catch {}
      const previous = String(form.get("previous") || "").slice(-600);
      if (!claudeReady()) return J({ ok: true, english: await recognise(file, names, true), cleaned: false });
      const raw = await recognise(file, names, false);
      let english = "";
      try { english = await toEnglish(raw, names, previous); }
      catch { english = await recognise(file, names, true); }
      return J({ ok: true, english, cleaned: true });
    }

    const body = await req.json().catch(() => ({}));
    if (body.action === "structure") {
      if (!claudeReady()) return J({ error: "AI notes are not configured" }, 501);
      const transcript = String(body.transcript || "").trim().slice(0, 120_000);
      if (!transcript) return J({ error: "Transcript is empty" }, 400);
      if (!withinBudget(me.id, 2)) return J({ error: "Too many requests. Please wait a few minutes." }, 429);
      const team = new Set(await projectTeam(projectId));
      const roster = (Array.isArray(body.attendees) ? body.attendees : [])
        .map((member) => ({ id: String(member?.id || ""), name: cleanNames([member?.name])[0] || "" }))
        .filter((member) => member.id && member.name && team.has(member.id)).slice(0, 60);
      if (!roster.length) return J({ ok: true, notes: null, cards: [] });
      const selected = roster.find((member) => member.id === String(body.selectedMemberId || "")) || null;
      return J({ ok: true, ...(await structure(transcript, roster, selected)) });
    }
    return J({ error: "Unknown action" }, 400);
  } catch (error) {
    return J({ error: error.message || "Transcription failed" }, 500);
  }
}
