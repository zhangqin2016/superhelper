#!/usr/bin/env node
// Exercise the shipped engine, not the source checkout: local mock model only,
// isolated HOME/config/database, and real HTTP/SSE -> host ownership/accounting.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { OpencodeServerManager } = require("../src/main/runtime/opencode-server-manager.js");
const { resetSharedServer } = require("../src/main/runtime/opencode-shared-server.js");
const { fixture, dispatch, tick, root } = require("./helpers/opencode-host-fixture.cjs");
const key = `${process.platform}-${process.arch}`;
const binary = path.join(root, "bundles", key, "opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
if (!fs.existsSync(binary)) {
  console.log(`SKIP bundled usage: no engine for ${key}`);
  process.exit(0);
}
const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(binary)), "bundle-manifest.json"), "utf8"));
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-bundled-usage-")));
const requests = [], events = [];
const providerID = "lily-model-runtime-fixture", modelID = "runtime-fixture";
const model = { providerID, modelID };
let server, unsubscribe;
const api = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  requests.push(body);
  const userText = JSON.stringify(body.messages?.filter(message => message.role === "user") || []);
  const hasTaskResult = body.messages?.some(message => message.role === "tool");
  const delegate = userText.includes("runtime-parent-fixture") && !userText.includes("runtime-child-fixture")
    && !hasTaskResult && body.tools?.some(tool => tool.function?.name === "task");
  const delta = delegate ? { role: "assistant", tool_calls: [{ index: 0, id: "call_fixture_task", type: "function",
    function: { name: "task", arguments: JSON.stringify({ description: "Usage probe", prompt: "runtime-child-fixture", subagent_type: "general" }) },
  }] } : { role: "assistant", content: "Fixture complete." };
  const base = { id: `chatcmpl_fixture_${requests.length}`, object: "chat.completion.chunk", created: 1, model: modelID };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const frame of [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: delegate ? "tool_calls" : "stop" }] },
    { ...base, choices: [], usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 } },
  ]) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.end("data: [DONE]\n\n");
});
async function waitUntil(predicate, label) {
  const until = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`Timed out: ${label}; events=${events.map(e => e.type).join(",")}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
try {
  await new Promise((resolve, reject) => { api.once("error", reject); api.listen(0, "127.0.0.1", resolve); });
  const reference = `${providerID}/${modelID}`;
  server = new OpencodeServerManager({
    serverCommand: binary, cwd: temp, dataDir: path.join(temp, "engine.db"), model,
    env: {
      HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config"), XDG_DATA_HOME: path.join(temp, "data"),
      XDG_CACHE_HOME: path.join(temp, "cache"), XDG_STATE_HOME: path.join(temp, "state"),
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    },
    configContent: JSON.stringify({
      model: reference, small_model: reference, enabled_providers: [providerID],
      provider: { [providerID]: { npm: "@ai-sdk/openai-compatible", name: "Offline fixture",
        options: { baseURL: `http://127.0.0.1:${api.address().port}/v1`, apiKey: "fixture", includeUsage: true },
        models: { [modelID]: { limit: { context: 128000, output: 4096 } } },
      } },
      agent: { compaction: { model: reference }, title: { model: reference }, general: { model: reference } },
      permission: { "*": "deny", task: "allow" },
    }),
  });
  server.on("error", error => console.error("engine error:", error.message));
  await server.start();
  const sessionID = await server.createSession();
  unsubscribe = server._shared.onEvent((directory, event) => { if (directory === temp) events.push(event); });
  server.subscribe();
  await server.sendPrompt({ text: "runtime-parent-fixture: delegate once, then finish", model });
  await waitUntil(() => events.some(event => event.type === "session.idle" && event.properties.sessionID === sessionID), "parent completion");
  const beforeSummary = events.length;
  await server.summarize(model);
  await waitUntil(() => events.slice(beforeSummary).some(event => event.type === "session.compacted"), "idle compaction");
  const parts = events.filter(event => event.type === "message.part.updated" && event.properties.part.type === "step-finish");
  const messages = new Map(events.filter(event => event.type === "message.updated").map(event => [event.properties.info.id, event.properties.info]));
  assert.ok(parts.some(event => event.properties.part.sessionID !== sessionID), "real native child emits usage");
  assert.ok(parts.some(event => messages.get(event.properties.part.messageID)?.summary === true), "real idle compaction emits usage");
  for (const event of parts) {
    const info = messages.get(event.properties.part.messageID);
    assert.equal(info?.role, "assistant");
    assert.equal(info.providerID, providerID);
    assert.equal(info.modelID, modelID);
    assert.equal(info.sessionID, event.properties.part.sessionID);
  }
  const uniqueParts = new Map(parts.map(event => [event.properties.part.id, event.properties.part]));
  // The shipped v1 ensureTitle streams text directly, outside SessionProcessor.
  // It has no step-finish/assistant usage event; do not fabricate ownership/tokens.
  const titles = requests.filter(body => body.messages?.some(message =>
    message.role === "system" && String(message.content).startsWith("You are a title generator.")));
  assert.equal(titles.length, 1, "explicitly identify the non-session helper call");
  const sessionCalls = requests.length - titles.length;
  assert.equal(sessionCalls, 4, "two parent steps, one child step, one compaction");
  assert.equal([...uniqueParts.values()].reduce((sum, part) => sum + part.tokens.input, 0), sessionCalls * 120);
  const f = fixture();
  try {
    f.add("bundle"); f.sessions.get("bundle").agentResumeId = sessionID; f.rows.set(sessionID, { id: sessionID });
    const runner = (await f.ensure("bundle", "A")).runner;
    for (const event of events) dispatch(runner._server, event);
    for (const event of events) dispatch(runner._server, event);
    await tick();
    assert.equal(f.usageCalls.reduce((sum, call) => sum + call.delta.input_tokens, 0), sessionCalls * 120);
    assert.ok(f.usageCalls.every(call => call.sessionId === "bundle" && call.model.providerID === providerID && call.model.modelID === modelID));
  } finally { f.close(); }
  console.log(`bundled-usage: ok (opencode ${manifest.version}; ${sessionCalls} session calls accounted; main, child, compaction; replay dedup; ${titles.length} title call has no usage event)`);
} finally {
  unsubscribe?.();
  server?.terminate(); resetSharedServer();
  api.closeAllConnections();
  await new Promise(resolve => api.close(resolve));
  // Windows tree termination is asynchronous and briefly retains the engine DB lock.
  await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
