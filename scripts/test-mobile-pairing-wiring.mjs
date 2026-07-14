#!/usr/bin/env node
// Static guard: the desktop pairing manager is actually wired into the app —
// IPC handlers registered, preload exposed, admit routed through the selected
// mobile target (defaulting to the active session) via admitExternalCommand
// (never sendUserMessage), and the relay URL delivered by the server. Cheap
// file checks so the wiring can't silently regress.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// IPC module wires the manager to the sanctioned seam, not sendUserMessage.
const ipc = read("src/main/ipc-mobile-pairing.js");
assert.match(ipc, /createMobilePairingManager/, "IPC instantiates the pairing manager");
assert.match(ipc, /admitExternalCommand/, "commands enter via the sanctioned admission seam");
assert.doesNotMatch(ipc, /\.sendUserMessage\s*\(/, "the bridge must NOT call sendUserMessage directly");
assert.match(ipc, /selectedMobileSessionId/, "desktop tracks the phone-selected target session");
assert.match(ipc, /getSessionList/, "bridge exposes the selectable session list");
assert.match(ipc, /selectSession/, "bridge can select the mobile target session");
assert.match(ipc, /findById\?\.\(lilySessionId\)/, "admit validates the selected session before dispatch");
assert.match(ipc, /getActive\?\.\(\)/, "admit still defaults to the currently active Lily session");
assert.match(ipc, /LILY_MOBILE_COMMAND\s*===\s*"0"/, "there is a kill switch");
assert.match(ipc, /manager\.status\(\)/, "status exposes the manager capability contract");
for (const ch of ["create-challenge", "poll-pending", "approve", "deny", "revoke", "status"]) {
  assert.match(ipc, new RegExp(`mobile-pairing:${ch}`), `IPC handler ${ch} registered`);
}

// main.js registers it.
assert.match(read("src/main.js"), /registerMobilePairingIpc/, "main.js registers the pairing IPC");

// preload exposes the renderer surface.
const preload = read("src/preload.js");
for (const m of ["mobilePairingCreateChallenge", "mobilePairingPollPending", "mobilePairingApprove", "mobilePairingDeny", "mobilePairingRevoke", "mobilePairingStatus"]) {
  assert.match(preload, new RegExp(m), `preload exposes ${m}`);
}

// service-client exports the signed fetch the manager needs.
assert.match(read("src/main/service-client.js"), /^\s*serviceFetch,$/m, "service-client exports serviceFetch");

// server delivers the relay URL as a ws(s) origin.
const clientConfig = read("server/src/services/client-config.js");
assert.match(clientConfig, /LILY_MOBILE_RELAY_URL/, "server delivers the mobile relay URL");
assert.match(clientConfig, /\/api\/mobile\/relay/, "relay URL points at the relay endpoint");
assert.match(clientConfig, /replace\(\/\^http\/, "ws"\)/, "relay URL is a ws(s) origin");

console.log("mobile-pairing-wiring: ok");
