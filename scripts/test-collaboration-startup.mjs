import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { initializeCollaborationService } = createRequire(import.meta.url)("../src/main/collaboration/service.js");

let created = 0;
const unavailable = initializeCollaborationService({
  policy: { enabled: false },
  accountStatus: () => ({ loggedIn: true, user: { id: "user-1" } }),
  createService: () => { created += 1; },
  createKeyring: () => ({}),
});
assert.deepEqual(unavailable, { ok: false, code: "COLLABORATION_UNAVAILABLE" });
assert.equal(created, 0, "disabled collaboration must not open a database or keyring");

const signedOut = initializeCollaborationService({
  policy: { enabled: true }, accountStatus: () => ({ loggedIn: false }),
  createService: () => { created += 1; }, createKeyring: () => ({}),
});
assert.deepEqual(signedOut, { ok: false, code: "COLLABORATION_UNAVAILABLE" });
assert.equal(created, 0, "a signed-out user has no local collaboration capability");

const keyring = { encrypt() {}, decrypt() {} };
const ready = initializeCollaborationService({
  policy: { enabled: true }, accountStatus: () => ({ loggedIn: true, user: { id: "user-1" } }),
  createKeyring: () => keyring,
  createService: ({ storeOptions }) => ({ ok: true, storeOptions }),
});
assert.equal(ready.ok, true);
assert.equal(ready.storeOptions.accountId, "user-1");
assert.equal(ready.storeOptions.keyring, keyring, "account service is only constructed after account identity is available");

const degraded = initializeCollaborationService({
  policy: { enabled: true }, accountStatus: () => ({ loggedIn: true, user: { id: "user-1" } }),
  createKeyring: () => { throw new Error("locked"); },
});
assert.deepEqual(degraded, { ok: false, code: "COLLABORATION_UNAVAILABLE" }, "keyring failure remains isolated from Electron startup");

console.log("collaboration startup checks passed");
