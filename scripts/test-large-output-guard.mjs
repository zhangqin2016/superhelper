#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(__dirname, "../resources/opencode-plugins/large-output-guard.js"));
const { LargeOutputGuardPlugin } = mod;

// The plugin file must export ONLY the factory (named + default) — the OpenCode
// loader instantiates every export as a plugin, so exporting helper functions
// makes it call them as factories → they return a non-object → `.config` crash →
// every turn fails at createUserMessage. Guard that regression here.
{
  const exported = Object.keys(mod).filter((k) => k !== "default");
  assert.deepEqual(exported, ["LargeOutputGuardPlugin"], `plugin must export only the factory, got: ${exported.join(",")}`);
  assert.equal(typeof mod.default, "function", "default export is the factory");
}

// --- the tool.execute.after hook -------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-tool-guard-"));
const hooks = await LargeOutputGuardPlugin({ directory: tmp });
const hook = hooks["tool.execute.after"];
process.env.LILY_TOOL_OUTPUT_MAX_CHARS = "";

// large {output} string is capped in place and the full text is offloaded
const huge = "H".repeat(50_000);
const out1 = { output: huge };
await hook({ tool: "read" }, out1);
assert.ok(out1.output.length < huge.length, "large {output} tool result is capped for the model");
assert.ok(out1.output.includes("[lily: large tool output externalized]"), "capped output carries the marker");
const sidecarDir = path.join(tmp, ".lily-work", "tool-output");
const files = fs.readdirSync(sidecarDir);
assert.equal(files.length, 1, "full output is written to exactly one sidecar file");
assert.equal(fs.readFileSync(path.join(sidecarDir, files[0]), "utf8"), huge, "sidecar holds the complete original output");

// large {content:[text]} shape
const out2 = { content: [{ type: "text", text: "T".repeat(50_000) }, { type: "image", data: "x" }] };
await hook({ tool: "bash" }, out2);
const joined = out2.content.filter((c) => c.type === "text").map((c) => c.text).join("");
assert.ok(joined.includes("[lily: large tool output externalized]"), "{content} text is capped");
assert.ok(out2.content.some((c) => c.type === "image"), "non-text parts survive");

// small output untouched
const out3 = { output: "tiny" };
await hook({ tool: "read" }, out3);
assert.equal(out3.output, "tiny", "small output is untouched");

// fail-open: bad input never throws / never mutates
const out4 = { output: "S".repeat(50_000) };
await hook(null, out4); // input null still fine
assert.ok(out4.output.includes("[lily: large tool output externalized]") || out4.output.length === 50_000, "null input is handled fail-open");
await hook({ tool: "x" }, null); // null output must not throw
await hook({ tool: "x" }, "raw-string-output"); // non-object output must not throw

// kill switch
process.env.LILY_TOOL_OUTPUT_GUARD = "0";
const out5 = { output: "K".repeat(50_000) };
await hook({ tool: "read" }, out5);
assert.equal(out5.output.length, 50_000, "kill switch disables capping");
delete process.env.LILY_TOOL_OUTPUT_GUARD;

fs.rmSync(tmp, { recursive: true, force: true });

// registered as an engine plugin
const poolSrc = fs.readFileSync(path.join(__dirname, "../src/main/session-runner-pool.js"), "utf8");
assert.ok(poolSrc.includes("large-output-guard.js"), "plugin must be registered in the runner plugin list");

console.log("large-output-guard: ok");
