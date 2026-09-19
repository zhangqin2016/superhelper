// Keep live workspace files authoritative over historical tool snapshots.
//
// OpenCode retains completed write/edit inputs in model history. That is useful
// provenance, but a later user edit can make those embedded file bodies stale.
// This plugin removes historical bodies before each model call and requires one
// successful live read before an existing file can be modified. A post-write
// fingerprint keeps normal multi-step agent work flowing; if the user changes
// the file externally, the fingerprint changes and the read gate re-arms.
//
// Missing/unreadable files fail open so new-file creation and transient
// filesystem problems are not blocked. Kill switch: LILY_LIVE_FILE_GUARD=0.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import elision from "./lib/history-elision.cjs";
import readTools from "./lib/file-read-tools.cjs";

const MAX_HASH_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 128;
// Which tools count as having read the file — mirrored from the platform's own
// classification rather than kept as a second, narrower list here.
// See lib/file-read-tools.cjs.
const { FILE_READ_TOOLS: READ_TOOLS, SUGGESTED_READ_TOOL } = readTools;
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "patch"]);
const sessions = new Map();

function sessionState(sessionID) {
  const id = String(sessionID || "default");
  let state = sessions.get(id);
  if (state) {
    sessions.delete(id);
  } else {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    state = { freshReads: new Map(), stalePaths: new Set() };
  }
  sessions.set(id, state);
  return state;
}

function resolvedPath(value, directory) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.normalize(path.isAbsolute(raw) ? raw : path.resolve(directory || process.cwd(), raw));
}

function patchPaths(value, directory) {
  const out = [];
  for (const match of String(value || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
    const file = resolvedPath(match[1], directory);
    if (file) out.push(file);
  }
  return out;
}

function targetPaths(args = {}, directory = "") {
  const out = new Set();
  for (const key of ["filePath", "file_path", "path", "file", "filename"]) {
    const file = resolvedPath(args?.[key], directory);
    if (file) out.add(file);
  }
  for (const key of ["patch", "input", "content"]) {
    for (const file of patchPaths(args?.[key], directory)) out.add(file);
  }
  return [...out];
}

function fingerprint(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    let digest = "";
    if (stat.size <= MAX_HASH_BYTES) {
      digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
    return `${Math.floor(stat.mtimeMs)}:${stat.size}:${digest}`;
  } catch {
    return null;
  }
}

function currentText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_HASH_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function sessionIDFrom(input, messages = []) {
  if (input?.sessionID) return String(input.sessionID);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = messages[i]?.info?.sessionID || messages[i]?.sessionID;
    if (id) return String(id);
  }
  return "default";
}

// The wording matters: the model reads this INSIDE its own earlier tool call.
// It must understand the call succeeded and only the body is elided, otherwise
// it "re-writes" the file from what it sees (2026-09-14 field case: the marker
// itself was written to disk six times).
// Built from the shared contract, so every marker Lily writes says the same
// three things: what was removed, where the real content is, and what to do.
// Recognition is shared too: this file used to know two of the four markers, so
// a body carrying either of the other two was accepted as real file content.
function historicalMarker(file) {
  return elision.elideFileBody({ path: file, why: "because it has since changed on disk" });
}

function isMarkerText(value) {
  return elision.isElidedBody(String(value || ""));
}

/**
 * Return a sanitized COPY of the tool args; never mutates the input object.
 *
 * The stale body is REMOVED, not replaced with an explanation. Filling the
 * content slot with prose put a plausible file body where a file body goes, and
 * the model did the obvious thing with it: a field case has a `write` whose
 * content is this module's own placeholder, copied verbatim — closing sentence
 * included, the one that says never to copy it. An instruction living inside the
 * content slot is read as content, because that is what that slot means.
 *
 * With the key gone there is nothing in that position to copy, and what happened
 * is said in the tool's RESULT, which is where the model reads about a call
 * rather than reads its payload. The write backstop stays as defence in depth
 * for history written before this change.
 */
function sanitizedMutationInput(tool, args, files) {
  if (!args || typeof args !== "object" || !files.length) return args;
  const keys = tool === "write"
    ? ["content", "text", "data"]
    : tool === "edit" || tool === "multiedit"
      ? ["oldString", "newString", "old_string", "new_string", "content"]
      : ["patch", "input", "content"];
  const next = { ...args };
  let removed = false;
  for (const key of keys) {
    if (typeof next[key] === "string" && next[key]) { delete next[key]; removed = true; }
  }
  return removed ? next : args;
}

function historicalMutationIsStale(tool, args, file, state, currentFingerprint) {
  if (tool === "write") {
    const live = currentText(file);
    if (live != null && typeof args?.content === "string") return live !== args.content;
  }
  return state.freshReads.get(file) !== currentFingerprint;
}

function outputFailed(output) {
  if (!output || typeof output !== "object") return false;
  return Boolean(output.error) || String(output.status || "").toLowerCase() === "error";
}

export const LiveFileHistoryGuardPlugin = async (ctx = {}) => {
  const directory = String(ctx.directory || process.cwd());
  return {
    "experimental.chat.messages.transform": async (input, output) => {
      try {
        if (process.env.LILY_LIVE_FILE_GUARD === "0") return;
        const messages = Array.isArray(output?.messages) ? output.messages : [];
        const state = sessionState(sessionIDFrom(input, messages));
        // The engine hands us its LIVE message objects (prompt.ts does not
        // clone them). Mutating a part in place leaks the marker into the
        // engine's stored history and — for a tool call that has not executed
        // yet — into the write itself. So: only COMPLETED historical calls are
        // touched, and always by replacing the message with a sanitized copy.
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index];
          const parts = Array.isArray(message?.parts) ? message.parts : [];
          let replacedParts = null;
          for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
            const part = parts[partIndex];
            if (part?.type !== "tool") continue;
            const tool = String(part.tool || "").toLowerCase();
            if (!WRITE_TOOLS.has(tool)) continue;
            if (String(part.state?.status || "") !== "completed") continue;
            const args = part.state?.input;
            if (!args || typeof args !== "object") continue;
            const files = targetPaths(args, directory);
            const staleFiles = [];
            for (const file of files) {
              const current = fingerprint(file);
              if (!current) continue;
              if (historicalMutationIsStale(tool, args, file, state, current)) {
                state.stalePaths.add(file);
                staleFiles.push(file);
              } else {
                state.stalePaths.delete(file);
              }
            }
            if (!staleFiles.length) continue;
            const sanitized = sanitizedMutationInput(tool, args, staleFiles);
            if (sanitized === args) continue;
            if (!replacedParts) replacedParts = [...parts];
            // The explanation rides the RESULT, where the model reads what a call
            // did — not the input, where it reads what to send.
            const note = historicalMarker(staleFiles[0]);
            const priorOutput = typeof part.state?.output === "string" && part.state.output ? `${part.state.output}\n\n` : "";
            replacedParts[partIndex] = {
              ...part,
              state: { ...part.state, input: sanitized, output: `${priorOutput}${note}` },
            };
          }
          if (replacedParts) messages[index] = { ...message, parts: replacedParts };
        }
      } catch {
        /* fail open — history hygiene must never break a model call */
      }
    },

    "tool.execute.before": async (input, output) => {
      if (process.env.LILY_LIVE_FILE_GUARD === "0") return;
      const tool = String(input?.tool || "").toLowerCase();
      if (!WRITE_TOOLS.has(tool)) return;
      const state = sessionState(input?.sessionID);
      const args = output?.args || input?.args || {};
      const files = targetPaths(args, directory);
      // Backstop: a body that IS the history marker is never real content.
      for (const key of ["content", "text", "data", "newString", "new_string", "patch", "input"]) {
        if (isMarkerText(args?.[key])) {
          const error = new Error(
            `LILY_LIVE_FILE_MARKER_REJECTED: the tool body is Lily's history placeholder, not file content. `
            + `Read ${files[0] || "the target file"} with the \`${SUGGESTED_READ_TOOL}\` tool, then write its real content.`,
          );
          error.code = "LILY_LIVE_FILE_MARKER_REJECTED";
          throw error;
        }
      }
      for (const file of files) {
        const current = fingerprint(file);
        if (!current) continue;
        const readFingerprint = state.freshReads.get(file);
        if (state.stalePaths.has(file) || readFingerprint !== current) {
          const error = new Error(
            `LILY_LIVE_FILE_READ_REQUIRED: ${file} exists and may have changed since its historical snapshot. `
            + `Read it with the \`${SUGGESTED_READ_TOOL}\` tool in this turn, then edit. `
            + "Reading it another way — a shell command, or an extraction/outline tool — does not clear this: "
            + "those do not show the current bytes an edit must be written against.",
          );
          error.code = "LILY_LIVE_FILE_READ_REQUIRED";
          throw error;
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        if (process.env.LILY_LIVE_FILE_GUARD === "0" || outputFailed(output)) return;
        const tool = String(input?.tool || "").toLowerCase();
        if (!READ_TOOLS.has(tool) && !WRITE_TOOLS.has(tool)) return;
        const state = sessionState(input?.sessionID);
        for (const file of targetPaths(input?.args, directory)) {
          const current = fingerprint(file);
          if (!current) continue;
          state.freshReads.set(file, current);
          state.stalePaths.delete(file);
        }
      } catch {
        /* fail open — observation must never change tool success */
      }
    },
  };
};

export default LiveFileHistoryGuardPlugin;
