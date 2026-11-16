"use client";

import { useEffect, useRef } from "react";
import { transcribeLocally } from "../lib/local-transcription";
import { cloudTranscriptionStatus, decodeRecording, structureInCloud, transcribeInCloud } from "../lib/cloud-transcription";

// Transcribes one recording. When the server has a speech service configured it is used (much faster and
// more accurate, see lib/meeting-ai.js), and Claude fills the member cards; otherwise, or if the service
// fails, the on-device model is used. `names` are the meeting's team members ({ id, name, aliases }).
// onComplete(englishText, ai) — `ai` is { notes, cards } when Claude filled them, else null.
export default function LocalTranscriber({ audio, names, model, keyValue, projectId, selectedMemberId, onProgress, onComplete, onError }) {
  const callbacks = useRef({ onProgress, onComplete, onError });
  callbacks.current = { onProgress, onComplete, onError };
  const options = useRef({ names, model, keyValue, projectId, selectedMemberId });
  options.current = { names, model, keyValue, projectId, selectedMemberId };

  useEffect(() => {
    let cancelled = false;
    const progress = (message) => { if (!cancelled) callbacks.current.onProgress(message); };
    const { names: attendees = [], keyValue, projectId: project, selectedMemberId: selected } = options.current;
    const spellings = [...new Set(attendees.flatMap((attendee) => [attendee.name, ...(attendee.aliases || []).slice(0, 2)]))].filter(Boolean);

    const onDevice = () => transcribeLocally(audio, progress, options.current).then((text) => {
      if (cancelled) return;
      if (!text) callbacks.current.onError("No speech was detected. Try a clearer recording.");
      else callbacks.current.onComplete(text, null);
    });

    (async () => {
      const status = await cloudTranscriptionStatus(keyValue, project);
      if (cancelled) return;
      if (!status.speech) return onDevice();
      progress("Preparing audio…");
      const decoded = await decodeRecording(audio);
      let text;
      try {
        text = await transcribeInCloud(decoded, { key: keyValue, projectId: project, names: spellings, onProgress: progress });
      } catch {
        progress("Cloud transcription is unavailable right now; using on-device transcription…");
        return onDevice();
      }
      if (cancelled) return;
      if (!text.trim()) return callbacks.current.onError("No speech was detected. Check that the microphone captured the speakers and try again.");
      let ai = null;
      if (status.ai) {
        progress("Filling the shared notes and member cards…");
        try { ai = await structureInCloud(text, { key: keyValue, projectId: project, attendees, selectedMemberId: selected }); }
        catch { ai = null; }
      }
      if (!cancelled) callbacks.current.onComplete(text, ai);
    })().catch((error) => {
      if (!cancelled) callbacks.current.onError(error.message || "Transcription failed. Please try again.");
    });
    return () => { cancelled = true; };
  }, [audio]);

  return null;
}
