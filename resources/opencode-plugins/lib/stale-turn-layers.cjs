"use strict";

// What an EARLIER turn's user message keeps once it is history.
//
// Lily sends each turn's request as layered text (engine-message-layers.js):
// platform_context, extracted_attachments, execution_constraints (the task
// contract) and user_original_request. The layers ride the CURRENT turn's
// message — at the end of the context, where they do not disturb the provider's
// cached prefix — and used to stay in every message forever: one field session
// carried 22 copies of the task contract (~230K chars), and a later turn still
// read an earlier turn's "This is a separate task … prior conversation is
// background only" (2026-09-28 audit).
//
// A message that is history keeps what is TRUE about it: what the user asked
// (user_original_request), what they attached (the attachment provenance line)
// and the content extracted from it (extracted_attachments — evidence a later
// turn may cite). Its instructions and injected context — the execution
// constraints, memory and bootstrap context — were for that turn only.
//
// The stripping is deterministic, so a message strips identically on every
// later call and the cached prefix stays stable. Only Lily's own layer markup
// is parsed; text without it is returned unchanged.

const LAYER_RE = /<lily_layer title="([a-z_]+)">\n([\s\S]*?)\n<\/lily_layer>/g;
const REQUEST_MARKER = '<lily_layer title="user_original_request">';
const PROVENANCE_HEAD = "Attachment provenance for THIS user message";

function isLayeredRequest(text) {
  return typeof text === "string" && text.includes(REQUEST_MARKER);
}

function provenanceOnly(body) {
  const lines = String(body || "").split("\n");
  const at = lines.findIndex((line) => line.startsWith(PROVENANCE_HEAD));
  if (at < 0 || !lines[at + 1] || !lines[at + 1].trim().startsWith("{")) return "";
  return [lines[at], lines[at + 1]].join("\n");
}

function stripStaleTurnLayers(text) {
  if (!isLayeredRequest(text)) return text;
  const kept = [];
  for (const [whole, title, body] of text.matchAll(LAYER_RE)) {
    if (title === "user_original_request" || title === "extracted_attachments") kept.push(whole);
    else if (title === "platform_context") {
      const provenance = provenanceOnly(body);
      if (provenance) kept.push(`<lily_layer title="platform_context">\n${provenance}\n</lily_layer>`);
    }
  }
  // Nothing recognisable: leave the message exactly as it was.
  return kept.some((block) => block.startsWith(REQUEST_MARKER)) ? kept.join("\n\n") : text;
}

// Whether a message STARTS a turn: it carries that turn's own instructions
// (the execution_constraints layer — task contract or source guidance) and is
// not an internal recovery continuation. A steer ("插话") sent mid-turn is
// layered too but carries only the user's words and attachment provenance, so
// it must not make the running turn's contract look stale; a recovery
// continuation continues the same task. A turn with no constraints (a bare
// "谢谢") opens nothing, leaving the earlier request whole — the behaviour
// before this plugin existed.
const INTERNAL_TURN_RE = /<lily_internal_turn\s+kind="/;
function opensTurn(text) {
  if (!isLayeredRequest(text) || INTERNAL_TURN_RE.test(text)) return false;
  for (const [, title, body] of text.matchAll(LAYER_RE)) {
    if (title === "execution_constraints" && String(body || "").trim()) return true;
  }
  return false;
}

module.exports = { isLayeredRequest, opensTurn, stripStaleTurnLayers };
