#!/usr/bin/env node
import assert from "node:assert/strict";
import { pipeOpenAiStreamAsAnthropic } from "../server/src/services/model-gateway/openai-adapter.js";

const data = (value) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (text, finish_reason = null) => data({ choices: [{ delta: { content: text }, finish_reason }] });
const usage = data({ choices: [], usage: { prompt_tokens: 19, completion_tokens: 7 } });
async function run(parts, failure = null) {
  const encoder = new TextEncoder();
  let index = 0;
  const upstream = new Response(new ReadableStream({
    pull(controller) {
      if (index < parts.length) {
        const part = parts[index++];
        controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      } else if (failure) controller.error(failure);
      else controller.close();
    },
  }));
  let output = "";
  let ended = 0;
  const usages = [];
  await pipeOpenAiStreamAsAnthropic(upstream, { raw: {
    writeHead() {}, write(part) { output += part; }, end() { ended += 1; },
  } }, { model: "fixture" }, { onUsage: (value) => usages.push(value) });
  return { events: output.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))), ended, usages };
}
function textOf(result) {
  return result.events.filter((event) => event.type === "content_block_delta").map((event) => event.delta.text).join("");
}
function assertFailure(result, partial = "partial") {
  assert.equal(textOf(result), partial, "already received text must survive failure");
  assert.equal(result.events.filter((event) => event.type === "error").length, 1, "failed stream must surface one error");
  assert.equal(result.events.some((event) => event.type === "message_stop"), false, "failure must not announce normal completion");
  assert.equal(result.events.some((event) => event.type === "message_delta"), false);
  assert.equal(result.ended, 1);
}
assertFailure(await run([delta("partial")]));
assertFailure(await run([]), "");
assertFailure(await run([delta("partial"), usage]));
assertFailure(await run([delta("partial"), 'data: {"choices":']), "partial");
assertFailure(await run([delta("partial"), 'data: {"choices":\n\n', delta("", "stop"), "data: [DONE]\n\n"]));

for (const [reason, expected] of [["stop", "end_turn"], ["length", "max_tokens"], ["tool_calls", "tool_use"], ["function_call", "tool_use"], ["content_filter", "content_filter"]]) {
  for (const ending of ["", "data: [DONE]\n\n"]) {
    const result = await run([delta("完整", reason), usage, ending]);
    assert.equal(textOf(result), "完整");
    assert.equal(result.events.filter((event) => event.type === "message_stop").length, 1);
    assert.equal(result.events.find((event) => event.type === "message_delta").delta.stop_reason, expected);
    assert.deepEqual(result.usages, [{ inputTokens: 19, outputTokens: 7, seen: true }]);
    assert.equal(result.events.find((event) => event.type === "message_delta").usage.output_tokens, 7);
  }
}
// Byte fragmentation includes split UTF-8 and CRLF; final data line has no newline.
const fragmented = new TextEncoder().encode((delta("你好") + usage + delta("", "stop").trimEnd()).replaceAll("\n", "\r\n"));
const result = await run([...fragmented].map((byte) => Uint8Array.of(byte)));
assert.equal(textOf(result), "你好");
assert.equal(result.events.at(-1).type, "message_stop");
assert.deepEqual(result.usages, [{ inputTokens: 19, outputTokens: 7, seen: true }]);
const doneOnly = await run([": keep-alive\n\n", delta("partial"), "\n", "data: [DONE]"]);
assert.equal(doneOnly.events.at(-1).type, "message_stop");
assert.deepEqual(doneOnly.usages, [{ inputTokens: 0, outputTokens: 0, seen: false }]);

for (const tail of [data({ error: { message: "upstream failed" } }), 'event: error\ndata: {"message":"upstream failed"}\n\n']) {
  const result = await run([delta("partial"), usage, tail]);
  assertFailure(result);
  assert.deepEqual(result.usages, [{ inputTokens: 19, outputTokens: 7, seen: true }]);
}
for (const reason of ["aborted", "cancelled", "canceled", "error"]) assertFailure(await run([delta("partial", reason), "data: [DONE]\n\n"]));
for (const reason of [true, {}, [], 42, "", "unexpected_reason"]) assertFailure(await run([delta("partial", reason), "data: [DONE]\n\n"]));
assertFailure(await run([delta("partial"), usage], new Error("connection reset")));
assertFailure(await run([delta("partial", "stop")], new Error("connection reset after finish")));
console.log("gateway stream completion: ok");
