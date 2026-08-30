#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-collab-keyring-"));
const filePath = path.join(dir, "keys.json");
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
  decryptString: (value) => {
    const text = Buffer.from(value).toString("utf8");
    if (!text.startsWith("protected:")) throw new Error("bad protected value");
    return text.slice("protected:".length);
  },
};

const alice = new LocalCollaborationKeyring({ filePath, safeStorage });
const bob = new LocalCollaborationKeyring({ filePath, safeStorage });
const envelope = alice.encrypt({
  accountId: "alice",
  scopeId: "team:design",
  recordId: "draft-1",
  plaintext: "only Alice's design team can read this",
});

assert.equal(JSON.stringify(envelope).includes("only Alice's design team"), false, "ciphertext envelope never stores plaintext");
assert.equal(
  alice.decrypt({ accountId: "alice", scopeId: "team:design", recordId: "draft-1", envelope }),
  "only Alice's design team can read this",
  "the same account can decrypt its local cache after restart",
);
assert.throws(
  () => bob.decrypt({ accountId: "bob", scopeId: "team:design", recordId: "draft-1", envelope }),
  (error) => error?.code === "COLLAB_LOCAL_KEY_UNAVAILABLE",
  "account master keys must be isolated even when the cache database is shared",
);
assert.throws(
  () => alice.decrypt({ accountId: "alice", scopeId: "team:design", recordId: "draft-2", envelope }),
  (error) => error?.code === "COLLAB_LOCAL_CIPHERTEXT_INVALID",
  "AES-GCM AAD binds ciphertext to its record id",
);

alice.destroyScopeKey({ accountId: "alice", scopeId: "team:design" });
assert.throws(
  () => alice.decrypt({ accountId: "alice", scopeId: "team:design", recordId: "draft-1", envelope }),
  (error) => error?.code === "COLLAB_LOCAL_KEY_UNAVAILABLE",
  "team revocation destroys the scope key and makes cached Team payloads unreadable",
);

const unavailable = new LocalCollaborationKeyring({
  filePath: path.join(dir, "unavailable.json"),
  safeStorage: { isEncryptionAvailable: () => false },
});
assert.throws(
  () => unavailable.encrypt({ accountId: "alice", scopeId: "personal", recordId: "r1", plaintext: "never write a fallback" }),
  (error) => error?.code === "COLLAB_LOCAL_KEYRING_UNAVAILABLE",
  "a missing OS keyring fails closed instead of writing recoverable plaintext/base64",
);

fs.rmSync(dir, { recursive: true, force: true });
console.log("collaboration local keyring: ok");
