import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ipc = fs.readFileSync(path.join(root, "src/main/ipc-collaboration.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
const service = fs.readFileSync(path.join(root, "src/main/collaboration/service.js"), "utf8");

for (const action of ["edit", "revoke"]) {
  assert.match(ipc, new RegExp(`collaboration:${action}`), `${action} has a constrained IPC command`);
  assert.match(preload, new RegExp(`${action}:`), `${action} is exposed only through preload`);
  assert.match(service, new RegExp(`async ${action}\\(`), `${action} is owned by the main-process service`);
}
assert.match(ipc, /clientCommandId/, "mutation commands require a stable idempotency key");
assert.match(ipc, /expectedRevision/, "edit and revoke use optimistic concurrency revisions");
console.log("collaboration interaction command checks passed");
