#!/usr/bin/env node
/**
 * Run with: npx electron scripts/test-runtime-node.cjs
 */
const { spawnSync } = require("node:child_process");
const { app } = require("electron");
const { ensureRuntimeNodeShim, resolveRuntimeNodePath } = require("../src/main/runtime-node");

function run() {
  ensureRuntimeNodeShim();
  const shim = resolveRuntimeNodePath();
  // The Windows shim is a .cmd batch file — spawnSync can't exec it directly
  // (EINVAL); invoke it through the shell as a PATH lookup would. Quote it so a
  // shim path containing spaces survives cmd.exe.
  const isWin = process.platform === "win32";
  const result = spawnSync(isWin ? `"${shim}"` : shim, ["-p", "process.version"], { encoding: "utf8", shell: isWin });

  if (result.error || result.status !== 0) {
    console.error("runtime-node shim failed:", result.error || result.stderr);
    process.exit(1);
  }

  const version = result.stdout.trim();
  const major = Number.parseInt(version.slice(1), 10);
  if (!Number.isFinite(major) || major < 18) {
    console.error("runtime-node shim too old:", version);
    process.exit(1);
  }

  // yargs/commander read argv as Node's through the shim — the release that
  // stopped on "Unknown argument: …/.bin/electron-builder" (2026-09-27).
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-shim-argv-"));
  const script = path.join(dir, "cli.cjs");
  fs.writeFileSync(script, `const y = require(${JSON.stringify(require.resolve("yargs/yargs"))});
const { hideBin } = require(${JSON.stringify(require.resolve("yargs/helpers"))});
const argv = y(hideBin(process.argv)).strict().option("mac", { type: "boolean" }).fail((m) => { console.log("FAIL " + m); process.exit(3); }).parse();
console.log("OK " + JSON.stringify(argv._) + " " + argv.mac);`);
  const runCli = () => spawnSync(isWin ? `"${shim}"` : shim, [script, "--mac"], { encoding: "utf8", shell: isWin });
  const parsed = runCli();
  if (parsed.status !== 0 || !/OK \[\] true/.test(parsed.stdout)) {
    console.error("runtime-node shim: a yargs CLI misread its arguments:", parsed.stdout, parsed.stderr);
    process.exit(1);
  }
  // Without the compat file the shim still runs — as plain Electron-as-Node.
  const { argvCompatPath } = require("../src/main/runtime-node");
  fs.rmSync(argvCompatPath(), { force: true });
  const plain = spawnSync(isWin ? `"${shim}"` : shim, ["-p", "process.version"], { encoding: "utf8", shell: isWin });
  if (plain.status !== 0 || !/^v\d+/.test(plain.stdout.trim())) {
    console.error("runtime-node shim: no fallback without the compat preload:", plain.stderr);
    process.exit(1);
  }
  ensureRuntimeNodeShim();
  if (!fs.existsSync(argvCompatPath())) {
    console.error("runtime-node shim: the compat preload was not restored");
    process.exit(1);
  }
  fs.rmSync(dir, { recursive: true, force: true });

  console.log("runtime-node: ok", version, "(argv-compatible)");
}

app.whenReady().then(() => {
  run();
  app.quit();
});
