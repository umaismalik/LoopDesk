"use client";

// Browser side of cloud meeting transcription (server side: lib/meeting-ai.js).
// The recording is decoded once, cut into ~75-second parts at the quietest moment near each cut (so no
// word is split), encoded as small 16 kHz WAV files and sent several at a time. A 30-minute meeting is
// about 24 parts and is usually done in well under a minute.
import { decodeMono16k } from "./local-transcription";

const RATE = 16000;
const TARGET_SECONDS = 75, SEARCH_SECONDS = 15, LAST_PART_MAX_SECONDS = 90;
const PARALLEL = 4;
const statusCache = new Map();

const call = (path, key, projectId, init = {}) =>
  fetch(`/api/${path}?project=${encodeURIComponent(projectId)}`, { ...init, headers: { "x-key": key || "", ...(init.headers || {}) } })
    .then(async (response) => ({ status: response.status, ...(await response.json().catch(() => ({}))) }));

/** { speech, ai }: whether the server has a speech service and Claude configured. Cached per project. */
export async function cloudTranscriptionStatus(key, projectId) {
  if (!key || !projectId) return { speech: false, ai: false };
  if (!statusCache.has(projectId)) {
    statusCache.set(projectId, call("meeting-ai", key, projectId).then((r) => ({ speech: !!r.speech, ai: !!r.ai })).catch(() => ({ speech: false, ai: false })));
  }
  const status = await statusCache.get(projectId);
  if (!status.speech) statusCache.delete(projectId);
  return status;
}

const rms = (audio, start, length) => {
  let energy = 0;
  const end = Math.min(audio.length, start + length);
  for (let index = start; index < end; index += 1) energy += audio[index] * audio[index];
  return Math.sqrt(energy / Math.max(1, end - start));
};

// Cut points at the quietest 0.3 s window in the last SEARCH_SECONDS before each target length.
function splitAtPauses(audio) {
  const parts = [];
  let start = 0;
  while (start < audio.length) {
    if (audio.length - start <= LAST_PART_MAX_SECONDS * RATE) { parts.push(audio.subarray(start)); break; }
    const searchFrom = start + (TARGET_SECONDS - SEARCH_SECONDS) * RATE, searchTo = start + TARGET_SECONDS * RATE;
    const frame = Math.round(0.3 * RATE), step = Math.round(0.1 * RATE);
    let cut = searchTo, quietest = Infinity;
    for (let position = searchFrom; position + frame <= searchTo; position += step) {
      const level = rms(audio, position, frame);
      if (level < quietest) { quietest = level; cut = position + Math.round(frame / 2); }
    }
    parts.push(audio.subarray(start, cut));
    start = cut;
  }
  return parts;
}

function wav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Decodes the recording in the browser; throws a clear error for a silent or unreadable recording. */
export const decodeRecording = decodeMono16k;

/**
 * English transcript of a decoded recording, via the server. `names` are the team names (spelling hints).
 * Throws if the service fails, so the caller can fall back to on-device transcription.
 */
export async function transcribeInCloud(audio, { key, projectId, names = [], onProgress = () => {} }) {
  const parts = splitAtPauses(audio);
  const results = new Array(parts.length).fill("");
  let next = 0, done = 0;
  onProgress(parts.length > 1 ? `Transcribing ${parts.length} parts in parallel…` : "Transcribing…");
  const worker = async () => {
    while (next < parts.length) {
      const index = next++;
      const part = parts[index];
      if (part.length < RATE * 0.5 || rms(part, 0, part.length) < 0.002) { done += 1; continue; }
      const form = new FormData();
      form.append("file", wav(part), `part-${index + 1}.wav`);
      form.append("names", JSON.stringify(names));
      const result = await call("meeting-ai", key, projectId, { method: "POST", body: form });
      if (!result.ok) throw new Error(result.error || "Cloud transcription failed");
      results[index] = String(result.english || "").trim();
      done += 1;
      if (parts.length > 1) onProgress(`Transcribing… ${done} of ${parts.length} parts done`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, parts.length) }, worker));
  return results.filter(Boolean).join("\n");
}

/** Shared notes and member cards filled by Claude from the English transcript, or null if unavailable. */
export async function structureInCloud(transcript, { key, projectId, attendees = [], selectedMemberId = "" }) {
  const result = await call("meeting-ai", key, projectId, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "structure", transcript, attendees: attendees.map((member) => ({ id: member.id, name: member.name })), selectedMemberId }),
  });
  if (!result.ok) throw new Error(result.error || "AI notes failed");
  return { notes: result.notes, cards: result.cards || [] };
}

/** The shared notes in the same text layout as the on-device key points. */
export function formatAiNotes(notes) {
  if (!notes) return "";
  const sections = [["Decisions", notes.decisions], ["Progress", notes.progress], ["Blockers / risks", notes.blockers], ["Next steps", notes.nextSteps]]
    .filter(([, items]) => items?.length);
  return sections.length ? `Meeting key points (English)\n${sections.map(([title, items]) => `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`).join("\n")}` : "";
}
