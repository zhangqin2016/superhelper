import { t } from "../i18n/index.js";
import { $ } from "./dom.js";
import { showToast } from "./toast.js";

// Realtime dictation into the composer. The mic button drives a small state
// machine (idle → connecting → listening → finishing → idle); audio is
// captured at 16 kHz mono via an AudioWorklet, batched into ~100ms PCM16
// frames, and streamed to the main process which owns the authenticated ASR
// socket. Partial transcripts render into the prompt input live; server VAD
// finalizes each utterance.
//
// 丝滑要点:
// - chunks captured BEFORE the ASR session is ready are buffered locally and
//   flushed on ready — the first syllable is never lost;
// - the input keeps working as a normal textarea: manual edits mid-dictation
//   rebase the dictation tail instead of being clobbered;
// - sending the message or pressing Esc ends dictation cleanly.

const CHUNK_SAMPLES = 1600; // 100ms @ 16kHz
const PRE_READY_BUFFER_LIMIT = 64; // ~6.4s of audio max while connecting

const WORKLET_SOURCE = `
class LilyPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("lily-pcm-capture", LilyPcmCapture);
`;

const state = {
  phase: "idle", // idle | connecting | listening | finishing
  ready: false,
  stream: null,
  audioContext: null,
  workletNode: null,
  pending: [],
  sampleBuffer: new Int16Array(0),
  base: "",
  committed: "",
  interim: "",
  lastRendered: null,
  button: null,
  input: null,
};

function floatTo16(chunk) {
  const out = new Int16Array(chunk.length);
  for (let i = 0; i < chunk.length; i += 1) {
    const v = Math.max(-1, Math.min(1, chunk[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

function int16ToBase64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function appendSamples(chunk) {
  const int16 = floatTo16(chunk);
  const merged = new Int16Array(state.sampleBuffer.length + int16.length);
  merged.set(state.sampleBuffer, 0);
  merged.set(int16, state.sampleBuffer.length);
  state.sampleBuffer = merged;
  let level = 0;
  for (let i = 0; i < chunk.length; i += 1) level += chunk[i] * chunk[i];
  updateLevel(Math.sqrt(level / chunk.length));
  while (state.sampleBuffer.length >= CHUNK_SAMPLES) {
    const frame = state.sampleBuffer.subarray(0, CHUNK_SAMPLES);
    const encoded = int16ToBase64(new Int16Array(frame));
    state.sampleBuffer = state.sampleBuffer.slice(CHUNK_SAMPLES);
    if (state.ready) {
      window.assistantClient.voiceDictationAudio(encoded);
    } else if (state.pending.length < PRE_READY_BUFFER_LIMIT) {
      state.pending.push(encoded);
    }
  }
}

function updateLevel(rms) {
  if (!state.button) return;
  const level = Math.max(0, Math.min(1, rms * 4));
  state.button.style.setProperty("--voice-level", level.toFixed(3));
}

function renderTranscript() {
  if (!state.input) return;
  const value = state.base + state.committed + state.interim;
  state.lastRendered = value;
  state.input.value = value;
  state.input.dispatchEvent(new Event("input", { bubbles: true }));
  state.input.scrollTop = state.input.scrollHeight;
}

/** Manual edits mid-dictation win: fold everything rendered so far into the
 *  new base and keep dictating from there. */
function handleExternalInput() {
  if (state.phase === "idle") return;
  if (state.lastRendered !== null && state.input.value !== state.lastRendered) {
    state.base = state.input.value;
    state.committed = "";
    state.interim = "";
    state.lastRendered = null;
  }
}

function setPhase(phase) {
  state.phase = phase;
  const btn = state.button;
  if (!btn) return;
  btn.classList.toggle("is-connecting", phase === "connecting");
  btn.classList.toggle("is-listening", phase === "listening");
  btn.classList.toggle("is-finishing", phase === "finishing");
  if (phase !== "listening") btn.classList.remove("is-speaking");
  const title = phase === "idle" ? t("composer.voice") : t("composer.voiceStop");
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.setAttribute("aria-pressed", phase === "idle" ? "false" : "true");
  if (phase !== "listening") updateLevel(0);
}

async function startCapture() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const audioContext = new AudioContext({ sampleRate: 16000 });
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
  try {
    await audioContext.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }
  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, "lily-pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  worklet.port.onmessage = (message) => {
    if (state.phase === "listening" || state.phase === "connecting") {
      appendSamples(message.data);
    }
  };
  source.connect(worklet);
  state.stream = stream;
  state.audioContext = audioContext;
  state.workletNode = worklet;
}

function stopCapture() {
  try {
    state.workletNode?.port?.close?.();
    state.workletNode?.disconnect?.();
  } catch { /* best effort */ }
  try {
    state.stream?.getTracks?.().forEach((track) => track.stop());
  } catch { /* best effort */ }
  try {
    void state.audioContext?.close?.();
  } catch { /* best effort */ }
  state.stream = null;
  state.audioContext = null;
  state.workletNode = null;
  state.pending = [];
  state.sampleBuffer = new Int16Array(0);
}

async function startDictation() {
  if (state.phase !== "idle") return;
  state.input = $("promptInput");
  if (!state.input) return;
  setPhase("connecting");
  state.ready = false;
  state.base = state.input.value || "";
  state.committed = "";
  state.interim = "";
  state.lastRendered = null;
  try {
    await startCapture();
  } catch {
    setPhase("idle");
    showToast(t("toast.voiceMicDenied"), "warning");
    return;
  }
  let result;
  try {
    result = await window.assistantClient.voiceDictationStart();
  } catch (err) {
    result = { ok: false, error: err?.message || "ASR_CONNECT_FAILED" };
  }
  if (!result?.ok) {
    stopCapture();
    setPhase("idle");
    const key = result?.error === "NO_DASHSCOPE_KEY"
      ? "toast.voiceNoKey"
      : result?.error === "MIC_PERMISSION_DENIED"
        ? "toast.voiceMicDenied"
        : "toast.voiceError";
    showToast(t(key), result?.error === "NO_DASHSCOPE_KEY" ? "info" : "warning");
    return;
  }
  // The service answers `ready` via the event channel once the ASR session is
  // configured; buffered chunks flush there.
}

function finishDictation({ discard = false } = {}) {
  if (state.phase === "idle") return;
  stopCapture();
  if (discard) {
    state.base = "";
    state.committed = "";
    state.interim = "";
    state.lastRendered = null;
    setPhase("idle");
    void window.assistantClient.voiceDictationStop();
    return;
  }
  setPhase("finishing");
  void window.assistantClient.voiceDictationStop();
}

function handleVoiceEvent(event) {
  const kind = event?.kind || "";
  if (kind === "ready") {
    state.ready = true;
    if (state.phase === "connecting") setPhase("listening");
    for (const chunk of state.pending.splice(0)) {
      window.assistantClient.voiceDictationAudio(chunk);
    }
    return;
  }
  if (state.phase === "idle") return;
  if (kind === "partial") {
    state.interim = `${event.text || ""}${event.stash || ""}`;
    renderTranscript();
  } else if (kind === "final") {
    state.committed += String(event.transcript || "");
    state.interim = "";
    renderTranscript();
  } else if (kind === "vad" && state.button) {
    state.button.classList.toggle("is-speaking", Boolean(event.speaking));
  } else if (kind === "error") {
    stopCapture();
    setPhase("idle");
    showToast(t("toast.voiceError"), "warning");
  } else if (kind === "closed" || kind === "finished") {
    stopCapture();
    state.interim = "";
    renderTranscript();
    state.lastRendered = null;
    setPhase("idle");
  }
}

function buildMicButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "voiceDictationBtn";
  btn.className = "composer-icon-btn composer-mic-btn";
  btn.title = t("composer.voice");
  btn.setAttribute("aria-label", t("composer.voice"));
  btn.setAttribute("aria-pressed", "false");
  btn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3"/>
      <path d="M5 10v1a7 7 0 0 0 14 0v-1"/>
      <line x1="12" y1="18" x2="12" y2="22"/>
    </svg>
  `;
  btn.addEventListener("click", () => {
    if (state.phase === "idle") void startDictation();
    else finishDictation();
  });
  return btn;
}

export function initVoiceDictation() {
  if (!window.assistantClient?.voiceDictationStart) return;
  const attach = $("attachBtn");
  const input = $("promptInput");
  if (!attach || !input) return;
  state.button = buildMicButton();
  attach.insertAdjacentElement("afterend", state.button);
  window.assistantClient.onVoiceDictationEvent(handleVoiceEvent);
  input.addEventListener("input", handleExternalInput);
  // Sending the message ends dictation and hands the text over untouched.
  $("composer")?.addEventListener("submit", () => finishDictation({ discard: true }), true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.phase !== "idle") {
      event.stopPropagation();
      finishDictation();
    }
  }, true);
}
