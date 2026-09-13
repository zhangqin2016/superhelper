#!/usr/bin/env node
// Explicit opt-in: old binary -> same isolated native DB -> new binary.
// Real Lily shared serve/SDK/HTTP/SSE; scripted localhost model, not a model-quality test.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
const require = createRequire(import.meta.url);
const oldBinary = process.env.LILY_TEST_OLD_OPENCODE_BIN;
if (!oldBinary) {
  console.log("SKIP native upgrade: set LILY_TEST_OLD_OPENCODE_BIN to a retained 1.18.29 binary");
  process.exit(0);
}
const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "bundles", `${process.platform}-${process.arch}`, "opencode/bin",
  process.platform === "win32" ? "opencode.exe" : "opencode");
assert.equal(execFileSync(oldBinary, ["--version"], { encoding: "utf8", timeout: 15000 }).trim(), "1.18.29");
assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 15000 }).trim(), "1.18.30");
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-native-upgrade-")));
process.env.LILY_USER_DATA_DIR = path.join(temp, "lily");
const { OpencodeServerManager } = require("../src/main/runtime/opencode-server-manager.js");
const { resetSharedServer } = require("../src/main/runtime/opencode-shared-server.js");
const { buildSharedBaseConfig } = require("../src/main/runtime/opencode-config-builder.js");
const { verifyResumeBinding } = require("../src/main/resume-binding.js");
const providerID = "lily-upgrade-fixture", modelID = "upgrade-fixture";
const model = { providerID, modelID };
const requests = [], apiErrors = [];
const responseRequests = [];
let server, holdResponse = null, liveDeltas = 0;
const sockets = new Set();
const api = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === "/v1/responses") {
      responseRequests.push(body);
      const id = `resp_fixture_${responseRequests.length}`, itemID = `msg_fixture_${responseRequests.length}`;
      const response = { id, object: "response", created_at: 1, model: modelID };
      const item = { id: itemID, type: "message", role: "assistant", content: [] };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let sequence = 0;
      const send = (type, fields) => res.write(`data: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
      send("response.created", { response: { ...response, status: "in_progress", output: [] } });
      send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
      send("response.content_part.added", { item_id: itemID, output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] } });
      const beforeDelta = liveDeltas;
      send("response.output_text.delta", { item_id: itemID, output_index: 0, content_index: 0, delta: "Responses verified." });
      await waitUntil(() => liveDeltas > beforeDelta, "Responses fragment delivered");
      const content = { type: "output_text", text: "Responses verified.", annotations: [], logprobs: [] };
      send("response.output_text.done", { item_id: itemID, output_index: 0, content_index: 0, text: content.text, logprobs: [] });
      send("response.content_part.done", { item_id: itemID, output_index: 0, content_index: 0, part: content });
      send("response.output_item.done", { output_index: 0, item: { ...item, status: "completed", content: [content] } });
      send("response.completed", { response: { ...response, status: "completed",
        output: [{ ...item, status: "completed", content: [content] }],
        usage: { input_tokens: 120, output_tokens: 8, total_tokens: 128,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      res.end();
      return;
    }
    assert.equal(req.url, "/v1/chat/completions");
    requests.push(body);
    const isTitle = body.messages?.some(m => m.role === "system" && String(m.content).startsWith("You are a title generator."));
    const users = body.messages.filter(m => m.role === "user");
    const latest = JSON.stringify(users.at(-1));
    const base = { id: `chatcmpl_upgrade_${requests.length}`, object: "chat.completion.chunk", created: 1, model: modelID };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = delta => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    const beforeDelta = liveDeltas;
    frame({ role: "assistant", content: isTitle ? "Upgrade fixture" : "Verified " });
    // Keep the stream open until Lily observes its first fragment. An instant
    // fixture is legitimately coalesced into a final text snapshot by the host.
    if (!isTitle) await waitUntil(() => liveDeltas > beforeDelta, "first fragment delivered before stream completion");
    if (!isTitle && latest.includes("upgrade-cancel")) {
      holdResponse = res;
      return;
    }
    if (!isTitle) frame({ content: latest.includes("upgrade-second") ? "continuation." : "original." });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) {
    apiErrors.push(error);
    res.destroy();
  }
});
api.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
async function waitUntil(predicate, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (apiErrors.length) throw apiErrors[0];
    if (Date.now() >= until) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function stop() {
  const child = server?._shared?.process;
  const exited = child && child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve();
  server?.terminate();
  resetSharedServer();
  await exited;
  server = null;
}
async function start(command, config, resumeSessionID) {
  server = new OpencodeServerManager({
    serverCommand: command, cwd: temp, dataDir: path.join(temp, "engine.db"), model, resumeSessionID,
    env: {
      HOME: temp, USERPROFILE: temp, XDG_CONFIG_HOME: path.join(temp, "config"),
      XDG_DATA_HOME: path.join(temp, "data"), XDG_CACHE_HOME: path.join(temp, "cache"),
      XDG_STATE_HOME: path.join(temp, "state"), OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    },
    configContent: config,
  });
  server.on("error", error => apiErrors.push(error));
  server.on("event", event => { if (event.type === "message.part.delta") liveDeltas++; });
  await server.start();
  await server.createSession();
  server.subscribe();
  return server.sessionID;
}
async function turn(text) {
  const events = [];
  const onEvent = event => events.push(event);
  server.on("event", onEvent);
  try {
    await server.sendPrompt({ text, model });
    await waitUntil(() => events.some(event => event.type === "session.idle" &&
      event.properties.sessionID === server.sessionID), `idle after ${text}`);
    assert.equal(events.some(event => event.type === "session.error"), false);
    assert.ok(events.some(event => event.type === "message.part.delta"), "stream deltas reach Lily");
  } finally { server.off("event", onEvent); }
}
try {
  await new Promise((resolve, reject) => { api.once("error", reject); api.listen(0, "127.0.0.1", resolve); });
  const cfg = buildSharedBaseConfig({
    lilyEnv: { LILY_API_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`, LILY_API_KEY: "fixture-not-a-secret",
      LILY_MODEL: modelID, LILY_OPENCODE_PROVIDER_ID: providerID },
    basePrompt: "Lily upgrade identity sentinel. General workbench, preserve task continuity.",
    disallowedTools: ["task"],
  });
  assert.equal(cfg.ok, true);
  const config = JSON.parse(cfg.configContent);
  config.enabled_providers = [providerID];
  config.permission = { "*": "deny" };
  const sessionID = await start(oldBinary, JSON.stringify(config));
  await turn("upgrade-first: keep history sentinel 67193");
  const oldMessages = (await server._sdkSession.messages(sessionID)).data;
  assert.equal(oldMessages.filter(m => m.info.role === "user").length, 1);
  assert.ok(JSON.stringify(oldMessages).includes("Verified original."));
  const oldIDs = oldMessages.map(m => m.info.id);
  await stop();

  const binding = { resumeId: sessionID, lilySessionId: "upgrade-fixture", projectId: "isolated", workspacePathHash: temp,
    enabledSkillIdsHash: "none", firstUserMessageHash: "67193", opencodeVersion: "1.18.29" };
  assert.equal(verifyResumeBinding({ agentResumeId: sessionID, agentResumeBinding: binding },
    { ...binding, opencodeVersion: "1.18.30" }).ok, true, "host must allow the validated forward upgrade");
  assert.equal(await start(binary, JSON.stringify(config), sessionID), sessionID, "new native engine resumes exact row");
  assert.equal(server.wasResumed, true);
  const restored = (await server._sdkSession.messages(sessionID)).data;
  assert.deepEqual(restored.map(m => m.info.id), oldIDs, "old message IDs survive native DB reopen unchanged");
  await turn("upgrade-second: continue with the previous context");
  const after = (await server._sdkSession.messages(sessionID)).data;
  assert.equal(after.filter(m => m.info.role === "user").length, 2, "one submitted prompt persists once");
  assert.equal(after.filter(m => m.info.role === "assistant").length, 2, "one final answer per turn");
  const resumedRequest = requests.find(body => JSON.stringify(body.messages?.at(-1)).includes("upgrade-second"));
  assert.ok(resumedRequest, "new engine reaches provider");
  assert.ok(JSON.stringify(resumedRequest.messages).includes("67193"), "original user context reaches new provider call");
  assert.ok(JSON.stringify(resumedRequest.messages).includes("Verified original."), "original assistant context reaches new provider call");
  assert.ok(JSON.stringify(resumedRequest.messages).includes("Lily upgrade identity sentinel"), "Lily custom persona remains authoritative");
  const terminal = [];
  server.on("event", event => terminal.push(event));
  await server.sendPrompt({ text: "upgrade-cancel", model });
  await waitUntil(() => holdResponse !== null, "held stream reached provider");
  await server._sdkSession.abort(sessionID);
  await waitUntil(() => terminal.some(event => event.type === "session.idle" && event.properties.sessionID === sessionID), "abort settles");
  holdResponse.end("data: [DONE]\n\n");
  await turn("upgrade-after-cancel: new work is allowed");
  await stop();
  // Exercise the adapter actually changed upstream: same history, now through
  // the production builder's learned Responses route (not URL/model guessing).
  const responsesConfig = buildSharedBaseConfig({
    lilyEnv: { LILY_API_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`, LILY_API_KEY: "fixture-not-a-secret",
      LILY_MODEL: modelID, LILY_OPENCODE_PROVIDER_ID: providerID,
      LILY_MODEL_REQUEST_SHAPE: JSON.stringify({ api: "responses" }) },
    basePrompt: "Lily upgrade identity sentinel. General workbench, preserve task continuity.",
  });
  assert.equal(responsesConfig.ok, true);
  const responses = JSON.parse(responsesConfig.configContent);
  assert.equal(responses.provider[providerID].npm, "@ai-sdk/openai");
  responses.enabled_providers = [providerID];
  responses.permission = { "*": "deny" };
  assert.equal(await start(binary, JSON.stringify(responses), sessionID), sessionID);
  await turn("upgrade-responses: continue on the Responses adapter");
  assert.equal(responseRequests.length, 1, "one Responses request for one new turn");
  assert.ok(JSON.stringify(responseRequests[0].input).includes("67193"), "Responses retains original context");
  const responseHistory = (await server._sdkSession.messages(sessionID)).data;
  assert.ok(JSON.stringify(responseHistory).includes("Responses verified."));
  assert.equal(apiErrors.length, 0);
  console.log("native-upgrade: PASS 1.18.29 -> 1.18.30; same session/message IDs; original context; streaming; no duplicate turns; Lily prompt; abort and new work; OpenAI Responses");
} finally {
  holdResponse?.end();
  await stop();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => api.close(resolve));
  await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
