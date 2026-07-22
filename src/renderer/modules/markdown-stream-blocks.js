/**
 * Block-level incremental rendering for streaming markdown.
 *
 * Streaming used to re-parse the ENTIRE accumulated text on every tick
 * (marked + DOMPurify over hundreds of KB near the end of a long answer —
 * O(n²) total, visible as dropped frames while the model types). morphdom
 * already made DOM writes incremental; this module does the same for parsing.
 *
 * Idea: markdown blocks separated by a blank line are context-free as long as
 * the prefix is "stable" — code fences balanced and $$ display-math closed.
 * Everything before the last stable boundary parses to fixed HTML, so we cache
 * that sanitized HTML per element and only re-parse the growing tail. The two
 * fragments are concatenated at a block boundary, so joining sanitized pieces
 * is safe (no tag can straddle the cut).
 *
 * Fail-open: any unusual input (no stable boundary, prefix mismatch) just
 * parses the whole text, exactly as before.
 */

const STREAM_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Longest prefix that ends at a blank-line block boundary with balanced code
 * fences and closed $$ math. Returns "" when nothing is stable yet.
 */
export function stableStreamPrefix(text = "") {
  const source = String(text);
  let fenceChar = "";
  let fenceLen = 0;
  let mathOpen = false;
  let cut = 0;
  let offset = 0;
  const lines = source.split("\n");
  // The last line can never host a boundary (no trailing blank line yet).
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    offset += line.length + 1;
    const m = line.match(STREAM_FENCE_RE);
    if (fenceChar) {
      if (m && m[1][0] === fenceChar && m[1].length >= fenceLen) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }
    if (m) {
      fenceChar = m[1][0];
      fenceLen = m[1].length;
      continue;
    }
    const dollars = line.split("$$").length - 1;
    if (dollars % 2 === 1) mathOpen = !mathOpen;
    if (!line.trim() && !mathOpen) cut = offset;
  }
  return cut > 0 ? source.slice(0, cut) : "";
}

/**
 * Render `text` via `parse(markdown) -> sanitizedHtml`, reusing the cached
 * prefix HTML when the stable prefix is unchanged since the last call for this
 * element. `cache` is a WeakMap<element, {prefix, html>> owned by the caller.
 */
export function renderStreamBlocks(cache, element, text, parse) {
  const prefix = stableStreamPrefix(text);
  if (!prefix) return parse(text);
  const hit = cache.get(element);
  if (hit && hit.prefix === prefix) {
    return hit.html + parse(text.slice(prefix.length));
  }
  const html = parse(prefix);
  cache.set(element, { prefix, html });
  return html + parse(text.slice(prefix.length));
}
