"use client";

import { useEffect, useRef } from "react";
import { transcribeLocally } from "../lib/local-transcription";

// `names` are the meeting's team members ({ name, aliases }) so the model spells them correctly;
// the most accurate speech model is always used (see lib/local-transcription.js).
export default function LocalTranscriber({ audio, names, model, onProgress, onComplete, onError }) {
  const callbacks = useRef({ onProgress, onComplete, onError });
  callbacks.current = { onProgress, onComplete, onError };
  const options = useRef({ names, model });
  options.current = { names, model };

  useEffect(() => {
    let cancelled = false;
    transcribeLocally(audio, (message) => {
      if (!cancelled) callbacks.current.onProgress(message);
    }, options.current).then((text) => {
      if (cancelled) return;
      if (!text) callbacks.current.onError("No speech was detected. Try a clearer recording.");
      else callbacks.current.onComplete(text);
    }).catch((error) => {
      if (!cancelled) callbacks.current.onError(error.message || "On-device transcription failed. Check your internet connection for the initial model download and try again.");
    });
    return () => { cancelled = true; };
  }, [audio]);

  return null;
}
