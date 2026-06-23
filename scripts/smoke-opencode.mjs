#!/usr/bin/env node
/**
 * Live smoke test for the OpenCode transport against a real `opencode serve`.
 *
 *   node scripts/smoke-opencode.mjs                 # transport only (no model call, free)
 *   node scripts/smoke-opencode.mjs "say hi briefly"# full turn (uses your configured model + quota)
 *
 * Env:
 *   OPENCODE_BIN   path to the opencode binary (default: "opencode" on PATH)
 *   SMOKE_MS       how long to stream events before exiting (default 15000)
 *
 * It prints every raw SSE event `type` and, alongside, what the OpenCode runtime
 * reducer emits — so we can confirm the live event names match the reducer.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { OpencodeServerManager } = require("../src/main/runtime/opencode-server-manager.js");
const {
  createOpencodeRuntimeState,
  reduceOpencodeRuntimeEvent,
} = require("../src/main/runtime/opencode-runtime-reducer.js");

const prompt = process.argv.slice(2).join(" ").trim();
const bin = process.env.OPENCODE_BIN || "opencode";
const streamMs = Number(process.env.SMOKE_MS || 15000);
// OPENCODE_MODEL="provider/model" e.g. "opencode/deepseek-v4-flash-free"
let model = null;
if (process.env.OPENCODE_MODEL) {
  const [providerID, ...rest] = process.env.OPENCODE_MODEL.split("/");
  model = { providerID, modelID: rest.join("/") };
}

// Simulate Lily's distributed model ("下发的模型") via a gateway, building the
// OpenCode provider override exactly like SessionRunnerPool does.
//   OPENCODE_GATEWAY_URL / OPENCODE_GATEWAY_TOKEN / OPENCODE_GATEWAY_MODEL
const env = {};
if (process.env.OPENCODE_GATEWAY_URL) {
  const { resolveOpencodeModelConfig } = require("../src/main/runtime/opencode-model-config.js");
  const cfg = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: process.env.OPENCODE_GATEWAY_URL,
    LILY_API_KEY: process.env.OPENCODE_GATEWAY_TOKEN || "",
    LILY_MODEL: process.env.OPENCODE_GATEWAY_MODEL || "claude-3-5-sonnet",
  });
  console.log(`[gateway config ok=${cfg.ok} reason=${cfg.reason || "-"} url=${cfg.baseUrl}]`);
  if (cfg.ok) {
    env.OPENCODE_CONFIG_CONTENT = cfg.configContent;
    model = cfg.model; // { providerID:"anthropic", modelID }
  }
}

const reducerState = createOpencodeRuntimeState();
const server = new OpencodeServerManager({
  serverCommand: bin,
  cwd: process.cwd(),
  dataDir: `/tmp/lily-opencode-smoke/${Date.now()}.db`,
  env,
  model,
});

const seenTypes = new Set();
let unknownTypes = new Set();

server.on("event", (ev) => {
  const type = ev?.type || "(no-type)";
  if (!seenTypes.has(type)) {
    const reduced = reduceOpencodeRuntimeEvent(ev, reducerState);
    const kinds = [
      ...reduced.drafts.map((d) => d.type),
      ...reduced.effects.map((e) => e.kind),
    ].join(",") || "(silent)";
    if (reduced.effects.some((e) => e.kind === "unknown")) unknownTypes.add(type);
    console.log(`  SSE ${type.padEnd(38)} -> ${kinds}`);
    seenTypes.add(type);
  }
});
server.on("exit", ({ code }) => console.log(`[server exited: ${code}]`));
server.on("error", (err) => console.log(`[server error: ${err.message}]`));

function done() {
  console.log("\n--- summary ---");
  console.log(`distinct SSE event types seen: ${seenTypes.size}`);
  if (unknownTypes.size) {
    console.log(`UNRECOGNIZED by normalizer (need mapping): ${[...unknownTypes].join(", ")}`);
  } else {
    console.log("all seen event types were recognized by the normalizer ✓");
  }
  server.terminate();
  process.exit(0);
}

try {
  console.log(`[starting ${bin} serve ...]`);
  const { host, port } = await server.start();
  console.log(`[listening on ${host}:${port}]`);
  const id = await server.createSession();
  console.log(`[session created: ${id}]`);
  server.subscribe();
  console.log("[subscribed to /event]");

  if (prompt) {
    console.log(`[sending prompt: ${JSON.stringify(prompt)}]`);
    await server.sendPrompt({ text: prompt });
  } else {
    console.log("[no prompt — transport-only check; pass a prompt arg for a full turn]");
  }
  console.log(`[streaming events for ${streamMs}ms ...]\n`);
  setTimeout(done, streamMs);
} catch (err) {
  console.error(`[SMOKE FAILED] ${err.message}`);
  server.terminate();
  process.exit(1);
}
