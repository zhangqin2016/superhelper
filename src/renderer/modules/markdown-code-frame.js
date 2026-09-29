/**
 * The frame around a fenced code block in rendered Markdown: an icon copy
 * button in a corner of its own, and a fade on the edge a long line continues
 * past. Split from markdown.js (an architecture hotspot).
 */

import { t } from "../i18n/index.js";
import { iconButton } from "./ui-icons.js";

export function wireCodeCopyButtons(element) {
  if (!element?.querySelectorAll) return;
  for (const pre of element.querySelectorAll("pre")) {
    if (pre.classList.contains("markdown-mermaid-source")) continue;
    if (pre.closest(".markdown-code-frame")) continue;
    const code = pre.querySelector("code");
    if (!code) continue;

    const frame = document.createElement("div");
    frame.className = "markdown-code-frame";
    const label = t("common.copy");
    const button = iconButton("markdown-code-copy", "copy", label);
    button.addEventListener("click", async () => {
      const text = code.textContent || "";
      const ok = await copyText(text);
      button.dataset.tip = ok ? t("common.copied") : t("common.copyFailed");
      button.classList.toggle("is-copied", ok);
      button.classList.toggle("is-error", !ok);
      setTimeout(() => {
        button.dataset.tip = label;
        button.classList.remove("is-copied", "is-error");
      }, 1400);
    });

    pre.parentNode?.insertBefore(frame, pre);
    frame.append(pre, button);
    watchCodeOverflow(frame, pre);
  }
}

// A long code line scrolls sideways, and the horizontal scrollbar is
// zero-height (it keeps streaming layout still), so the frame fades the edge
// that has more to see: `has-overflow-end` while text continues past the
// visible end, `has-overflow-start` once scrolled. One observer serves every
// block and lets go of blocks that left the page.
let codeOverflowObserver = null;
function syncCodeOverflow(frame, pre) {
  const max = pre.scrollWidth - pre.clientWidth;
  const at = Math.abs(pre.scrollLeft);
  frame.classList.toggle("has-overflow-start", max > 1 && at > 1);
  frame.classList.toggle("has-overflow-end", max > 1 && at < max - 1);
}
function watchCodeOverflow(frame, pre) {
  pre.addEventListener("scroll", () => syncCodeOverflow(frame, pre), { passive: true });
  if (typeof ResizeObserver === "function") {
    codeOverflowObserver ||= new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target;
        if (!target.isConnected) { codeOverflowObserver.unobserve(target); continue; }
        const owner = target.closest(".markdown-code-frame");
        if (owner) syncCodeOverflow(owner, target);
      }
    });
    codeOverflowObserver.observe(pre);
  }
  syncCodeOverflow(frame, pre);
}

async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}
