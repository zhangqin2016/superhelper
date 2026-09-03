/**
 * Inline code that may wrap.
 *
 * Inline `code` is nowrap so a flag like `--parallel` is never split into
 * `--` and `parallel` across lines. A single span longer than this many
 * characters would instead overflow the bubble, so it is marked `is-long` and
 * the stylesheet lets that one wrap anywhere. Blocks (`pre code`) are not
 * touched: they scroll.
 */
const LONG_INLINE_CODE = 40;

export function markLongInlineCode(element) {
  if (!element?.querySelectorAll) return;
  for (const code of element.querySelectorAll("code")) {
    if (code.closest("pre")) continue;
    if ((code.textContent || "").length > LONG_INLINE_CODE) code.classList.add("is-long");
  }
}
