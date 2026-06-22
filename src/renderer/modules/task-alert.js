// Task-completion alerts (sound + OS notification), gated on ATTENTION:
// we only alert when the user can't already see the result — i.e. the window is
// unfocused, or a BACKGROUND session (not the one on screen) finished. Staring at
// the active session as it finishes raises nothing (that would just be noise).
// Quick replies (< MIN_ALERT_MS) are skipped too; failures always alert when
// unattended. The chime is synthesized (WebAudio) so there's no bundled asset.
import { t } from "../i18n/index.js";

const MIN_ALERT_MS = 8000; // a sub-8s reply doesn't deserve a ding
const DEBOUNCE_MS = 1500;

let prefs = { sound: true, notify: true };
let lastAlertAt = 0;
let audioCtx = null;

(async () => {
  try {
    const r = await window.assistantClient?.getNotificationSettings?.();
    if (r?.ok) prefs = { sound: r.sound !== false, notify: r.notify !== false };
  } catch {
    /* keep defaults */
  }
})();

export function getNotificationPrefs() {
  return { ...prefs };
}

export async function setNotificationPrefs(patch) {
  try {
    const r = await window.assistantClient?.setNotificationSettings?.(patch);
    if (r?.ok) prefs = { sound: r.sound !== false, notify: r.notify !== false };
  } catch {
    Object.assign(prefs, patch);
  }
  return { ...prefs };
}

function chime(ok) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const now = audioCtx.currentTime;
    // success: two rising notes; failure: two falling notes (distinct, not alarming).
    const notes = ok ? [659.25, 880] : [466.16, 349.23];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.13;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    });
  } catch {
    /* audio is best-effort */
  }
}

/**
 * @param {{ sessionId:string, ok:boolean, durationMs:number, activeSessionId:string, snippet?:string }} info
 */
export function alertTaskDone(info = {}) {
  // No-op outside a browser/renderer context (e.g. node unit tests that drive the
  // runtime store) — there's no window/document to alert through.
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const { sessionId, ok, durationMs = 0, activeSessionId, snippet } = info;
  // Attention gate: if the window is focused AND this is the session on screen,
  // the user is already watching — say nothing.
  const watching = document.hasFocus() && sessionId && sessionId === activeSessionId;
  if (watching) return;
  // Trivial quick success → skip; failures are always worth surfacing.
  if (ok && Number(durationMs) < MIN_ALERT_MS) return;

  const now = Date.now();
  if (now - lastAlertAt < DEBOUNCE_MS) return;
  lastAlertAt = now;

  if (prefs.sound) chime(ok !== false);
  if (prefs.notify) {
    const title = ok === false ? t("notify.taskFailed") : t("notify.taskDone");
    const body = String(snippet || "").replace(/\s+/g, " ").trim().slice(0, 160);
    try {
      window.assistantClient?.notifyTaskDone?.({ sessionId, ok, title, body });
    } catch {
      /* notification is best-effort */
    }
  }
}
