import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { compactCapabilityContext } = await import("../src/main/capability-broker.js");
const { buildRuntimePackAdvisory } = require("../src/main/runtime-pack-preflight.js");

const context = compactCapabilityContext({ maxChars: 3000 });
assert.ok(context.includes("dependency.install"));
assert.ok(context.includes("lily_process_jobs"));
assert.ok(context.includes("continue with bundled capabilities"));
assert.ok(context.includes("Long installs must run through lily_process_jobs"));
assert.ok(!context.includes("Open Settings first"));
assert.ok(!context.includes("block the user"));

const advisory = buildRuntimePackAdvisory({
  missingPacks: [{ id: "web-automation" }],
  installingPacks: [],
});
assert.ok(advisory.includes("Do not block the user turn"));
assert.ok(advisory.includes("choose the best route yourself"));
assert.ok(advisory.includes("lily_process_jobs"));
assert.ok(advisory.includes("safe fallback"));

const root = path.resolve(new URL("..", import.meta.url).pathname);
const orchestratorSource = fs.readFileSync(path.join(root, "src/main/turn-orchestrator.js"), "utf8");
assert.ok(orchestratorSource.includes("compactCapabilityContext"));
assert.match(orchestratorSource, /platformContextParts\.push\(capabilityContext\)/);

const composerSource = fs.readFileSync(path.join(root, "src/renderer/modules/composer.js"), "utf8");
assert.doesNotMatch(composerSource, /runtime-pack-preflight-ui/);
assert.doesNotMatch(composerSource, /ensureRuntimePacks/);
assert.doesNotMatch(composerSource, /preflightRuntimePacks/);

console.log("chat-native-dependency-flow: ok");
