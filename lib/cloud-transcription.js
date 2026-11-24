"use client";

// Browser side of cloud meeting transcription (server side: lib/meeting-ai.js). The recording is cut
// into parts and sent while the meeting goes on by lib/live-transcription.js.

const RATE = 16000;
const statusCache = new Map();

const call = (path, key, projectId, init = {}) =>
  fetch(`/api/${path}?project=${encodeURIComponent(projectId)}`, { ...init, headers: { "x-key": key || "", ...(init.headers || {}) } })
    .then(async (response) => ({ status: response.status, ...(await response.json().catch(() => ({}))) }));

/** { speech, ai }: whether the server has a speech service and Claude configured. Cached per project. */
export async function cloudTranscriptionStatus(key, projectId) {
  if (!key || !projectId) return { speech: false, ai: false };
  if (!statusCache.has(projectId)) {
    statusCache.set(projectId, call("meeting-ai", key, projectId).then((r) => ({ speech: !!r.speech, ai: !!r.ai, speechError: r.speechError || "", aiError: r.aiError || "", known: r.status === 200 })).catch(() => ({ speech: false, ai: false, known: false })));
  }
  const status = await statusCache.get(projectId);
  if (!status.known) statusCache.delete(projectId);
  return status;
}

/** 16 kHz mono 16-bit WAV of the given samples. */
export function wav(samples) {
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

/** Samples of a 16 kHz mono 16-bit WAV made by `wav`. */
export async function wavSamples(blob) {
  const view = new DataView(await blob.arrayBuffer());
  const samples = new Float32Array(Math.max(0, (view.byteLength - 44) >> 1));
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(44 + index * 2, true) / 0x8000;
  return samples;
}

/**
 * English text of one recording part, via the server. Throws an error with `status` set: 501 means the
 * server has no speech service, 4xx (other than 408/429) means the part itself was refused.
 */
export async function transcribePartInCloud(file, { key, projectId, names = [], previous = "" }) {
  const form = new FormData();
  form.append("file", file, "part.wav");
  form.append("names", JSON.stringify(names));
  if (previous) form.append("previous", previous.slice(-600));
  const result = await call("meeting-ai", key, projectId, { method: "POST", body: form }).catch(() => ({ status: 0 }));
  if (!result.ok) throw Object.assign(new Error(result.error || (result.status ? "Cloud transcription failed" : "No internet connection")), { status: result.status, keyRejected: !!result.keyRejected });
  return String(result.english || "").trim();
}

const roster = (attendees) => attendees.map((member) => ({ id: member.id, name: member.name }));

/** Shared notes and member cards for one stretch of the meeting, written by Claude. */
export async function minutesForStretch(transcript, { key, projectId, attendees = [], selectedMemberId = "", context = "" }) {
  const result = await call("meeting-ai", key, projectId, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "structure", transcript, context, attendees: roster(attendees), selectedMemberId }),
  }).catch(() => ({ status: 0 }));
  if (!result.ok) throw Object.assign(new Error(result.error || "AI notes failed"), { status: result.status });
  return { notes: result.notes, cards: result.cards || [] };
}

/** The whole meeting's notes and cards, merged by Claude from the notes of its stretches. */
export async function mergeMinutes(windows, { key, projectId, attendees = [] }) {
  const result = await call("meeting-ai", key, projectId, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "merge", windows, attendees: roster(attendees) }),
  }).catch(() => ({ status: 0 }));
  if (!result.ok) throw Object.assign(new Error(result.error || "AI notes failed"), { status: result.status });
  return { notes: result.notes, cards: result.cards || [] };
}

/** The shared notes in the same text layout as the on-device key points. */
export function formatAiNotes(notes) {
  if (!notes) return "";
  const sections = [["Decisions", notes.decisions], ["Progress", notes.progress], ["Blockers / risks", notes.blockers], ["Next steps", notes.nextSteps]]
    .filter(([, items]) => items?.length);
  return sections.length ? `Meeting key points (English)\n${sections.map(([title, items]) => `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`).join("\n")}` : "";
}
