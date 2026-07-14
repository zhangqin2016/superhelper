// Cap oversized tool output BEFORE it enters the model context. A single giant
// tool result (e.g. reading/writing a 6 MB file) balloons the context; then
// pre-turn compaction has to summarize the whole blob and can hang the turn.
//
// This runs in the OpenCode (Bun) serve process, in the `tool.execute.after`
// hook — its `output` is exactly what the engine feeds the model. We bound what
// the model sees to head+tail and write the FULL output to a sidecar file so the
// model can re-read it on demand (nothing is lost, just moved out of context).
//
// FAIL OPEN: never throws — any error leaves the output untouched (today's
// behavior). Kill switch: LILY_TOOL_OUTPUT_GUARD=0. Budget: LILY_TOOL_OUTPUT_MAX_CHARS.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const MAX_CHARS = Math.max(8_000, Number(process.env.LILY_TOOL_OUTPUT_MAX_CHARS) || 32_000);
const MARKER = "[lily: large tool output externalized]";

// NOTE: only the plugin factory is exported. The OpenCode plugin loader
// instantiates EVERY export of a plugin file as a plugin, so exporting helper
// functions here makes it call them as factories → they return a string/null →
// the engine crashes reading `.config` and every turn fails at createUserMessage.
// Keep all helpers INTERNAL (module-private).

// A stable text view of a tool result across the shapes the engine passes
// ({output:string}, {content:[{type:"text",text}]}, or a raw value).
function resultText(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output.output === "string") return output.output;
  try {
    if (Array.isArray(output.content)) {
      return output.content.map((c) => (c && c.type === "text" ? c.text : "")).join("");
    }
  } catch {
    /* ignore */
  }
  return "";
}

function writeSidecar(baseDir, tool, text) {
  const dir = path.join(baseDir, ".lily-work", "tool-output");
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
  const safeTool = String(tool || "output").replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
  const file = path.join(dir, `${safeTool}-${hash}.txt`);
  fs.writeFileSync(file, text);
  return file;
}

// Given the full text, produce the bounded head+tail view + a pointer note.
// Returns null when the text is within budget (no change needed). INTERNAL.
function boundToolOutput(text, { maxChars = MAX_CHARS, ref = "" } = {}) {
  if (typeof text !== "string" || text.length <= maxChars) return null;
  if (text.includes(MARKER)) return null; // already bounded — idempotent
  const headLen = Math.floor(maxChars * 0.7);
  const tailLen = Math.max(0, maxChars - headLen - 400);
  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(-tailLen) : "";
  const note =
    `\n\n${MARKER}: this tool output was ${text.length} chars; the middle was omitted to keep the model context small.` +
    (ref ? ` Full output saved to ${ref} — read that file if you need the omitted part.` : "") +
    "\n\n";
  return `${head}${note}${tail}`;
}

export const LargeOutputGuardPlugin = async (ctx = {}) => ({
  "tool.execute.after": async (input, output) => {
    try {
      if (process.env.LILY_TOOL_OUTPUT_GUARD === "0") return;
      if (!output || typeof output !== "object") return;
      const text = resultText(output);
      if (typeof text !== "string" || text.length <= MAX_CHARS || text.includes(MARKER)) return;

      const baseDir = String(
        (ctx && (ctx.directory || ctx.worktree)) ||
          process.env.OPENCODE_PROJECT_DIR ||
          process.cwd() ||
          os.tmpdir(),
      );
      let ref = "";
      try { ref = writeSidecar(baseDir, input && input.tool, text); }
      catch { try { ref = writeSidecar(os.tmpdir(), input && input.tool, text); } catch { ref = ""; } }

      const bounded = boundToolOutput(text, { maxChars: MAX_CHARS, ref });
      if (bounded == null) return;
      if (typeof output.output === "string") {
        output.output = bounded;
      } else if (Array.isArray(output.content)) {
        const nonText = output.content.filter((c) => c && c.type !== "text");
        output.content = [{ type: "text", text: bounded }, ...nonText];
      }
    } catch {
      /* fail open — the guard must never break a turn */
    }
  },
});

export default LargeOutputGuardPlugin;
