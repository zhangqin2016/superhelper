// Injects Lily's cross-session navigation memory into OpenCode's native context
// compaction (#1), so long sessions don't "forget" durable facts after a compact.
// Runs inside the OpenCode (Bun) server process.
//
// FAIL OPEN: this must NEVER throw and NEVER break compaction — on anything
// unexpected we leave `output` untouched and the engine uses its default summary.
//
// Handoff contract (Lily's src/main/compaction-memory-export.js writes it):
//   $LILY_COMPACTION_MEMORY_DIR/<engineSessionID>.json = { schemaVersion, blocks: string[] }
// The hook receives the engine sessionID and a mutable { context: string[], prompt }.
// We push a preserve directive + the blocks into `context` (folded into the
// engine's buildPrompt) and deliberately do NOT replace `prompt` — lowest risk.
import fs from "node:fs";
import path from "node:path";

// Hard ceiling so injected memory can never re-bloat the context compaction frees.
const MAX_CONTEXT_CHARS = 1800;
const PRESERVE_DIRECTIVE =
  "以下是本工作区的持久事实与既往进度。生成摘要时必须原样保留其中的具体事实" +
  "（生辰、标识、数字、文件名、已定结论），不要概括或丢弃；视为导航上下文而非证据。" +
  "用对话所用的语言。";

function readBlocks(sessionID) {
  const dir = process.env.LILY_COMPACTION_MEMORY_DIR || "";
  const id = String(sessionID || "");
  if (!dir || !/^[A-Za-z0-9_-]+$/.test(id)) return [];
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, `${id}.json`), "utf8");
  } catch {
    return []; // no memory for this session -> nothing to inject
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return []; // malformed -> fail open
  }
  return Array.isArray(data && data.blocks)
    ? data.blocks.filter((b) => typeof b === "string" && b.trim())
    : [];
}

function withinBudget(blocks) {
  const kept = [];
  let used = PRESERVE_DIRECTIVE.length;
  for (const block of blocks) {
    if (used + block.length > MAX_CONTEXT_CHARS) break;
    kept.push(block);
    used += block.length;
  }
  return kept;
}

export const CompactionMemoryPlugin = async () => ({
  "experimental.session.compacting": async (input, output) => {
    try {
      const blocks = withinBudget(readBlocks(input && input.sessionID));
      if (!blocks.length) return; // leave compaction untouched -> engine default
      const existing = Array.isArray(output && output.context) ? output.context : [];
      output.context = [PRESERVE_DIRECTIVE, ...blocks, ...existing];
    } catch {
      /* fail open — compaction must never break */
    }
  },
});

export default CompactionMemoryPlugin;
