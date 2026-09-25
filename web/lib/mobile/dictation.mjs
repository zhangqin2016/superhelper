// Dictation on the phone — the pure part, mirroring the desktop's
// (src/renderer/modules/voice-dictation.js): phases, the transcript as
// base + committed + interim, and what each ASR relay event does. The hook
// (components/mobile/use-voice-input.js) does the microphone and the network.
//
// What used to be wrong, and is held here: partials were dropped (nothing on
// screen while speaking), finals after "stop" were dropped (the last sentence
// lost), errors were dropped (silent failure), and audio went out as a dozen
// parallel requests a second that could arrive out of order.

export const PHASES = Object.freeze(["idle", "connecting", "listening", "finishing"]);

export function initialDictation(base = "") {
  return { phase: "idle", base: String(base || ""), committed: "", interim: "", speaking: false, error: "" };
}

export function transcript(state) {
  return `${state.base}${state.committed}${state.interim}`;
}

/** The speech recognised so far (without the text that was already there). */
export function spoken(state) {
  return `${state.committed}${state.interim}`;
}

export function begin(state, base) {
  return { ...initialDictation(base), phase: "connecting" };
}

/** The user tapped stop: capture ends, the relay is told to flush, results still arrive. */
export function finishing(state) {
  return state.phase === "idle" ? state : { ...state, phase: "finishing", speaking: false };
}

export function abandon() {
  return initialDictation("");
}

/**
 * One event from the ASR relay (see server asr-gateway: ready | partial | final
 * | vad | error | finished | closed). Returns the next state; `ended` is set
 * when nothing more will come.
 */
export function onAsrEvent(state, event) {
  const kind = String(event?.kind || "");
  if (state.phase === "idle") return { state };
  if (kind === "ready") return { state: state.phase === "connecting" ? { ...state, phase: "listening" } : state };
  if (kind === "partial") return { state: { ...state, interim: `${event.text || ""}${event.stash || ""}` } };
  if (kind === "final") return { state: { ...state, committed: `${state.committed}${event.transcript || ""}`, interim: "" } };
  if (kind === "vad") return { state: { ...state, speaking: Boolean(event.speaking) } };
  if (kind === "error") return { state: { ...state, phase: "idle", interim: "", speaking: false, error: String(event.code || "ASR_ERROR") }, ended: true };
  if (kind === "finished" || kind === "closed") return { state: { ...state, phase: "idle", interim: "", speaking: false }, ended: true };
  return { state };
}

/** Float32 audio at `inRate` → 16 kHz PCM16, averaging each window (a cheap low-pass, no aliasing). */
export function resampleTo16k(input, inRate) {
  const outRate = 16000;
  if (!input?.length || !(inRate > 0)) return new Int16Array(0);
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const from = Math.floor(i * ratio);
    const to = Math.min(input.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += input[j];
    const s = Math.max(-1, Math.min(1, sum / (to - from)));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function pcmToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Audio leaves in ORDER: chunks are gathered and sent as one request at a
 * time (the relay accepts `chunks`), the next only after the previous
 * returned. `post(chunks)` is the transport; `flushMs` the gathering window.
 */
export function createAudioQueue({ post, flushMs = 250, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
  let pending = [];
  let chain = Promise.resolve();
  let timer = null;
  let closed = false;
  const flush = () => {
    if (timer) clearTimeoutImpl(timer);
    timer = null;
    if (!pending.length) return chain;
    const chunks = pending;
    pending = [];
    chain = chain.then(() => post(chunks)).catch(() => {});
    return chain;
  };
  return {
    push(chunkBase64) {
      if (closed || !chunkBase64) return;
      pending.push(chunkBase64);
      if (!timer) timer = setTimeoutImpl(flush, flushMs);
    },
    /** Send what is gathered and resolve once everything sent so far has returned. */
    async drain() {
      closed = true;
      await flush();
      await chain;
    },
  };
}
