#!/usr/bin/env node
/**
 * End-to-end proof of the DROP-IN runner: drives OpencodeAgentSession exactly as
 * SessionRunnerPool/turn-orchestrator would, against a real opencode binary +
 * gateway, and prints the assistant's streamed reply.
 *
 *   OPENCODE_BIN=... OPENCODE_GATEWAY_URL=... OPENCODE_GATEWAY_TOKEN=... \
 *   OPENCODE_GATEWAY_MODEL=deepseek-chat node scripts/smoke-opencode-session.mjs "say hi"
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");
const { buildOpencodeConfig } = require("../src/main/runtime/opencode-config-builder.js");

const text = process.argv.slice(2).join(" ").trim() || "say hi in three words";
const bin = process.env.OPENCODE_BIN || "opencode";
// OPENCODE_INSTRUCTIONS=<AGENT.md path> — loaded as the authoritative agent prompt.
const fs = require("node:fs");
const guidePath = (process.env.OPENCODE_INSTRUCTIONS || "").split(",")[0].trim();
const agentPrompt = guidePath && fs.existsSync(guidePath) ? fs.readFileSync(guidePath, "utf8") : "";
const cfg = buildOpencodeConfig({
  lilyEnv: {
    LILY_API_BASE_URL: process.env.OPENCODE_GATEWAY_URL || "",
    LILY_API_KEY: process.env.OPENCODE_GATEWAY_TOKEN || "",
    LILY_MODEL: process.env.OPENCODE_GATEWAY_MODEL || "deepseek-chat",
    LILY_MODEL_HAIKU: process.env.OPENCODE_GATEWAY_MODEL_HAIKU || "",
    LILY_SUBAGENT_MODEL: process.env.OPENCODE_GATEWAY_MODEL_SUBAGENT || "",
  },
  permissionMode: process.env.OPENCODE_PERMISSION_MODE || "default",
  agentPrompt,
  pluginPaths: (process.env.OPENCODE_PLUGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
});

let assistant = "";
const orchestrator = {
  ingest(_sid, drafts) {
    for (const d of drafts) {
      if (d.type === "assistant.thinking.delta") process.stdout.write(`\x1b[2m${d.payload.text || ""}\x1b[0m`);
      if (d.type === "assistant.delta") { assistant += d.payload.text || ""; process.stdout.write(d.payload.text || ""); }
      if (d.type === "tool.started") console.log(`\n[tool ${d.payload.name}] ${JSON.stringify(d.payload.input).slice(0, 120)}`);
      if (d.type === "tool.done") console.log(`[tool done] ${(d.payload.result?.content || "").slice(0, 120)}`);
      if (d.type === "usage.updated") console.log(`\n[usage] ${JSON.stringify(d.payload.usage || {})}`);
      if (d.type === "permission.requested") {
        console.log(`\n[permission asked: ${d.payload.toolName}] auto-allowing once`);
        session.respondPermission(d.payload.requestId, { allow: true });
      }
    }
  },
  notifyRunnerDone() {
    console.log(`\n\n[DONE turn ${turn}] assistant said ${assistant.length} chars`);
    const next = process.env.OPENCODE_PROMPT2;
    if (next && turn === 1) {
      turn = 2; assistant = "";
      console.log(`\n[turn 2: ${JSON.stringify(next)}]\n`);
      setTimeout(() => session.sendUserMessage({ text: next }), 200);
      return;
    }
    finish(0);
  },
  notifyRunnerError(_sid, m) { console.log(`\n[ERROR] ${m}`); finish(1); },
};
let turn = 1;

const session = new OpencodeAgentSession("smoke", {});
session.bindOrchestrator(orchestrator);
session.on("agent-resume-id", (id) => console.log(`[session ${id}]`));

function finish(code) { try { session.terminate(); } catch {} process.exit(code); }

session.ensureProcess(process.cwd(), {
  agentCommand: bin,
  model: cfg.model,
  opencodeConfig: cfg.ok ? cfg.configContent : "",
}, { lazy: true });

console.log(`[asking: ${JSON.stringify(text)}]\n`);
session.sendUserMessage({ text });
setTimeout(() => { console.log("\n[timeout]"); finish(1); }, 45000);
