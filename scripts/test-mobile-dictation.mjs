#!/usr/bin/env node
// Dictation on the phone (web/lib/mobile/dictation.mjs + use-voice-input.js).
// Field case: 语音太难用 — nothing on screen while speaking, the last sentence
// lost on stop, silent failures, audio sent as parallel requests that could
// arrive out of order, and on iOS an AudioContext created after the tap
// stays suspended. This holds the pure part and the hook's shape.
// [gate: mobile-dictation]
// Run: node scripts/test-mobile-dictation.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/dictation.mjs")).href);

let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

await check("the transcript renders live: typed text, then confirmed speech, then what is being said", () => {
  let s = d.begin(d.initialDictation(""), "先写好的 ");
  assert.equal(s.phase, "connecting");
  s = d.onAsrEvent(s, { kind: "ready" }).state;
  assert.equal(s.phase, "listening");
  s = d.onAsrEvent(s, { kind: "partial", text: "帮我查", stash: "一" }).state;
  assert.equal(d.transcript(s), "先写好的 帮我查一", "interim text shows while speaking");
  s = d.onAsrEvent(s, { kind: "final", transcript: "帮我查一下日志" }).state;
  assert.equal(d.transcript(s), "先写好的 帮我查一下日志", "the final replaces the interim");
  s = d.onAsrEvent(s, { kind: "partial", text: "然后" }).state;
  assert.equal(d.transcript(s), "先写好的 帮我查一下日志然后");
  assert.equal(d.spoken(s), "帮我查一下日志然后");
  assert.equal(d.onAsrEvent(s, { kind: "vad", speaking: true }).state.speaking, true);
});

await check("stop keeps listening for the relay's last words; only 'finished' ends it", () => {
  let s = d.onAsrEvent(d.begin(d.initialDictation(""), ""), { kind: "ready" }).state;
  s = d.onAsrEvent(s, { kind: "final", transcript: "第一句。" }).state;
  s = d.finishing(s);
  assert.equal(s.phase, "finishing");
  const late = d.onAsrEvent(s, { kind: "final", transcript: "最后一句。" });
  assert.equal(late.ended, undefined, "a final after stop is still taken");
  assert.equal(d.transcript(late.state), "第一句。最后一句。", "the last sentence is not lost");
  const end = d.onAsrEvent(late.state, { kind: "finished" });
  assert.equal(end.ended, true);
  assert.equal(end.state.phase, "idle");
  assert.equal(d.transcript(end.state), "第一句。最后一句。");
});

await check("an error ends it and is named; an idle state ignores stray events", () => {
  const s = d.onAsrEvent(d.begin(d.initialDictation(""), ""), { kind: "error", code: "ASR_CONNECT_FAILED" });
  assert.equal(s.ended, true);
  assert.equal(s.state.error, "ASR_CONNECT_FAILED");
  assert.equal(s.state.phase, "idle");
  const idle = d.initialDictation("x");
  assert.equal(d.onAsrEvent(idle, { kind: "final", transcript: "late" }).state, idle, "nothing after it ended");
});

await check("audio leaves in order, batched, one request at a time", async () => {
  const sent = [];
  let inFlight = 0, maxInFlight = 0;
  const post = async (chunks) => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); sent.push(chunks); inFlight -= 1; };
  const q = d.createAudioQueue({ post, flushMs: 10 });
  for (let i = 0; i < 12; i += 1) { q.push(`c${i}`); if (i % 4 === 3) await new Promise((r) => setTimeout(r, 15)); }
  await q.drain();
  assert.deepEqual(sent.flat(), Array.from({ length: 12 }, (_, i) => `c${i}`), "every chunk, in order");
  assert.ok(sent.length < 12, "batched, not one request per buffer");
  assert.equal(maxInFlight, 1, "never two requests racing (order kept)");
  q.push("after-drain");
  await q.drain();
  assert.ok(!sent.flat().includes("after-drain"), "nothing after stop");
});

await check("resampling averages the window (no aliasing) and maps to PCM16", () => {
  const inRate = 48000;
  const input = new Float32Array(4800); // 100 ms
  for (let i = 0; i < input.length; i += 1) input[i] = Math.sin((2 * Math.PI * 440 * i) / inRate);
  const pcm = d.resampleTo16k(input, inRate);
  assert.equal(pcm.length, 1600, "100 ms at 16 kHz");
  const peak = Math.max(...pcm);
  assert.ok(peak > 20000 && peak <= 32767, "full-scale tone survives the averaging");
  const dc = new Float32Array(480).fill(0.5);
  assert.ok(d.resampleTo16k(dc, inRate).every((v) => Math.abs(v - 16383) <= 2), "a constant stays constant");
  assert.equal(d.resampleTo16k(new Float32Array(0), inRate).length, 0);
  assert.equal(d.pcmToBase64(new Int16Array([1, -1])), "AQD//w==");
});

await check("the hook does the things that made it unusable", () => {
  const hook = fs.readFileSync(path.join(ROOT, "web/components/mobile/use-voice-input.js"), "utf8");
  assert.match(hook, /const ctx = AC \? new AC\(\) : null; \/\/ in the tap, for iOS/, "AudioContext created in the tap, before any await");
  assert.match(hook, /await ctx\.resume\(\)/, "and resumed");
  assert.match(hook, /createAudioQueue\(\{/, "audio through the ordered queue");
  assert.match(hook, /JSON\.stringify\(\{ chunks \}\)/, "batched chunks, the relay's `chunks` form");
  assert.match(hook, /await a\.queue\.drain\(\);\s*\n\s*fetch\(`\$\{a\.base\}\/llm\/asr\/sessions\/\$\{a\.sessionId\}\/finish`/, "finish only after the audio is out");
  assert.match(hook, /FINISH_WAIT_MS/, "and then waits (bounded) for the relay's last words");
  assert.match(hook, /ERROR_TEXT\[state\.error\]/, "errors are said");
  assert.doesNotMatch(hook, /onText/, "the transcript is rendered as a whole, not appended piecemeal");
  const composer = fs.readFileSync(path.join(ROOT, "web/components/mobile/chat-screen.js"), "utf8");
  assert.match(composer, /onValue: setText/, "the composer shows the transcript live");
  assert.match(composer, /voice\.phase === "finishing"/, "and says when it is finishing");
});

console.log(`\n${checks} checks passed (mobile dictation)`);
