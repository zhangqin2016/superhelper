#!/usr/bin/env node
// Mobile Command layering, held by the source: the desktop port is the only
// module that touches Lily's internals; phone tasks enter only through the
// admission seam; nothing polls; the old per-pairing modules stay gone.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const dir = path.join(ROOT, "src/main/mobile");
// Code only: comments may explain what a module deliberately does NOT do.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const modules = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => [f, code(read(`src/main/mobile/${f}`))]));

// Only the port reaches into ctx / the orchestrator / sessions.
for (const [file, src] of Object.entries(modules)) {
  if (file === "desktop-port.js" || file === "index.js") continue;
  assert.doesNotMatch(src, /\bctx\./, `${file} must not touch ctx — go through the desktop port`);
  assert.doesNotMatch(src, /turnOrchestrator|sessionManager|projectManager/, `${file} must not reach Lily internals`);
}
const port = modules["desktop-port.js"];
assert.match(port, /admitExternalCommand\(envelope\)/, "phone tasks enter through the admission seam");
for (const [file, src] of Object.entries(modules)) {
  assert.doesNotMatch(src, /\.sendUserMessage\s*\(/, `${file} must never bypass admission`);
  assert.doesNotMatch(src, /setInterval\(/, `${file}: the desktop never polls the server (state is pushed)`);
}

// Transport knows no domain; the controller knows no transport.
assert.doesNotMatch(modules["control-channel.js"], /admit|session|project/i, "the channel is transport only");
assert.doesNotMatch(modules["phone-controller.js"], /WebSocket|relay/i, "the controller is transport-free");
assert.doesNotMatch(modules["phone-directory.js"], /require\(/, "the directory is pure");

// Composition root: kill switch, one registration, the pushed-state IPC.
const index = modules["index.js"];
assert.match(index, /LILY_MOBILE_COMMAND === "0"/, "kill switch");
for (const channel of ["mobile:get-state", "mobile:create-challenge", "mobile:create-direct-code", "mobile:approve", "mobile:deny", "mobile:revoke"]) {
  assert.match(index, new RegExp(`"${channel}"`), `IPC ${channel}`);
}
assert.match(index, /"mobile:state"/, "state is pushed to the renderer");
assert.match(read("src/main.js"), /require\("\.\/main\/mobile"\)\.registerMobileCommand\(appContext\)/, "main registers the composition root");

// Preload: the pushed-state surface, nothing of the old polling one.
const preload = read("src/preload.js");
for (const name of ["mobileGetState", "mobileCreateChallenge", "mobileCreateDirectCode", "mobileApprove", "mobileDeny", "mobileRevoke", "onMobileState"]) {
  assert.match(preload, new RegExp(`${name}:`), `preload exposes ${name}`);
}
assert.doesNotMatch(preload, /mobilePairing|mobile-pairing:/, "the old per-pairing surface is gone");

// The replaced modules stay deleted.
for (const gone of ["mobile-pairing-manager.js", "mobile-agent-bridge.js", "ipc-mobile-pairing.js", "mobile-projection.js", "mobile-session-view.js", "mobile-attachments.js"]) {
  assert.ok(!fs.existsSync(path.join(ROOT, "src/main", gone)), `src/main/${gone} was replaced by src/main/mobile/`);
}

// The server speaks the control channel it advertises.
assert.match(read("server/src/services/mobile-command-capabilities.js"), /relay: \{ controlChannel: 2 \}/);
assert.match(read("server/src/routes/public/mobile.js"), /publishGrantState/, "every pairing change reaches the live channel");

console.log("mobile-command-wiring: ok");
