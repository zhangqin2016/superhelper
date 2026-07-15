#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(__dirname, "../resources/opencode-plugins/filepart-text-coercion.js"));
const { FilePartTextCoercionPlugin } = mod;

// The plugin file must export ONLY the factory (named + default) — the OpenCode
// loader instantiates every export as a plugin, so exporting a helper makes it
// call the helper as a factory → crash. Guard that regression (see large-output-guard).
{
  const exported = Object.keys(mod).filter((k) => k !== "default");
  assert.deepEqual(exported, ["FilePartTextCoercionPlugin"], `plugin must export only the factory, got: ${exported.join(",")}`);
  assert.equal(typeof mod.default, "function", "default export is the factory");
}

const hooks = await FilePartTextCoercionPlugin({});
const transform = hooks["experimental.chat.messages.transform"];
assert.equal(typeof transform, "function", "registers the messages.transform hook");

const dataUrl = (mime, text) => `data:${mime};base64,${Buffer.from(text, "utf8").toString("base64")}`;

// --- the actual bug: a JSON file part poisons image-only providers -----------
{
  const jsonText = JSON.stringify({ places: [{ id: 1, name: "Dubai" }] });
  const msgs = [
    {
      info: { role: "user" },
      parts: [
        { type: "text", text: "summarize this" },
        { type: "file", mime: "application/json", filename: "data.json", url: dataUrl("application/json", jsonText) },
      ],
    },
  ];
  await transform({}, { messages: msgs });
  const parts = msgs[0].parts;
  assert.equal(parts.filter((p) => p.type === "file").length, 0, "the JSON file part is gone — nothing the model can reject remains");
  const coerced = parts[1];
  assert.equal(coerced.type, "text", "the JSON file part became a text part");
  assert.match(coerced.text, /\[Attached application\/json: data\.json\]/, "the coerced text is labeled");
  assert.match(coerced.text, /"places"/, "the JSON content is preserved inline — nothing lost");
  assert.equal("url" in coerced, false, "the raw file url is removed");
  assert.equal("mime" in coerced, false, "the file mime is removed");
  assert.equal(parts[0].text, "summarize this", "sibling text parts are untouched");
}

// --- images and PDFs are LEFT ALONE (vision/pdf-capable models take them) -----
{
  const msgs = [
    {
      info: { role: "user" },
      parts: [
        { type: "file", mime: "image/png", filename: "shot.png", url: "data:image/png;base64,iVBOR" },
        { type: "file", mime: "application/pdf", filename: "doc.pdf", url: "data:application/pdf;base64,JVBER" },
      ],
    },
  ];
  await transform({}, { messages: msgs });
  assert.equal(msgs[0].parts.every((p) => p.type === "file"), true, "image and pdf parts are preserved for capable models");
}

// --- text/plain is left to the engine's own handling ------------------------
{
  const msgs = [{ info: { role: "user" }, parts: [{ type: "file", mime: "text/plain", filename: "n.txt", url: dataUrl("text/plain", "hi") }] }];
  await transform({}, { messages: msgs });
  assert.equal(msgs[0].parts[0].type, "file", "text/plain file parts are left for the engine to convert");
}

// --- non-textual, non-media file parts become a NOTE, not decoded garbage ----
{
  const msgs = [{ info: { role: "user" }, parts: [{ type: "file", mime: "application/zip", filename: "a.zip", url: "data:application/zip;base64,UEsD" }] }];
  await transform({}, { messages: msgs });
  const p = msgs[0].parts[0];
  assert.equal(p.type, "text", "a binary file part is still coerced away from a raw file part");
  assert.match(p.text, /not inlined as a raw file part/, "binary file parts become an explanatory note, not garbage");
  assert.doesNotMatch(p.text, /```/, "binary note does not fence random bytes");
}

// --- oversized textual content is bounded -----------------------------------
{
  process.env.LILY_FILEPART_TEXT_MAX_CHARS = "";
  const big = "X".repeat(100_000);
  const msgs = [{ info: { role: "user" }, parts: [{ type: "file", mime: "application/json", filename: "big.json", url: dataUrl("application/json", big) }] }];
  await transform({}, { messages: msgs });
  const p = msgs[0].parts[0];
  assert.equal(p.type, "text", "oversized JSON is coerced to text");
  assert.ok(p.text.length < big.length, "oversized content is bounded, not inlined whole");
  assert.match(p.text, /chars omitted to keep the model context small/, "the omission is disclosed");
}

// --- compaction re-reads the SAME hook: a poisoned history self-heals --------
// (compaction.ts triggers this exact hook on structuredClone(history) before
// toModelMessages, so a stored JSON file part is coerced there too.)
{
  const msgs = [
    { info: { role: "user" }, parts: [{ type: "file", mime: "application/geo+json", filename: "areas.geojson", url: dataUrl("application/geo+json", '{"type":"FeatureCollection"}') }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] },
  ];
  await transform({}, { messages: msgs });
  assert.equal(msgs[0].parts[0].type, "text", "stored geo+json in history is coerced during compaction");
  assert.match(msgs[0].parts[0].text, /FeatureCollection/, "history content survives the compaction transform");
}

// --- fail-open: bad input never throws --------------------------------------
await transform({}, null);
await transform({}, { messages: null });
await transform({}, { messages: [null, { parts: null }, {}] });
await transform(null, undefined);

// --- kill switch ------------------------------------------------------------
{
  process.env.LILY_FILEPART_COERCE = "0";
  const msgs = [{ info: { role: "user" }, parts: [{ type: "file", mime: "application/json", filename: "d.json", url: dataUrl("application/json", "{}") }] }];
  await transform({}, { messages: msgs });
  assert.equal(msgs[0].parts[0].type, "file", "kill switch leaves parts untouched");
  delete process.env.LILY_FILEPART_COERCE;
}

// registered as an engine plugin
const poolSrc = fs.readFileSync(path.join(__dirname, "../src/main/session-runner-pool.js"), "utf8");
assert.ok(poolSrc.includes("filepart-text-coercion.js"), "plugin must be registered in the runner plugin list");

console.log("filepart-text-coercion: ok");
