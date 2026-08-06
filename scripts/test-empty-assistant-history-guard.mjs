#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.join(__dirname, "../resources/opencode-plugins/empty-assistant-history-guard.js");

assert.ok(
  fs.existsSync(pluginPath),
  "an engine transform must repair persisted empty assistant messages before provider requests",
);

const mod = await import(pathToFileURL(pluginPath).href);
const { EmptyAssistantHistoryGuardPlugin } = mod;

{
  const exported = Object.keys(mod).filter((key) => key !== "default");
  assert.deepEqual(
    exported,
    ["EmptyAssistantHistoryGuardPlugin"],
    `plugin must export only the factory, got: ${exported.join(",")}`,
  );
  assert.equal(typeof mod.default, "function", "default export is the factory");
}

const hooks = await EmptyAssistantHistoryGuardPlugin({});
const transform = hooks["experimental.chat.messages.transform"];
assert.equal(typeof transform, "function", "registers the messages.transform hook");

const REPAIR_MARKER = "[lily: previous assistant turn contained no provider-visible response]";

// The customer failure: one persisted empty assistant row poisons every retry.
{
  const messages = [
    { info: { role: "assistant", id: "empty-1" }, parts: [] },
    { info: { role: "user", id: "user-2" }, parts: [{ type: "text", text: "continue" }] },
  ];

  await transform({}, { messages });

  assert.equal(messages.length, 2, "message ordering and ids are preserved");
  assert.deepEqual(
    messages[0].parts,
    [{ type: "text", text: REPAIR_MARKER }],
    "a provider-visible neutral text part repairs the empty assistant row",
  );
  assert.equal(messages[0].info.id, "empty-1", "the persisted message identity is preserved");
}

// Healthy history is byte-identical. Tool-only assistant messages are valid
// protocol records and must not be altered or dropped.
{
  const messages = [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "ready" }] },
    {
      info: { role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "write",
          callID: "call-1",
          state: { status: "completed", input: { path: "/tmp/a" }, output: "ok" },
        },
      ],
    },
    { info: { role: "user" }, parts: [] },
  ];
  const before = JSON.stringify(messages);

  await transform({}, { messages });

  assert.equal(
    JSON.stringify(messages),
    before,
    "non-empty assistant, tool protocol, and non-assistant messages remain byte-identical",
  );
}

// Whitespace, ignored text, reasoning-only, and file-only assistant rows can
// all serialize to empty provider content, so each receives one bounded marker.
{
  const messages = [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "   \n" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "hidden", ignored: true }] },
    { info: { role: "assistant" }, parts: [{ type: "reasoning", text: "internal" }] },
    { role: "assistant", parts: [{ type: "file", mime: "application/octet-stream" }] },
  ];

  await transform({}, { messages });
  await transform({}, { messages });

  for (const message of messages) {
    const markers = message.parts.filter(
      (part) => part?.type === "text" && part.text === REPAIR_MARKER,
    );
    assert.equal(markers.length, 1, "repair is idempotent and adds exactly one marker");
  }
}

// Malformed hook payloads never become a new source of model-call failures.
await transform({}, null);
await transform({}, { messages: null });
await transform({}, { messages: [null, {}, { info: { role: "assistant" }, parts: null }] });
await transform(null, undefined);

// Emergency rollback keeps today's behavior exactly.
{
  process.env.LILY_EMPTY_ASSISTANT_HISTORY_GUARD = "0";
  const messages = [{ info: { role: "assistant" }, parts: [] }];
  await transform({}, { messages });
  assert.deepEqual(messages[0].parts, [], "kill switch leaves empty history untouched");
  delete process.env.LILY_EMPTY_ASSISTANT_HISTORY_GUARD;
}

const poolSource = fs.readFileSync(
  path.join(__dirname, "../src/main/session-runner-pool.js"),
  "utf8",
);
assert.ok(
  poolSource.includes("empty-assistant-history-guard.js"),
  "plugin must be registered in the runner plugin list",
);

console.log("empty-assistant-history-guard: ok");
