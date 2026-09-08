"use strict";

const MAX_TEXT = 32_768;

// A bounded observer, not a Markdown renderer. Ambiguous structured content
// keeps the previous fail-open behavior. Only known closed fences re-arm it.
function appendLoopProse(state, piece) {
  if (state.protectedText) return "";
  if (piece.length > MAX_TEXT) { state.protectedText = true; return ""; }
  state.line ||= "";
  const lines = piece.split("\n");
  for (let index = 0; index < lines.length; index++) {
    state.line += lines[index];
    if (state.line.length > MAX_TEXT) { state.protectedText = true; return ""; }
    const complete = index < lines.length - 1;
    if (!complete) break;
    const line = state.line.replace(/\r$/, "");
    state.line = "";
    if (state.fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === state.fence.char && close[1].length >= state.fence.length) state.fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open) {
      state.fence = { char: open[1][0], length: open[1].length };
      state.text = "";
      continue;
    }
    if (/```|~~~|^\s*(?:>|["“]|[-*]\s|\d+[.)]\s)/u.test(line)) {
      state.protectedText = true; return "";
    }
    state.text = `${state.text}${line}\n`.slice(-MAX_TEXT);
  }
  if (state.fence || /```|~~~|^\s*(?:>|["“]|[-*]\s|\d+[.)]\s)/u.test(state.line)) return "";
  return `${state.text}${state.line}`.slice(-MAX_TEXT);
}

module.exports = { appendLoopProse };
