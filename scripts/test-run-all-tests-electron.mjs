import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Exercise both real runner branches without recursively launching the suite.
// Only discovery/process boundaries are replaced; command construction and
// failure aggregation execute from the actual runner source.
const url = new URL("./run-all-tests.mjs", import.meta.url);
const source = readFileSync(url, "utf8").replace(/^import .*;$/gm, "")
  .replaceAll("import.meta.url", JSON.stringify(url.href));
function run(chain) {
  const calls = [], logs = [], exits = [];
  vm.runInNewContext(source, {
    path, fileURLToPath,
    createRequire: () => () => ({ scripts: { fixture: "node scripts/test-unit.mjs && npx electron scripts/test-dialog.cjs" } }),
    readdirSync: () => ["test-unit.mjs", "test-dialog.cjs"],
    execSync: (command, options) => {
      calls.push({ command, options });
      if (command.includes("test-dialog.cjs")) throw Object.assign(new Error("timeout"), { stderr: "fixture timeout", code: "ETIMEDOUT" });
    },
    process: { argv: ["node", "runner", ...(chain ? [chain] : [])], exit: code => exits.push(code) },
    console: { log: line => logs.push(line), error: line => logs.push(line) },
  });
  return { calls, logs, exits };
}
for (const chain of [undefined, "fixture"]) {
  const result = run(chain);
  for (const call of result.calls) {
    if (call.command.startsWith("npx electron ")) {
      assert.ok(call.command.includes("--disable-background-timer-throttling"), "hidden Electron tests must not throttle timers");
      assert.ok(call.command.includes("--disable-renderer-backgrounding"), "hidden Electron tests must not use background renderer scheduling");
    } else assert.equal(call.command, "node scripts/test-unit.mjs", "Node commands stay unchanged");
    assert.equal(call.options.timeout, 180000);
    assert.equal(call.options.killSignal, "SIGKILL", "timeout cannot depend on the shell handling SIGTERM");
  }
  assert.deepEqual(result.exits, [1], "timeout remains a failed suite");
  assert.ok(result.logs.some(line => line.includes("fixture timeout")), "failure output remains visible");
  if (!chain) assert.ok(result.calls.at(-1).command.includes("bench-replay-renderer.cjs"), "runner continues after failure through the benchmark");
}
console.log("run-all-tests Electron launch and failure aggregation: passed");
