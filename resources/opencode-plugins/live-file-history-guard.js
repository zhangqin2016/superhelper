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

const MAX_HASH_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 128;
const READ_TOOLS = new Set(["read", "read_file"]);
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

function historicalMarker(file) {
  return `[lily: historical snapshot omitted because ${file} has a live filesystem version; read the current file before editing]`;
}

function sanitizeMutationInput(tool, args, files) {
  if (!args || typeof args !== "object" || !files.length) return;
  const marker = historicalMarker(files[0]);
  const keys = tool === "write"
    ? ["content", "text", "data"]
    : tool === "edit" || tool === "multiedit"
      ? ["oldString", "newString", "old_string", "new_string", "content"]
      : ["patch", "input", "content"];
  for (const key of keys) {
    if (typeof args[key] === "string" && args[key]) args[key] = marker;
  }
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
        for (const message of messages) {
          for (const part of Array.isArray(message?.parts) ? message.parts : []) {
            if (part?.type !== "tool") continue;
            const tool = String(part.tool || "").toLowerCase();
            if (!WRITE_TOOLS.has(tool)) continue;
            const args = part.state?.input;
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
            if (staleFiles.length) sanitizeMutationInput(tool, args, staleFiles);
          }
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
      const files = targetPaths(output?.args || input?.args, directory);
      for (const file of files) {
        const current = fingerprint(file);
        if (!current) continue;
        const readFingerprint = state.freshReads.get(file);
        if (state.stalePaths.has(file) || readFingerprint !== current) {
          const error = new Error(
            `LILY_LIVE_FILE_READ_REQUIRED: ${file} exists and may have changed since its historical snapshot. Read the current file in this turn before editing it.`,
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
