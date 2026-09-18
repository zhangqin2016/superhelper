"use strict";

/**
 * One contract for every piece of history Lily removes before a model call.
 *
 * Four guards independently shorten stored history — a stale file body, a
 * historical snapshot, an oversized part, a huge tool output — and each invented
 * its own `[lily: …]` sentence. Only two of the four were known to the write
 * backstop that stops the model handing a placeholder back as file content, so
 * a fifth producer would have been invisible to it by default. That is the same
 * shape as every other defect closed this week: a rule kept by convention
 * instead of by construction.
 *
 * Two ideas make this module worth having beyond tidiness.
 *
 * 1. WHAT THE CONTENT IS FOR decides how it may be shortened.
 *
 *    Content the model only has to UNDERSTAND — a tool output, an earlier
 *    answer — survives head+tail excerpting: it still reasons about the right
 *    thing, and some text beats none.
 *
 *    Content the model may be asked to REPRODUCE — the body of a file it wrote —
 *    must never be excerpted. A 15 KB script cut to head+tail reads as a whole
 *    file, so the model completes the middle from imagination and writes that
 *    back. Observed in a long-task run: supplier names in the regenerated middle
 *    drifted from the design (云杉/慧璞/铭远 against 云山/汇谱/明远) and the
 *    shortened script was internally consistent enough that nothing complained.
 *    For that content a POINTER is strictly better than an excerpt — it cannot
 *    be mistaken for the whole, and it says where the whole actually is.
 *
 * 2. A pointer is also CHEAPER, which makes the session smarter rather than
 *    poorer. Excerpting a file body to head+tail spends thousands of characters
 *    on something actively misleading; the pointer costs a line. Under context
 *    pressure that difference is budget other, genuinely useful parts get to
 *    keep instead of being trimmed in turn.
 *
 * Every marker therefore carries what was removed, where the real thing is, and
 * what to do about it — not merely that something was removed.
 */

const CANONICAL_PREFIX = "[lily: elided";

// Markers written before this module existed. Recognition must reach them, or a
// placeholder from an older session would be handed back as file content.
const LEGACY_PREFIXES = [
  "[lily: this earlier tool call succeeded",
  "[lily: historical snapshot omitted",
  "[lily: content trimmed to fit the model context window",
  "[lily: large tool output externalized",
];

/** Tools whose INPUT is a file body — content the model may be asked to reproduce. */
const REPRODUCIBLE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "patch"]);

/** The input keys that carry that body, as opposed to a path or an option. */
const BODY_KEYS = new Set(["content", "text", "data", "newstring", "new_string", "patch", "input", "body"]);

/**
 * May this slot be excerpted, or must it be replaced whole?
 * @param {string} tool the tool name on the history part ("" for text/reasoning parts)
 * @param {string} key the input key, or "" for output/error/text slots
 */
function isReproducible(tool, key) {
  if (!tool || !key) return false;
  return REPRODUCIBLE_TOOLS.has(String(tool).toLowerCase())
    && BODY_KEYS.has(String(key).toLowerCase());
}

function formatBytes(count) {
  const n = Number(count) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build a marker that tells the model what happened AND what to do next.
 *
 * @param {{ what: string, bytes?: number, path?: string, why?: string, action?: string }} input
 */
function elide({ what, bytes, path, why, action } = {}) {
  const parts = [`${CANONICAL_PREFIX} ${what || "content"}`];
  if (bytes) parts.push(`(${formatBytes(bytes)})`);
  parts.push(`— removed from history ${why || "to fit the model context window"}.`);
  if (path) parts.push(`The real content is on disk at ${path}.`);
  parts.push(action || "Read it with a file tool before relying on it.");
  parts.push("Never copy this text into a file.");
  return `${parts.join(" ")}]`;
}

/** The pointer that replaces a file body: no excerpt, so it cannot be mistaken for one. */
function elideFileBody({ path, bytes, why }) {
  return elide({
    what: path ? `the body of ${path}` : "a file body",
    bytes,
    path,
    // The reason is not decoration: "because it has since changed on disk" and
    // "to fit the context window" call for the same action but describe
    // different situations, and telling the model the wrong one is a lie it
    // will act on.
    why,
    action: path
      ? `Read ${path} before editing or rewriting it — do not reconstruct it from this message.`
      : "Read the file before editing or rewriting it — do not reconstruct it from this message.",
  });
}

/**
 * Is this whole string one of Lily's placeholders?
 *
 * Deliberately anchored at the start: a file that merely QUOTES a marker is real
 * content and must not be refused. Only a body that IS the placeholder is.
 */
function isElidedBody(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  if (text.startsWith(CANONICAL_PREFIX)) return true;
  return LEGACY_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** Does this string already carry a marker anywhere? Used to keep shortening idempotent. */
function containsElision(value) {
  if (typeof value !== "string" || !value) return false;
  if (value.includes(CANONICAL_PREFIX)) return true;
  return LEGACY_PREFIXES.some((prefix) => value.includes(prefix));
}

module.exports = {
  BODY_KEYS,
  CANONICAL_PREFIX,
  LEGACY_PREFIXES,
  REPRODUCIBLE_TOOLS,
  containsElision,
  elide,
  elideFileBody,
  formatBytes,
  isElidedBody,
  isReproducible,
};
