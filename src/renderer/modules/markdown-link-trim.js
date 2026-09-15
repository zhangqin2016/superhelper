/**
 * Trim CJK punctuation that a bare URL swallowed.
 *
 * GFM's autolink literal stops at whitespace and trims a short list of ASCII
 * trailing punctuation. Full-width punctuation is not on that list, so
 * "服务跑在 http://127.0.0.1:5173，88 个工具" linked
 * `http://127.0.0.1:5173，88` — an address that does not even parse, so
 * clicking it did nothing useful (2026-09-15 report). Cut the link at the first
 * full-width / ideographic punctuation character and put the remainder back as
 * text, so the visible address is the one that gets opened.
 *
 * Only BARE autolinks are touched (href === text): an explicit
 * [label](url) link is the author's stated intent.
 */

// Ideographic + full-width punctuation (U+3000-303F, U+FF00-FF65 minus the
// characters that are legal in a URL), plus the ideographic space.
const CJK_PUNCTUATION = /[　-〿！-＋，-／：-＠［-｀｛-･]/;

/** @returns {string} the URL up to the first full-width punctuation character. */
export function trimTrailingCjkPunctuation(url) {
  const text = String(url || "");
  const match = CJK_PUNCTUATION.exec(text);
  if (!match || match.index === 0) return text;
  return text.slice(0, match.index);
}

function isBareAutolink(anchor) {
  const href = anchor.getAttribute("href") || "";
  const text = anchor.textContent || "";
  if (!href || !text) return false;
  // marked percent-encodes the href, so compare on the decoded form too.
  if (href === text) return true;
  try {
    return decodeURI(href) === text;
  } catch {
    return false;
  }
}

export function trimAutolinkedPunctuation(element) {
  if (!element?.querySelectorAll) return;
  for (const anchor of [...element.querySelectorAll("a[href]")]) {
    if (anchor.classList?.contains("markdown-local-file-link")) continue;
    if (!isBareAutolink(anchor)) continue;
    const text = anchor.textContent || "";
    const kept = trimTrailingCjkPunctuation(text);
    if (kept === text || !kept) continue;
    anchor.textContent = kept;
    anchor.setAttribute("href", kept);
    const remainder = text.slice(kept.length);
    if (remainder) anchor.after(element.ownerDocument.createTextNode(remainder));
  }
}
