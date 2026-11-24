"use client";

// Keeps a meeting recording on this computer (IndexedDB) while it is recorded and transcribed, so a
// closed tab, a crash, a restart or a lost connection does not lose the meeting:
// - sessions: one per recording clip (the meeting it belongs to, progress, AI notes so far)
// - parts:    the ~1-minute speech parts; the audio is kept until the part's English text is saved
// - audio:    the compressed recording itself (saved every few seconds), uploaded with the note
// Everything for a session is removed once its note is saved or the recording is discarded.

const DB_NAME = "loopdesk-recordings";
let dbPromise = null;

function open() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Browser storage is unavailable"));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("sessions", { keyPath: "id" });
        db.createObjectStore("parts", { keyPath: ["sessionId", "index"] });
        db.createObjectStore("audio", { keyPath: ["sessionId", "file", "seq"] });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Browser storage is busy in another tab"));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

const done = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error("Storage write was aborted"));
});
const result = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const range = (sessionId) => IDBKeyRange.bound([sessionId], [sessionId, []]);

async function write(store, value) {
  const db = await open();
  const transaction = db.transaction(store, "readwrite");
  transaction.objectStore(store).put(value);
  return done(transaction);
}

// Storage is a safety net: a failed write must never stop the recording itself.
const safely = (promise) => promise.catch(() => {});

export const saveSession = (session) => safely(write("sessions", session));
export const savePart = (part) => safely(write("parts", part));
export const saveAudioChunk = (sessionId, file, seq, blob) => safely(write("audio", { sessionId, file, seq, blob }));

/** Unfinished recordings of a project, newest first. */
export async function listSessions(projectId) {
  try {
    const db = await open();
    const sessions = await result(db.transaction("sessions").objectStore("sessions").getAll());
    return sessions.filter((session) => session.projectId === projectId).sort((a, b) => b.startedAt - a.startedAt);
  } catch { return []; }
}

/** A session with its parts (in order) and its recording files rebuilt from the saved chunks. */
export async function loadSession(id) {
  const db = await open();
  const transaction = db.transaction(["sessions", "parts", "audio"]);
  const [session, parts, chunks] = await Promise.all([
    result(transaction.objectStore("sessions").get(id)),
    result(transaction.objectStore("parts").getAll(range(id))),
    result(transaction.objectStore("audio").getAll(range(id))),
  ]);
  if (!session) return null;
  const files = [];
  chunks.forEach((chunk) => { (files[chunk.file] ||= []).push(chunk.blob); });
  const type = session.audioType || "audio/webm";
  return {
    session,
    parts: parts.sort((a, b) => a.index - b.index),
    audioFiles: files.filter(Boolean).map((blobs) => new Blob(blobs, { type })).filter((blob) => blob.size),
  };
}

export async function deleteSession(id) {
  try {
    const db = await open();
    const transaction = db.transaction(["sessions", "parts", "audio"], "readwrite");
    transaction.objectStore("sessions").delete(id);
    transaction.objectStore("parts").delete(range(id));
    transaction.objectStore("audio").delete(range(id));
    await done(transaction);
  } catch {}
}
