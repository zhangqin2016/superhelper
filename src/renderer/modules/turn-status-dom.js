export function applyStatusDisplay(statusEl, text, { sealed = false, live = false } = {}) {
  if (!statusEl) return;
  statusEl.hidden = !text;
  if (!text) return;
  statusEl.classList.toggle("is-sealed-duration", sealed && live === false);
  statusEl.classList.toggle("is-live-status", live);
  // Keep stale inline styles from older sessions/builds from reintroducing
  // per-tick layout work. The stable live/sealed look now lives in CSS.
  const liveFlag = live ? "1" : "0";
  if (statusEl.dataset.liveStyle !== liveFlag) {
    statusEl.dataset.liveStyle = liveFlag;
    statusEl.style.fontSize = "";
    statusEl.style.fontWeight = "";
    statusEl.style.lineHeight = "";
  }
  if (statusEl.dataset.lastText === text) return;
  statusEl.textContent = text;
  statusEl.dataset.lastText = text;
}
