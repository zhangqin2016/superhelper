"use strict";

/**
 * Accumulates stdout chunks and yields complete newline-delimited lines, keeping
 * any trailing partial line until the next chunk completes it. Factored out of
 * AgentSession so the chunk-boundary handling (a partial JSON line split across
 * two reads must not be parsed twice) is unit-tested in isolation. The session
 * keeps the per-line REACTION (parsing, turn/emit logic) — that's session
 * behavior, not buffering.
 */
class LineBuffer {
  constructor() {
    this._buf = "";
  }

  /**
   * Add a chunk; return the complete lines it produced (the trailing partial
   * line is retained for the next push).
   * @returns {string[]}
   */
  push(chunk) {
    this._buf += chunk == null ? "" : chunk.toString();
    const lines = this._buf.split("\n");
    this._buf = lines.pop() || "";
    return lines;
  }

  /**
   * Return the trailing buffered content (trimmed) and clear the buffer, or null
   * if nothing meaningful remains. Used when the stream ends mid-line.
   * @returns {string|null}
   */
  flush() {
    const trimmed = this._buf.trim();
    this._buf = "";
    return trimmed || null;
  }

  /** Discard any buffered partial line (e.g. on respawn/terminate). */
  reset() {
    this._buf = "";
  }
}

module.exports = { LineBuffer };
