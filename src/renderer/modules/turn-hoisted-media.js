import { renderGeneratedMedia } from "./tool-payload-renderer.js";

// Must run after renderResultBlocks, which clears the artifacts host.
export function appendHoistedGeneratedMedia(article, blocks, {
  sessionId,
  renderMedia = renderGeneratedMedia,
} = {}) {
  const host = article.querySelector('[data-role="artifacts"]');
  if (!host) return;
  const prev = host.querySelector(":scope > .assistant-hoisted-media");
  if (prev) prev.remove();
  if (!blocks || !blocks.length) return;
  const wrap = document.createElement("div");
  wrap.className = "assistant-hoisted-media";
  try {
    renderMedia(wrap, blocks, { sessionId });
  } catch {
    return;
  }
  host.appendChild(wrap);
  host.hidden = false;
}
