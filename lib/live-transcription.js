"use client";

// Live meeting transcription: the meeting is transcribed WHILE it is being recorded, so the notes are
// ready a few seconds after it ends instead of hours later.
//
// - The microphone is tapped (AudioWorklet) next to the normal recorder. Every ~60 seconds the audio is
//   cut at the quietest moment near the cut (so no word is split) and the part is transcribed at once:
//   by the server's speech service when one is configured, otherwise on this computer.
// - The card the recorder has selected while each part was spoken is remembered with the part, and a
//   member addressed by name ("Sami, your update?") becomes the current turn, so the right card is
//   selected and filled during the meeting.
// - Every 5 parts (~5 minutes) Claude writes the notes and cards for that stretch; at the end it only
//   has the last stretch and a short merge left to do.
// - Parts, the compressed recording and the AI notes are kept in browser storage as they are made
//   (lib/recording-store.js), so a closed tab, a crash or a lost connection loses at most the last
//   minute; the recording can be recovered and finished later. Lost connection: parts wait and are
//   sent when it is back.

import { saveSession, savePart, saveAudioChunk, loadSession } from "./recording-store";
import { cloudTranscriptionStatus, wav, wavSamples, transcribePartInCloud, minutesForStretch, mergeMinutes, formatAiNotes } from "./cloud-transcription";
import { transcribeSamples, correctTurnNames, lastTurnMember, generateMeetingParticipantCards, generateEnglishKeyPoints } from "./local-transcription";

const RATE = 16000;
const PART_SECONDS = 60, SEARCH_SECONDS = 15;
const WINDOW_PARTS = 5;
const CLOUD_PARALLEL = 3;
// The compressed recording is kept as files of at most this length, so each one stays well under the
// server's upload limit (about 2 MB at 24 kbit/s).
const FILE_SECONDS = 10 * 60;
const AUDIO_BITRATE = 24000;

const TAP_SOURCE = `class LoopDeskTap extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(8192); this.size = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      if (this.size + channel.length > this.buffer.length) { this.port.postMessage(this.buffer.slice(0, this.size)); this.size = 0; }
      this.buffer.set(channel, this.size); this.size += channel.length;
    }
    return true;
  }
}
registerProcessor("loopdesk-tap", LoopDeskTap);`;

const rms = (audio, start = 0, length = audio.length) => {
  let energy = 0;
  const end = Math.min(audio.length, start + length);
  for (let index = start; index < end; index += 1) energy += audio[index] * audio[index];
  return Math.sqrt(energy / Math.max(1, end - start));
};

function concat(chunks, length) {
  const all = new Float32Array(length);
  let offset = 0;
  chunks.forEach((chunk) => { all.set(chunk, offset); offset += chunk.length; });
  return all;
}

async function to16k(samples, rate) {
  if (rate === RATE) return samples;
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new Offline(1, Math.max(1, Math.ceil(samples.length * RATE / rate)), RATE);
  const buffer = offline.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

// Quiet laptop microphones lose words; bring the level up (never down) before recognition.
function boost(audio) {
  let peak = 0;
  for (let index = 0; index < audio.length; index += 1) peak = Math.max(peak, Math.abs(audio[index]));
  if (!peak || peak >= 0.5) return audio;
  const gain = Math.min(8, 0.9 / peak), boosted = new Float32Array(audio.length);
  for (let index = 0; index < audio.length; index += 1) boosted[index] = audio[index] * gain;
  return boosted;
}

const lines = (items, limit) => [...new Set(items.map((line) => String(line || "").trim()).filter(Boolean))].slice(0, limit);

/** Cards from several sources merged per member, in order. */
export function mergeCards(cardLists) {
  const byId = new Map();
  cardLists.flat().forEach((card) => {
    if (!card?.memberId) return;
    const earlier = byId.get(card.memberId) || { memberId: card.memberId, name: card.name, points: [], tasks: [], priority: "" };
    byId.set(card.memberId, {
      ...earlier,
      name: card.name || earlier.name,
      points: lines([...earlier.points, ...(card.points || [])], 15),
      tasks: lines([...earlier.tasks, ...(card.tasks || [])], 15),
      priority: ({ High: 3, Medium: 2, Low: 1 }[card.priority] || 0) > ({ High: 3, Medium: 2, Low: 1 }[earlier.priority] || 0) ? card.priority : earlier.priority,
    });
  });
  return [...byId.values()].map((card) => ({ ...card, priority: card.priority || "Medium" })).filter((card) => card.points.length || card.tasks.length);
}

const mergeNotes = (list) => {
  const sections = ["decisions", "progress", "blockers", "nextSteps"];
  return Object.fromEntries(sections.map((section) => [section, lines(list.flatMap((notes) => notes?.[section] || []), 20)]));
};

export class LiveTranscription {
  /**
   * options: { key, projectId, meeting, attendees: [{ id, name, aliases }], focus: () => memberId,
   *   onUpdate(view), onStatus(text), onTurn(memberId|null), onMicLost() }
   */
  constructor(options) {
    Object.assign(this, { onUpdate: () => {}, onStatus: () => {}, onTurn: () => {}, onMicLost: () => {} }, options);
    this.id = options.id || crypto.randomUUID();
    this.startedAt = Date.now();
    this.parts = [];
    this.windows = [];
    this.audioFiles = [];
    this.active = 0;
    this.carry = undefined; // the member whose turn it is, as heard in the transcript so far
    this.turnCursor = 0; // parts up to here have been read for turns and on-device cards
    this.finishing = false;
    this.final = null;
  }

  // ------------------------------------------------------------------------------------------
  // Recording
  // ------------------------------------------------------------------------------------------

  async start(stream) {
    this.stream = stream;
    const status = await cloudTranscriptionStatus(this.key, this.projectId);
    this.mode = status.speech ? "cloud" : "device";
    this.ai = status.ai;
    this.keyError = status.speechError || status.aiError || "";
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || typeof AudioWorkletNode === "undefined") throw new Error("Live transcription needs an up-to-date browser such as Chrome or Edge.");
    this.context = new AudioContextClass();
    const moduleUrl = URL.createObjectURL(new Blob([TAP_SOURCE], { type: "text/javascript" }));
    try { await this.context.audioWorklet.addModule(moduleUrl); }
    catch (error) { this.context.close().catch(() => {}); throw error; }
    finally { URL.revokeObjectURL(moduleUrl); }
    this.rate = this.context.sampleRate;
    this.chunks = []; this.length = 0; this.cutSamples = 0; this.fileSamples = 0;
    this.tally = new Map();
    const source = this.context.createMediaStreamSource(stream);
    this.tap = new AudioWorkletNode(this.context, "loopdesk-tap");
    const mute = this.context.createGain();
    mute.gain.value = 0;
    source.connect(this.tap).connect(mute).connect(this.context.destination);
    this.tap.port.onmessage = (event) => this.onSamples(event.data);
    await this.context.resume();
    this.audioType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
    this.startFile();
    stream.getAudioTracks().forEach((track) => { track.onended = () => { if (!this.stopped) this.onMicLost(); }; });
    this.persist("recording");
    this.status();
  }

  startFile() {
    const fileIndex = this.audioFiles.length, blobs = [];
    this.audioFiles.push(blobs);
    const recorder = new MediaRecorder(this.stream, { ...(this.audioType ? { mimeType: this.audioType } : {}), audioBitsPerSecond: AUDIO_BITRATE });
    this.audioType = recorder.mimeType || this.audioType || "audio/webm";
    let pending = [], seq = 0;
    const flush = () => {
      if (!pending.length) return;
      saveAudioChunk(this.id, fileIndex, seq++, new Blob(pending, { type: this.audioType }));
      pending = [];
    };
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      blobs.push(event.data); pending.push(event.data);
      if (pending.length >= 5 || recorder.state === "inactive") flush();
    };
    const stopped = new Promise((resolve) => { recorder.onstop = () => { flush(); resolve(); }; });
    recorder.start(1000);
    this.recorder = recorder;
    (this.recorderStops ||= []).push(stopped);
    this.fileSamples = 0;
  }

  onSamples(frame) {
    if (this.paused || this.stopped) return;
    this.chunks.push(frame);
    this.length += frame.length;
    const focus = this.focus?.() || "";
    this.tally.set(focus, (this.tally.get(focus) || 0) + frame.length);
    this.fileSamples += frame.length;
    if (this.fileSamples >= FILE_SECONDS * this.rate) {
      const previous = this.recorder;
      this.startFile();
      if (previous.state !== "inactive") previous.stop();
    }
    if (this.length >= PART_SECONDS * this.rate) this.cut(false);
  }

  pause() { this.paused = true; if (this.recorder?.state === "recording") this.recorder.pause(); }
  resume() { this.paused = false; if (this.recorder?.state === "paused") this.recorder.resume(); }

  /** Seconds of audio recorded so far. */
  get seconds() { return Math.round((this.cutSamples + (this.length || 0)) / (this.rate || RATE)); }

  cut(final) {
    if (!this.length) return;
    const all = concat(this.chunks, this.length), rate = this.rate;
    let cutAt = all.length;
    if (!final) {
      const frame = Math.round(0.3 * rate), step = Math.round(0.1 * rate);
      let quietest = Infinity;
      for (let position = (PART_SECONDS - SEARCH_SECONDS) * rate; position + frame <= PART_SECONDS * rate; position += step) {
        const level = rms(all, position, frame);
        if (level < quietest) { quietest = level; cutAt = position + Math.round(frame / 2); }
      }
    }
    const piece = all.subarray(0, cutAt), rest = all.slice(cutAt);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    // The card that was selected for most of this part.
    const focus = [...this.tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    this.tally = new Map();
    const startSec = this.cutSamples / rate;
    this.cutSamples += piece.length;
    const part = { sessionId: this.id, index: this.parts.length, startSec, endSec: this.cutSamples / rate, focus, english: null, state: "preparing", attempts: 0 };
    this.parts.push(part);
    this.persist();
    to16k(piece, rate).then((samples) => {
      if (rms(samples) < 0.002) { this.complete(part, ""); return; }
      part.wav = wav(boost(samples));
      part.state = "pending";
      savePart(this.record(part));
      this.pump();
    }).catch(() => this.complete(part, "", true));
  }

  // ------------------------------------------------------------------------------------------
  // Transcription
  // ------------------------------------------------------------------------------------------

  pump() {
    clearTimeout(this.retryTimer);
    const limit = this.mode === "cloud" ? CLOUD_PARALLEL : 1;
    const now = Date.now();
    while (this.active < limit) {
      const part = this.parts.find((item) => item.state === "pending" && (!item.retryAt || item.retryAt <= now));
      if (!part) break;
      this.active += 1;
      this.run(part).finally(() => { this.active -= 1; this.pump(); });
    }
    const next = Math.min(...this.parts.filter((item) => item.state === "pending" && item.retryAt > now).map((item) => item.retryAt));
    if (Number.isFinite(next)) this.retryTimer = setTimeout(() => this.pump(), Math.max(500, next - now));
    this.status();
  }

  async run(part) {
    part.state = "working";
    this.status();
    try {
      let english;
      if (this.mode === "cloud") {
        const previous = this.parts[part.index - 1]?.english || "";
        english = await transcribePartInCloud(part.wav, { key: this.key, projectId: this.projectId, names: this.spellings(), previous });
      } else {
        const samples = await wavSamples(part.wav);
        english = await transcribeSamples(samples, (message) => this.status(message), { names: this.attendees, model: "best" });
      }
      this.offline = false;
      this.complete(part, english);
    } catch (error) {
      if (this.mode === "cloud" && (error.status === 501 || error.keyRejected)) {
        if (error.keyRejected) this.keyError = error.message;
        // The server has no speech service after all: transcribe on this computer instead.
        this.mode = "device";
        part.state = "pending";
        return;
      }
      part.attempts += 1;
      const network = !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
      this.offline = !error.status;
      if (this.mode === "device" ? part.attempts >= 2 : (!network && part.attempts >= 2) || part.attempts >= 12) {
        this.complete(part, "", true);
        return;
      }
      part.state = "pending";
      part.retryAt = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(part.attempts, 5));
    }
  }

  spellings() {
    return [...new Set(this.attendees.flatMap((attendee) => [attendee.name, ...(attendee.aliases || []).slice(0, 2)]))].filter(Boolean);
  }

  complete(part, english, failed = false) {
    part.english = this.mode === "device" && english ? correctTurnNames(english, this.attendees) : english;
    part.state = failed ? "failed" : "done";
    part.wav = null;
    savePart(this.record(part));
    this.readTurns();
    this.nextWindow();
    this.emit();
    this.status();
    this.checkDone();
  }

  record(part) {
    const { sessionId, index, startSec, endSec, focus, english, state, wav: audio } = part;
    return { sessionId, index, startSec, endSec, focus, english, state, wav: audio || null };
  }

  /** In order: whose turn it is (selects their card live) and on-device cards for each part. */
  readTurns() {
    while (this.turnCursor < this.parts.length && ["done", "failed"].includes(this.parts[this.turnCursor].state)) {
      const part = this.parts[this.turnCursor], previous = this.parts[this.turnCursor - 1];
      // Clicking another card overrides what was heard: from then on that member is speaking.
      if (previous && part.focus && part.focus !== previous.focus) this.carry = undefined;
      const fallback = this.carry === undefined ? part.focus : this.carry?.id || "";
      part.cards = part.english ? generateMeetingParticipantCards(part.english, this.attendees, fallback) : [];
      const turn = part.english ? lastTurnMember(part.english, this.attendees) : undefined;
      if (turn !== undefined) {
        this.carry = turn;
        if (!this.finishing) this.onTurn(turn?.id || null);
      }
      this.turnCursor += 1;
    }
  }

  // ------------------------------------------------------------------------------------------
  // AI notes, a stretch at a time
  // ------------------------------------------------------------------------------------------

  windowText(from, to) {
    const names = new Map(this.attendees.map((attendee) => [attendee.id, attendee.name]));
    let text = "";
    for (let index = from; index < to; index += 1) {
      const part = this.parts[index];
      if (index > from && part.focus && part.focus !== this.parts[index - 1].focus && names.has(part.focus)) text += `[Card selected: ${names.get(part.focus)}]\n`;
      if (part.english) text += `${part.english}\n`;
    }
    return text.trim();
  }

  /** Starts the AI notes for the next full stretch (or, when finishing, the last partial one). */
  nextWindow() {
    if (!this.ai || this.windowBusy || (this.windowRetryAt && this.windowRetryAt > Date.now())) return;
    const from = this.windows.length ? this.windows.at(-1).to : 0;
    let to = from;
    while (to < this.parts.length && to - from < WINDOW_PARTS && ["done", "failed"].includes(this.parts[to].state)) to += 1;
    const full = to - from === WINDOW_PARTS;
    const last = this.finishing && to === this.parts.length && this.parts.every((part) => ["done", "failed"].includes(part.state));
    if (to === from || (!full && !last)) return;
    const text = this.windowText(from, to);
    if (!text) { this.windows.push({ from, to, notes: null, cards: [] }); this.persist(); this.nextWindow(); this.checkDone(); return; }
    const context = this.parts.slice(Math.max(0, from - 3), from).map((part) => part.english).filter(Boolean).join("\n").slice(-1500);
    this.windowBusy = true;
    minutesForStretch(text, { key: this.key, projectId: this.projectId, attendees: this.attendees, selectedMemberId: this.parts[from].focus, context })
      .then((minutes) => {
        this.windows.push({ from, to, notes: minutes.notes, cards: minutes.cards });
        this.windowFailures = 0;
        this.persist();
        this.emit();
      })
      .catch((error) => {
        if (error.status === 501) { this.ai = false; this.emit(); return; }
        this.windowFailures = (this.windowFailures || 0) + 1;
        this.windowRetryAt = Date.now() + Math.min(60_000, 3000 * 2 ** Math.min(this.windowFailures, 4));
        setTimeout(() => this.nextWindow(), Math.min(60_000, 3000 * 2 ** Math.min(this.windowFailures, 4)) + 50);
        // At the end, after repeated failures, finish with on-device notes for the rest.
        if (this.finishing && this.windowFailures >= 3) this.ai = false;
      })
      .finally(() => { this.windowBusy = false; this.nextWindow(); this.checkDone(); });
  }

  // ------------------------------------------------------------------------------------------
  // What the page shows
  // ------------------------------------------------------------------------------------------

  transcript() {
    return this.parts.filter((part) => part.english).map((part) => part.english).join("\n\n");
  }

  view() {
    if (this.final) return this.final;
    const transcript = this.transcript();
    const covered = this.windows.length ? this.windows.at(-1).to : 0;
    const aiNotes = this.windows.length ? formatAiNotes(mergeNotes(this.windows.map((window) => window.notes))) : "";
    // AI cards for the stretches done so far, on-device cards for the newest minutes until their stretch is done.
    const cards = mergeCards([...this.windows.map((window) => window.cards), ...this.parts.slice(covered).map((part) => part.cards || [])]);
    return { transcript, notes: aiNotes || (this.ai ? "" : generateEnglishKeyPoints(transcript)), cards, ai: !!aiNotes };
  }

  emit() { this.onUpdate(this.view()); }

  status(detail = "") {
    const total = this.parts.length, finished = this.parts.filter((part) => ["done", "failed"].includes(part.state)).length;
    const waiting = total - finished;
    let text;
    if (this.offline && waiting) text = `No internet: ${waiting} minute(s) of audio are saved on this computer and will be transcribed when the connection is back.`;
    else if (this.finishing) text = waiting ? `Finishing the last ${waiting} minute(s) of audio…${detail ? ` ${detail}` : ""}` : this.windowBusy ? "Writing the final notes and member cards…" : "Finishing…";
    else text = waiting ? `Transcribing as you speak · ${finished} of ${total} minute(s) done${this.mode === "device" ? " on this computer" : ""}` : total ? `Transcribed live · ${total} minute(s)` : "Listening…";
    this.onStatus(text, { mode: this.mode, ai: this.ai, offline: !!this.offline, keyError: this.keyError || "" });
  }

  persist(state) {
    if (state) this.state = state;
    saveSession({
      id: this.id, projectId: this.projectId, meeting: this.meeting, startedAt: this.startedAt, updatedAt: Date.now(),
      audioType: this.audioType, mode: this.mode, ai: this.ai, state: this.state, windows: this.windows, final: this.final,
      seconds: this.seconds, parts: this.parts.length,
    });
  }

  // ------------------------------------------------------------------------------------------
  // Finishing
  // ------------------------------------------------------------------------------------------

  /** Stops recording and resolves with { audioFiles, transcript, notes, cards, ai } once everything is done. */
  async finish() {
    if (!this.stopped) {
      this.stopped = true;
      this.cut(true);
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
      await Promise.all(this.recorderStops || []);
      this.tap?.port && (this.tap.port.onmessage = null);
      await this.context?.close().catch(() => {});
      this.stream?.getTracks().forEach((track) => track.stop());
    }
    this.finishing = true;
    if (this.final) return { ...this.final, audioFiles: this.audioBlobs() };
    this.persist("finishing");
    this.status();
    await new Promise((resolve) => { this.resolveDone = resolve; this.nextWindow(); this.checkDone(); this.pump(); });
    return { ...this.final, audioFiles: this.audioBlobs() };
  }

  audioBlobs() {
    if (this.recoveredAudio) return this.recoveredAudio;
    return this.audioFiles.map((blobs) => new Blob(blobs, { type: this.audioType })).filter((blob) => blob.size);
  }

  checkDone() {
    if (!this.finishing || this.final || this.merging || !this.resolveDone) return;
    if (!this.parts.every((part) => ["done", "failed"].includes(part.state))) return;
    if (this.ai && (this.windowBusy || (this.windows.at(-1)?.to || 0) < this.parts.length)) return;
    this.merging = true;
    this.status();
    const transcript = this.transcript();
    const local = () => {
      const covered = this.windows.length ? this.windows.at(-1).to : 0;
      const aiNotes = this.windows.length ? formatAiNotes(mergeNotes(this.windows.map((window) => window.notes))) : "";
      const rest = this.parts.slice(covered).map((part) => part.english).filter(Boolean).join("\n\n");
      const notes = [aiNotes, rest ? generateEnglishKeyPoints(covered ? rest : transcript) : ""].filter(Boolean).join("\n\n");
      return { transcript, notes, cards: mergeCards([...this.windows.map((window) => window.cards), ...this.parts.slice(covered).map((part) => part.cards || [])]), ai: !!aiNotes };
    };
    const windows = this.windows.filter((window) => window.notes || window.cards.length);
    const finalMinutes = this.ai && windows.length
      ? mergeMinutes(windows.map(({ notes, cards }) => ({ notes, cards })), { key: this.key, projectId: this.projectId, attendees: this.attendees })
        .then((minutes) => ({ transcript, notes: formatAiNotes(minutes.notes), cards: minutes.cards, ai: true }))
        .catch(() => local())
      : Promise.resolve(local());
    finalMinutes.then((final) => {
      this.final = final;
      this.persist("done");
      this.emit();
      this.resolveDone(final);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Recovery after a closed tab or crash
  // ------------------------------------------------------------------------------------------

  /** Picks up a saved recording; finish() then completes whatever was left. */
  static async recover(id, options) {
    const saved = await loadSession(id);
    if (!saved) throw new Error("This recording is no longer saved in this browser.");
    const { session, parts, audioFiles } = saved;
    const live = new LiveTranscription({ ...options, id, meeting: session.meeting });
    Object.assign(live, { startedAt: session.startedAt, audioType: session.audioType, windows: session.windows || [], final: session.final || null, stopped: true, recoveredAudio: audioFiles, rate: RATE });
    const status = await cloudTranscriptionStatus(options.key, options.projectId);
    live.mode = status.speech ? "cloud" : "device";
    live.ai = status.ai;
    live.parts = parts.map((part) => ({ ...part, attempts: 0, state: part.state === "done" || part.state === "failed" ? part.state : part.wav ? "pending" : "failed", english: part.english || (part.state === "done" ? "" : null) }));
    live.cutSamples = (parts.at(-1)?.endSec || session.seconds || 0) * RATE;
    live.readTurns();
    if (live.final) live.final = { ...live.final };
    return live;
  }
}
