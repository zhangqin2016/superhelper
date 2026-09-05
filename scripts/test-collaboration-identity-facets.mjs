#!/usr/bin/env node
/**
 * A person without a nickname must still be recognisable — by the enterprise
 * login they were issued or by their phone with the middle masked — and never
 * by an opaque id. This covers the data path: the server masks the phone before
 * a row leaves; the local cache stores the two facets on every profile surface
 * (directory contacts, team members, conversation profiles); older servers
 * that omit them still load.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { replaceDirectory, getDirectory, profile } = require("../src/main/collaboration/directory-projection");
const { applyAuthorizedConversation } = require("../src/main/collaboration/conversation-hydration");

// ---- server-side masking -------------------------------------------------
const { maskPhoneE164, withIdentityFields } = await import(pathToFileURL(path.join(root, "server/src/services/collaboration/identity-fields.js")).href);
assert.equal(maskPhoneE164("+8613812345678"), "138****5678", "CN number: national prefix, four stars, last four");
assert.equal(maskPhoneE164("+14155550123"), "141****0123", "shorter numbers keep the same shape");
assert.equal(maskPhoneE164(""), null); assert.equal(maskPhoneE164(null), null); assert.equal(maskPhoneE164("13812345678"), null, "not E.164 → nothing, never a guess");
const masked = withIdentityFields({ user_id: "u1", display_name: "", login_name: "max_0001", phone_e164: "+8613812345678" });
assert.equal(masked.login_name, "max_0001"); assert.equal(masked.phone_masked, "138****5678");
assert.equal("phone_e164" in masked, false, "the raw number never survives the projection");
const plain = { user_id: "u2", display_name: "Old" };
assert.equal(withIdentityFields(plain), plain, "a row from an older schema passes through untouched");
assert.doesNotMatch(JSON.stringify(withIdentityFields({ user_id: "u3", phone_e164: "+8613812345678" })), /13812345678/);

// ---- local cache ---------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-identity-facets-"));
const store = new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, "keys"), safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() } }) });
try {
  assert.deepEqual(profile({ user_id: "bob", display_name: "" }), { userId: "bob", lilyId: "", displayName: "", avatarObjectId: null, loginName: "", phoneMasked: "" }, "absent facets normalise to empty strings, not undefined");
  assert.throws(() => profile({ user_id: "bob", phone_masked: 42 }), /invalid/i, "a non-string facet is rejected like every other field");

  store.db.transaction(() => replaceDirectory(store, {
    directorySchemaVersion: 1,
    profile: { user_id: "alice", lily_id: "alice-id", display_name: "Alice", login_name: "alice_admin", phone_masked: "139****0000" },
    relationships: [{ user_low_id: "alice", user_high_id: "bob", status: "active" }],
    friendRequests: [], blocks: [],
    profiles: [{ user_id: "bob", lily_id: "", display_name: "", login_name: "", phone_masked: "138****5678" }],
    teams: [{ id: "org", status: "active", name: "Acme", role: "admin" }],
    teamMembers: [
      { organization_id: "org", user_id: "alice", role: "admin", display_name: "Alice", login_name: "alice_admin", phone_masked: "139****0000" },
      { organization_id: "org", user_id: "max", role: "member", display_name: "", lily_id: "", login_name: "max_0001", phone_masked: "" },
      { organization_id: "org", user_id: "legacy", role: "member", display_name: "Legacy" }, // older server: no facets at all
    ],
  }))();
  const directory = getDirectory(store);
  assert.equal(directory.profile.loginName, "alice_admin"); assert.equal(directory.profile.phoneMasked, "139****0000");
  const bob = directory.contacts.find((c) => c.userId === "bob");
  assert.equal(bob.phoneMasked, "138****5678", "a friend without nickname keeps the masked phone");
  const members = Object.fromEntries(directory.teams[0].members.map((m) => [m.userId, m]));
  assert.equal(members.max.loginName, "max_0001", "an issued enterprise account shows its login");
  assert.equal(members.legacy.loginName, ""); assert.equal(members.legacy.phoneMasked, "", "legacy rows load with empty facets");

  // Conversation hydration carries the facets into `profiles` too (thread header, sender names).
  applyAuthorizedConversation(store, "conv-1", {
    conversation: { id: "conv-1", scopeType: "personal", kind: "direct", title: "", visibility: "private" },
    members: [{ user_id: "alice", conversation_id: "conv-1", status: "active", role: "member", joined_seq: 0 },
      { user_id: "bob", conversation_id: "conv-1", status: "active", role: "member", joined_seq: 0 }],
    profiles: [{ user_id: "bob", display_name: "", login_name: "", phone_masked: "138****5678" }],
  });
  const bobProfile = store.getProfile({ userId: "bob" });
  assert.equal(bobProfile.phoneMasked, "138****5678"); assert.equal(bobProfile.loginName, "");
  assert.doesNotMatch(JSON.stringify(directory), /\+86|13812345678/, "no raw number anywhere in the cache view");
  console.log("collaboration identity facets: ok");
} finally {
  store.close?.(); fs.rmSync(dir, { recursive: true, force: true });
}
