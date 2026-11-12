"use client";

// On-device meeting transcription for Urdu / Urdu-English (mixed) speech, translated to English.
//
// Quality measures:
// - Whisper Medium on WebGPU when the device can run it, Whisper Small otherwise.
// - The team roster (names and their extra spellings) is given to Whisper as "previously heard text",
//   so it spells team names the way the team writes them instead of guessing.
// - The tail of the previous 30-second chunk is also given as context, so sentences that cross a chunk
//   boundary are translated consistently.
// - Name matching after transcription uses a phonetic key built for romanized Urdu names.

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/+esm";
export const TRANSCRIPTION_MODELS = {
  best: { id: "onnx-community/whisper-medium-ONNX", name: "Whisper Medium", download: "about 520 MB" },
  fast: { id: "onnx-community/whisper-small", name: "Whisper Small", download: "about 300 MB" },
};
const loadedModels = new Map();
let transcriptionQueue = Promise.resolve();
let activeJob = null;
const transcriptionJobs = new WeakMap();
const summaryStopWords = new Set("about after again against also among another any are because been before being between both but can could did does doing down during each few for from further had has have having here how into its itself just more most other our out over same should some such than that the their them then there these they this those through too under until very was were what when where which while who why will with would your".split(" "));

const progressText = (event) => {
  if (event.status === "progress" && event.total) {
    const percent = Math.round((event.loaded / event.total) * 100);
    return `Downloading speech model (first time only): ${percent}%`;
  }
  if (event.status === "done") return "Speech model ready";
  if (event.status === "initiate") return "Preparing speech model…";
  return "";
};

async function gpuSupportsF16() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    return !!adapter?.features?.has("shader-f16");
  } catch {
    return false;
  }
}

// The app always asks for the most accurate model for mixed Urdu-English speech (Whisper Medium);
// "fast" remains only as the automatic fallback when a device cannot load it.
export async function resolveModelChoice(choice = "best") {
  return choice === "fast" ? "fast" : "best";
}

async function createTranscriber(job, modelKey) {
  const { id } = TRANSCRIPTION_MODELS[modelKey];
  const { pipeline } = await import(/* webpackIgnore: true */ TRANSFORMERS_URL);
  const progress_callback = (event) => {
    const message = progressText(event);
    if (message) activeJob?.onProgress(message);
  };
  if (navigator.gpu) {
    try {
      job.onProgress("Starting speech recognition on the GPU…");
      const f16 = await gpuSupportsF16();
      return await pipeline("automatic-speech-recognition", id, { dtype: f16 && modelKey === "best" ? "q4f16" : "q4", device: "webgpu", progress_callback });
    } catch {
      job.onProgress("The GPU is unavailable; running speech recognition on the CPU (slower)…");
    }
  }
  return pipeline("automatic-speech-recognition", id, { dtype: "q4", device: "wasm", progress_callback });
}

function transcriberFor(job, modelKey) {
  if (!loadedModels.has(modelKey)) {
    const promise = createTranscriber(job, modelKey);
    promise.catch(() => loadedModels.delete(modelKey));
    loadedModels.set(modelKey, promise);
  }
  return loadedModels.get(modelKey);
}

async function decodeMono16k(blob) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const OfflineAudioContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineAudioContextClass) throw new Error("Audio decoding is not supported by this browser.");
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const outputLength = Math.ceil(decoded.duration * 16000);
    const offline = new OfflineAudioContextClass(1, outputLength, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const resampled = await offline.startRendering();
    const audio = resampled.getChannelData(0);
    let energy = 0;
    for (let index = 0; index < audio.length; index += 1) energy += audio[index] * audio[index];
    if (!audio.length || Math.sqrt(energy / audio.length) < 0.0005) {
      throw new Error("The recording is almost silent. Check the selected microphone and make sure it can hear the speakers before recording again.");
    }
    return normalizeLoudness(audio);
  } finally {
    await context.close();
  }
}

// Quiet laptop microphones lose words; bring the peak level up (never down) before recognition.
function normalizeLoudness(audio) {
  let peak = 0;
  for (let index = 0; index < audio.length; index += 1) peak = Math.max(peak, Math.abs(audio[index]));
  if (!peak || peak >= 0.5) return audio;
  const gain = Math.min(8, 0.9 / peak);
  const boosted = new Float32Array(audio.length);
  for (let index = 0; index < audio.length; index += 1) boosted[index] = audio[index] * gain;
  return boosted;
}

// The short "previously heard" text that teaches Whisper the team's names and their spelling.
export function buildNamePrompt(attendees = []) {
  const names = [...new Set(attendees.flatMap((attendee) => [attendee.name, ...(attendee.aliases || []).slice(0, 2)])
    .map((name) => String(name || "").trim()).filter(Boolean))].slice(0, 30);
  return names.length ? `Team meeting with ${names.join(", ")}.` : "";
}

/**
 * Transcribes and translates a recording to English. `options.names` are the attendees
 * ({ name, aliases }); the most accurate model is always used unless the device cannot load it.
 */
export async function transcribeLocally(blob, onProgress, options = {}) {
  const existing = transcriptionJobs.get(blob);
  if (existing) {
    existing.onProgress = onProgress;
    return existing.promise;
  }
  const job = { onProgress, promise: null };
  job.promise = transcriptionQueue.then(async () => {
    activeJob = job;
    try {
      job.onProgress("Preparing audio…");
      const audio = await decodeMono16k(blob);
      const duration = audio.length / 16000;
      let modelKey = await resolveModelChoice(options.model);
      const namePrompt = buildNamePrompt(options.names);
      let transcriber;
      try {
        transcriber = await transcriberFor(job, modelKey);
      } catch (error) {
        if (modelKey !== "best") throw error;
        // The large model may not fit this device; fall back to the smaller one.
        job.onProgress("This device is short on memory; switching to a lighter speech engine…");
        modelKey = "fast";
        transcriber = await transcriberFor(job, modelKey);
      }
      job.onProgress("Translating Urdu / English speech to English notes…");
      let transcript = await runTranscription(transcriber, audio, { namePrompt });
      if (!hasSuspiciousRepetition(transcript, duration) && !hasUnusableTranscript(transcript, duration)) return transcript;

      // Retry once more carefully: block repeated phrases and drop the prompt, which can occasionally
      // make Whisper echo the names instead of transcribing.
      job.onProgress("Speech recognition looks uncertain; retrying with a more careful decode…");
      transcript = await runTranscription(transcriber, audio, { namePrompt: "", careful: true });
      if (hasUnusableTranscript(transcript, duration) && modelKey === "fast" && navigator.gpu) {
        job.onProgress("Retrying for better accuracy…");
        transcript = await runTranscription(await transcriberFor(job, "best"), audio, { namePrompt, careful: true });
      }
      if (hasUnusableTranscript(transcript, duration)) {
        throw new Error("The speech model could not understand this clip clearly. Check that the microphone captured the speaker and try recording again.");
      }
      return transcript;
    } finally {
      activeJob = null;
    }
  }).catch((error) => {
    transcriptionJobs.delete(blob);
    throw error;
  });
  transcriptionQueue = job.promise.then(() => undefined, () => undefined);
  transcriptionJobs.set(blob, job);
  return job.promise;
}

function hasSuspiciousRepetition(transcript, durationSeconds) {
  const words = transcript.toLowerCase().match(/[a-z0-9']+/g) || [];
  if (words.length > 40 && words.length / Math.max(durationSeconds, 1) > 6) return true;
  for (let phraseLength = 2; phraseLength <= 8; phraseLength += 1) {
    for (let start = 0; start + phraseLength * 3 <= words.length; start += 1) {
      let repetitions = 1;
      while (
        start + phraseLength * (repetitions + 1) <= words.length &&
        words.slice(start, start + phraseLength).every((word, index) =>
          word === words[start + phraseLength * repetitions + index]
        )
      ) repetitions += 1;
      if (repetitions >= 3) return true;
    }
  }
  return false;
}

function hasUnusableTranscript(transcript, durationSeconds) {
  const normalized = transcript.toLowerCase();
  if (/\[(?:spanish|foreign language|music|inaudible)\]|speaking in (?:a )?foreign language|meeting key points\s*\(english\)|^team meeting with\b/i.test(normalized.trim())) return true;
  const words = normalized.match(/[a-z0-9']+/g) || [];
  return durationSeconds >= 6 && words.length < 3;
}

const tokenId = (tokenizer, token) => {
  const id = tokenizer.model?.tokens_to_ids?.get(token);
  if (id === undefined) throw new Error(`Speech model is missing the ${token} token.`);
  return id;
};

// Whisper decoder prefix: <|startofprev|> context… <|startoftranscript|><|ur|><|translate|><|notimestamps|>
function decoderPrefix(tokenizer, context) {
  const task = [
    tokenId(tokenizer, "<|startoftranscript|>"),
    tokenId(tokenizer, "<|ur|>"),
    tokenId(tokenizer, "<|translate|>"),
    tokenId(tokenizer, "<|notimestamps|>"),
  ];
  if (!context) return task;
  // Whisper allows at most half of its 448-token window as context; stay well inside it.
  const contextIds = tokenizer.encode(" " + context.trim(), { add_special_tokens: false }).slice(-150);
  return [tokenId(tokenizer, "<|startofprev|>"), ...contextIds, ...task];
}

// Strips a prompt the model echoed back (it sometimes repeats "Team meeting with …" on silence).
const removeEchoedPrompt = (text, namePrompt) => {
  let cleaned = text.trim();
  if (namePrompt && cleaned.toLowerCase().startsWith(namePrompt.toLowerCase())) cleaned = cleaned.slice(namePrompt.length).trim();
  return cleaned.replace(/^team meeting with [^.]*\.\s*/i, "").trim();
};

async function runTranscription(transcriber, audio, { namePrompt = "", careful = false } = {}) {
  const { processor, tokenizer, model } = transcriber;
  const sampleRate = 16000;
  const windowSize = sampleRate * 30;
  const overlapSize = sampleRate * 2;
  const chunkCount = Math.ceil(audio.length / (windowSize - overlapSize));
  const transcripts = [];
  for (let index = 0, offset = 0; offset < audio.length; index += 1, offset += windowSize - overlapSize) {
    const chunk = audio.subarray(offset, Math.min(offset + windowSize, audio.length));
    if (chunk.length < sampleRate * 0.5 && transcripts.length) break;
    const chunkStatus = chunkCount > 1 ? `Translating part ${index + 1} of ${chunkCount}` : "Translating audio";
    const startedAt = Date.now();
    activeJob?.onProgress(`${chunkStatus}…`);
    const progressTimer = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      activeJob?.onProgress(`${chunkStatus}… ${elapsedSeconds}s elapsed`);
    }, 5000);
    let text = "";
    try {
      const previousTail = careful ? "" : (transcripts.at(-1) || "").split(/\s+/).slice(-30).join(" ");
      const context = [namePrompt, previousTail].filter(Boolean).join(" ");
      const prefix = decoderPrefix(tokenizer, context);
      const { input_features } = await processor(chunk);
      const output = await model.generate({
        inputs: input_features,
        decoder_input_ids: prefix,
        max_new_tokens: Math.max(64, 440 - prefix.length),
        ...(careful ? { no_repeat_ngram_size: 4, repetition_penalty: 1.15 } : {}),
      });
      const sequence = Array.from((output.sequences || output).tolist()[0], Number).slice(prefix.length);
      text = removeEchoedPrompt(tokenizer.decode(sequence, { skip_special_tokens: true }), namePrompt);
    } finally {
      clearInterval(progressTimer);
    }
    if (text) transcripts.push(text);
  }
  return transcripts.reduce((combined, next) => {
    if (!combined) return next;
    const previousWords = [...combined.matchAll(/\S+/g)];
    const nextWords = [...next.matchAll(/\S+/g)];
    const wordKey = (word) => word.toLowerCase().replace(/[^a-z0-9]/g, "");
    const maxOverlap = Math.min(40, previousWords.length, nextWords.length);
    let overlap = 0;
    for (let count = maxOverlap; count > 0; count -= 1) {
      const previousTail = previousWords.slice(-count).map((match) => wordKey(match[0]));
      const nextHead = nextWords.slice(0, count).map((match) => wordKey(match[0]));
      if (previousTail.every((word, index) => word && word === nextHead[index])) {
        overlap = count;
        break;
      }
    }
    return overlap ? `${combined} ${next.slice(nextWords[overlap - 1].index + nextWords[overlap - 1][0].length).trim()}`.trim() : `${combined} ${next}`;
  }, "");
}

// ---------------------------------------------------------------------------------------------
// Sentence cleanup and classification
// ---------------------------------------------------------------------------------------------

// Sentences, with compound ones split where a new clause starts with its own subject:
// "I created the tables and I will add indexes tomorrow" -> two notes (one done, one next step).
const sentenceList = (transcript) => (String(transcript || "").match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/gm) || [])
  .flatMap((text) => text.split(/\s*,?\s+\b(?:and|but|then|so)\s+(?=(?:i|we|he|she|they)(?:'ll|'m|'ve)?\s)/i))
  .map((text) => text.trim())
  .filter(Boolean);

// Spoken fillers that carry no meaning in written notes.
const FILLER = /^(?:(?:ok(?:ay)?|so|um+|uh+|hmm+|yes|yeah|yup|no|right|alright|well|basically|actually|see|look|listen|and|then|now|sir|ji|haan|acha|achha|theek hai|fine|good|great|thank you|thanks)\b[\s,.:;-]*)+/i;
const cleanSentence = (sentence) => {
  const cleaned = sentence.replace(FILLER, "").replace(/\b(you know|i mean|kind of|sort of)\b,?\s*/gi, "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : "";
};
// Meeting housekeeping ("let's start", "can you hear me") is not a note.
const HOUSEKEEPING = /^(?:let'?s (?:start|begin|get started|wrap up|end)|can (?:you|everyone) (?:hear|see) (?:me|my screen)|(?:is )?everyone (?:here|joined)|one (?:second|minute)|i(?:'m| am) sharing my screen)\b/i;
const meaningful = (sentence) => (sentence.match(/[A-Za-z][A-Za-z'-]+/g) || []).length >= 4 && !HOUSEKEEPING.test(sentence);

const CUES = {
  done: /\b(completed?|finished|done|fixed|resolved|deployed|released|merged|delivered|submitted|closed|implemented|integrated|tested|shipped|uploaded|set ?up|created|added|sent)\b/i,
  progress: /\b(working on|in progress|still (?:working|doing)|currently|ongoing|halfway|almost|nearly|started|starting|continuing|progress)\b/i,
  // Always a blocker, even next to "done" words ("I finished the UI but I'm stuck on the API").
  blocker: /\b(block(?:ed|er|ing)?|stuck|waiting (?:for|on)|depend(?:s|ent|ency)|can(?:no|')t|unable|not working|delay(?:ed)?)\b/i,
  // A blocker only when nothing says it was solved ("I fixed the upload bug" is progress).
  softBlocker: /\b(issue|problem|bug|error|risk|concern|challenge)s?\b/i,
  solved: /\b(fixed|resolved|solved|sorted|closed|handled)\b/i,
  next: /\b(will|going to|gonna|plan(?:ning)? to|next|tomorrow|this week|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|end of)|need(?:s)? to|have to|has to|should|must|deadline|due|target|aim to|try to|start(?:ing)? on)\b/i,
  decision: /\b(decid(?:e|ed|ing)|agreed?|final(?:ise|ize|ized|ised)?|approved?|we will go with|let'?s go with|confirmed?)\b/i,
};
const classify = (sentence) => {
  if (CUES.decision.test(sentence)) return "decision";
  if (CUES.blocker.test(sentence)) return "blocker";
  if (CUES.softBlocker.test(sentence) && !CUES.solved.test(sentence)) return "blocker";
  if (CUES.next.test(sentence) && !CUES.done.test(sentence.replace(/\b(will|going to)\b.*$/i, ""))) return "next";
  if (CUES.done.test(sentence)) return "done";
  if (CUES.progress.test(sentence)) return "progress";
  return "other";
};

// "I will finish the login API by Friday" -> "Finish the login API by Friday"
const toActionItem = (sentence) => {
  const action = cleanSentence(sentence)
    .replace(/^(?:and\s+)?(?:i|we|he|she|they|you)\s+(?:will|'ll|shall|am going to|are going to|is going to|'m going to|'re going to|plan to|need to|have to|has to|should|must|would|can)\s+(?:also\s+|then\s+)?/i, "")
    .replace(/^(?:i'll|we'll|he'll|she'll|they'll|you'll)\s+/i, "")
    .replace(/^(?:next|tomorrow|today)[,\s]+(?:i|we)\s+(?:will|'ll)\s+/i, "")
    .replace(/[.!?]+$/, "");
  return action ? action[0].toUpperCase() + action.slice(1) : "";
};

function rankSentences(sentences) {
  const termsBySentence = sentences.map((sentence) =>
    (sentence.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((word) => !summaryStopWords.has(word))
  );
  const frequencies = new Map();
  termsBySentence.flat().forEach((word) => frequencies.set(word, (frequencies.get(word) || 0) + 1));
  return sentences.map((sentence, index) => {
    const terms = termsBySentence[index];
    const termScore = terms.reduce((score, word) => score + Math.log1p(frequencies.get(word)), 0);
    const lengthPenalty = Math.sqrt(Math.max(terms.length, 1));
    const kind = classify(sentence);
    const cueBonus = kind === "other" ? 0 : kind === "decision" || kind === "blocker" ? 2.5 : 2;
    return { sentence, index, kind, score: termScore / lengthPenalty + cueBonus };
  });
}

// Drops sentences that say nearly the same thing as one already kept.
const dedupe = (sentences) => {
  const kept = [];
  const words = (text) => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  sentences.forEach((sentence) => {
    const current = words(sentence);
    const duplicate = kept.some((other) => {
      const previous = words(other);
      const shared = [...current].filter((word) => previous.has(word)).length;
      return shared / Math.max(1, Math.min(current.size, previous.size)) >= 0.8;
    });
    if (!duplicate) kept.push(sentence);
  });
  return kept;
};

// ---------------------------------------------------------------------------------------------
// Team-name recognition (romanized Urdu names)
// ---------------------------------------------------------------------------------------------

const normalizeWords = (text) => String(text || "").toLowerCase()
  .normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .split(/\s+/)
  .filter(Boolean);

// Built-in spellings for this team; project admins can add more per member in the app.
const TEAM_NAME_ALIASES = {
  sami: ["sami", "sammy", "samy", "samee"],
  irfan: ["irfan", "irfaan", "erfan"],
  zunaira: ["zunaira", "zunairah", "zunera", "zunariya"],
  mashal: ["mashal", "mashaal", "masal"],
  haider: ["haider", "haidar", "hyder"],
  umais: ["umais", "umays", "humais", "omais"],
  adil: ["adil", "adeel", "aadil"],
  mashhood: ["mashhood", "mashud", "mashood"],
};
const NOT_NAMES = new Set("the and you your our team task tasks meeting today tomorrow thank thanks please okay sir madam brother next over what about update work".split(" "));

// Phonetic spellings of romanized South-Asian names. `phoneticKey` keeps the vowels (Adeel/Adil,
// Mashud/Mashhood, Kasim/Qasim, Omais/Umais match); `consonantKey` keeps only the first letter and the
// consonants (Zunera/Zunaira, Hyder/Haider match) and is used only for capitalized words.
export function phoneticKey(word) {
  let w = String(word || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  w = w.replace(/ph/g, "f").replace(/q/g, "k").replace(/ck/g, "k").replace(/kh/g, "k").replace(/gh/g, "g")
    .replace(/w/g, "v").replace(/z/g, "s").replace(/x/g, "ks").replace(/th/g, "t").replace(/dh/g, "d")
    .replace(/ee|ea|ie|ei|ey|iy/g, "i").replace(/oo|ou|uu/g, "u").replace(/aa/g, "a")
    .replace(/o/g, "u").replace(/(?<=[^aeiu])y(?=[^aeiu]|$)/g, "ai").replace(/y/g, "i");
  w = w.replace(/([aeiu])h(?=[^aeiu]|$)/g, "$1").replace(/(.)\1+/g, "$1");
  return w;
}
const consonantKey = (word) => {
  const key = phoneticKey(word).replace(/ai|ay|ae/g, "e");
  return key ? key[0] + key.slice(1).replace(/[aeiu]/g, "") : "";
};

function attendeeAliases(attendee) {
  const nameParts = normalizeWords(attendee.name);
  const firstName = nameParts[0] || "";
  const builtIn = TEAM_NAME_ALIASES[firstName] || [];
  const custom = (attendee.aliases || []).flatMap(normalizeWords);
  return [...new Set([...nameParts, ...builtIn.flatMap(normalizeWords), ...custom].filter((name) => name.length >= 3 && !NOT_NAMES.has(name)))];
}

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[right.length];
}

// How well a heard word matches one spelling of a name. Exact spellings (including the extra
// spellings an admin entered) always count. Approximate matches count only for words written like a
// name (capitalized), because Whisper capitalizes proper names; this keeps ordinary words such as
// "module", "pushed" or "header" from being mistaken for team members.
function nameTokenScore(word, alias, capitalized = true) {
  if (!word || NOT_NAMES.has(word)) return 0;
  if (word === alias) return 1;
  if (word === alias + "s") return 0.95;
  if (!capitalized) return 0;
  if (alias.length >= 3 && phoneticKey(word) === phoneticKey(alias)) return 0.9;
  if (Math.min(word.length, alias.length) >= 4 && word[0] === alias[0] && editDistance(word, alias) <= 1) return 0.84;
  const wordKey = consonantKey(word), aliasKey = consonantKey(alias);
  if (aliasKey.length >= 3 && wordKey === aliasKey && Math.abs(word.length - alias.length) <= 2) return 0.78;
  return 0;
}

// Words of a sentence with whether each one is written like a name. A capital at the very start of a
// sentence does not count, unless the word is followed by a comma ("Adeel, tell me…").
function sentenceTokens(sentence) {
  const text = String(sentence || "");
  return [...text.matchAll(/[A-Za-z0-9]+/g)].map((match, position) => {
    const following = text.slice(match.index + match[0].length);
    const sentenceStart = position === 0 || /[.!?]\s*$/.test(text.slice(0, match.index));
    return {
      word: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
      capitalized: /^[A-Z]/.test(match[0]) && (!sentenceStart || /^\s*[,?!:]/.test(following)),
    };
  });
}

// Best attendee for one word, or null when nobody (or more than one person) fits clearly.
function bestAttendeeFor(word, capitalized, attendees) {
  const candidates = attendees.map((attendee) => ({
    attendee,
    score: Math.max(0, ...attendeeAliases(attendee).map((alias) => nameTokenScore(word, alias, capitalized))),
  })).filter((candidate) => candidate.score >= 0.75).sort((a, b) => b.score - a.score);
  if (!candidates.length || (candidates.length > 1 && candidates[0].score - candidates[1].score < 0.1)) return null;
  return candidates[0];
}

// Phrases that hand the floor to someone (in the English translation of Urdu / English speech).
const HANDOFF_AFTER_NAME = /^(?:,|\s)*(?:(?:it'?s |it is )?your turn|you(?:'re| are) next|go ahead|please (?:go|start|share|speak|tell|update|continue)|(?:tell|share|give|update)\b|what (?:about you|is your|did you|have you|are you)|how (?:is|are|far)|(?:your|any) (?:update|progress|status|tasks?|work)|what'?s (?:your|the) (?:update|status|progress)|start|continue|you\b|\?)/i;
const HANDOFF_BEFORE_NAME = /(?:over to|next (?:is|up is|one is)?|now|let'?s (?:hear from|go to|move to)|what about|how about|turn (?:of|for)|calling|ask(?:ing)?)\s*,?\s*$/i;
const SELF_INTRO_BEFORE_NAME = /(?:this is|i am|i'm|my name is|it'?s me,?|me,)\s*$/i;
const THANKS_BEFORE_NAME = /(?:thank you|thanks|thank u|shukriya|great work|good job|well done),?\s*$/i;

// Decides whether a sentence hands over to someone, closes someone's turn, or just mentions a name.
function detectTurn(sentence, attendees) {
  const mentions = sentenceTokens(sentence)
    .map((token) => ({ token, match: bestAttendeeFor(token.word, token.capitalized, attendees) }))
    .filter((item) => item.match);
  if (!mentions.length) return null;
  const lower = String(sentence).toLowerCase();
  for (const { token, match } of mentions) {
    const before = lower.slice(0, token.start);
    // "Adil sahab, …", "Mashhood bhai what did you do", "Zunaira ji, update?"
    const after = lower.slice(token.end).replace(/^\s*(?:sahab|sahib|saab|bhai|bhaiya|bhaijan|ji|jee|sir|madam|baji|api|bro)\b/, "");
    const rest = String(sentence).slice(token.end);
    if (SELF_INTRO_BEFORE_NAME.test(before)) return { type: "self", attendee: match.attendee };
    if (THANKS_BEFORE_NAME.test(before)) return { type: "thanks", attendee: match.attendee };
    if (HANDOFF_BEFORE_NAME.test(before)) return { type: "handoff", attendee: match.attendee, after: rest };
    // Addressing someone: their name opens the sentence ("Ali, tell me…") or is followed by a cue.
    const opensSentence = !/[a-z0-9]/.test(before.replace(/\b(?:ok(?:ay)?|so|now|and|yes|right|acha|achha|ji)\b/g, ""));
    if ((opensSentence && /^\s*[,?!:]/.test(after)) || HANDOFF_AFTER_NAME.test(after)) {
      return { type: "handoff", attendee: match.attendee, after: rest };
    }
  }
  return { type: "mention", attendee: mentions[0].match.attendee };
}

// Rewrites mis-heard or alternative spellings of team names to the member's own spelling
// ("Mashud" -> "Mashhood", "Adeel" -> "Adil").
export function correctTurnNames(transcript, attendees) {
  if (!attendees?.length) return transcript;
  return String(transcript || "").replace(/[^.!?\n]+[.!?]*/g, (sentence) => {
    const tokens = sentenceTokens(sentence);
    let result = "", cursor = 0;
    tokens.forEach((token) => {
      if (token.word.length < 3) return;
      const match = bestAttendeeFor(token.word, token.capitalized, attendees);
      if (!match) return;
      const parts = match.attendee.name.split(/\s+/).filter(Boolean);
      if (parts.some((part) => part.toLowerCase() === token.word)) return;
      const proper = parts.find((part) => nameTokenScore(token.word, part.toLowerCase(), true) >= 0.75) || parts[0];
      result += sentence.slice(cursor, token.start) + proper;
      cursor = token.end;
    });
    return result + sentence.slice(cursor);
  });
}

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------

export function generateEnglishKeyPoints(transcript) {
  const sentences = sentenceList(transcript).map(cleanSentence).filter(meaningful);
  if (!sentences.length) return "";
  const ranked = rankSentences(dedupe(sentences));
  const pick = (kind, limit) => ranked.filter((item) => item.kind === kind).sort((a, b) => b.score - a.score).slice(0, limit).sort((a, b) => a.index - b.index);
  const sections = [
    ["Decisions", pick("decision", 4).map((item) => item.sentence)],
    ["Progress", [...pick("done", 4), ...pick("progress", 3)].sort((a, b) => a.index - b.index).map((item) => item.sentence)],
    ["Blockers / risks", pick("blocker", 4).map((item) => item.sentence)],
    ["Next steps", pick("next", 5).map((item) => toActionItem(item.sentence)).filter(Boolean)],
  ].filter(([, items]) => items.length);
  if (!sections.length) {
    const top = ranked.sort((a, b) => b.score - a.score).slice(0, 5).sort((a, b) => a.index - b.index);
    return `Meeting key points (English)\n${top.map(({ sentence }) => `- ${sentence}`).join("\n")}`;
  }
  return `Meeting key points (English)\n${sections.map(([title, items]) => `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`).join("\n")}`;
}

/**
 * Splits a translated transcript into per-member cards. A member's turn starts when they are
 * addressed ("Ali, tell me about your tasks", "over to Ali", "Ali, your turn") or introduce
 * themselves ("this is Ali"), and ends when someone else is addressed or they are thanked.
 * A name merely mentioned in passing does not change who is speaking. Sentences before anyone is
 * addressed go to the card selected before recording, if any.
 */
export function generateMeetingParticipantCards(transcript, attendees, selectedMemberId = "") {
  const sentences = sentenceList(transcript);
  const sections = new Map();
  const selectedAttendee = attendees.find((attendee) => attendee.id === selectedMemberId) || null;
  let current = null;
  const add = (attendee, sentence) => {
    const cleaned = cleanSentence(sentence);
    if (!attendee || !meaningful(cleaned)) return;
    if (!sections.has(attendee.id)) sections.set(attendee.id, { attendee, sentences: [] });
    sections.get(attendee.id).sentences.push(cleaned);
  };
  sentences.forEach((sentence) => {
    const turn = detectTurn(sentence, attendees);
    if (turn?.type === "handoff") {
      current = turn.attendee;
      // "Ali, tell me about your tasks" is the question, not Ali's update; keep only real content.
      const rest = String(turn.after || "").replace(/^[\s,:;.?!-]+/, "").replace(/^(?:sahab|sahib|saab|bhai|bhaiya|bhaijan|ji|jee|sir|madam|baji|api|bro)\b[\s,]*/i, "");
      // A question put to the member ("what did you do this week?") is not their update.
      if (!/\?\s*$/.test(rest) && !/^(?:(?:please\s+)?(?:tell|share|give|update)\s+(?:me|us)?\s*(?:about\s+)?(?:your\s+)?|what (?:about you|is your|did you|have you)|your turn|go ahead|you(?:'re| are) next)/i.test(rest)) add(current, rest);
      if (!sections.has(current.id)) sections.set(current.id, { attendee: current, sentences: [] });
      return;
    }
    if (turn?.type === "self") {
      current = turn.attendee;
      add(current, sentence);
      return;
    }
    if (turn?.type === "thanks") {
      if (current?.id === turn.attendee.id) current = null;
      return;
    }
    add(current || selectedAttendee, sentence);
  });
  return [...sections.values()].map(({ attendee, sentences: memberSentences }) => {
    const unique = dedupe(memberSentences);
    const ranked = rankSentences(unique);
    const updates = ranked.filter((item) => item.kind !== "next")
      .sort((a, b) => b.score - a.score).slice(0, 6).sort((a, b) => a.index - b.index)
      .map(({ sentence, kind }) => kind === "blocker" && !/^blocker/i.test(sentence) ? `Blocker: ${sentence}` : sentence);
    const tasks = [...new Set(ranked.filter((item) => item.kind === "next").map((item) => toActionItem(item.sentence)).filter(Boolean))].slice(0, 10);
    return { memberId: attendee.id, name: attendee.name, points: updates, tasks };
  }).filter((card) => card.points.length || card.tasks.length);
}
