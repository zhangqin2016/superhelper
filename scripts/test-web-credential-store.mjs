#!/usr/bin/env node
/**
 * Website credential vault core (#1b). WHY each assertion matters: this stores user
 * PASSWORDS, so the security invariants are the whole point — the plaintext must
 * never appear on disk or in any public/listing view, and must only be retrievable
 * via the explicit main-process getCredentialWithSecret(). Domain matching is what
 * lets a stale-session re-login find the right credential for a request URL.
 *
 * (No Electron here, so safeStorage is unavailable and protectSecret uses its
 *  base64 fallback — the plaintext is still NOT stored verbatim, which is what we
 *  assert; real builds add OS-keychain encryption on top.)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebCredentialStore } = require("../src/main/web-credential-store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-webcred-"));
const filePath = path.join(dir, "creds.json");
let clock = 0;
const store = new WebCredentialStore({ filePath, now: () => `t${(clock += 1)}` });

const PASSWORD = "S3cret-Pa55!";
const pub = store.saveCredential({ domain: "https://erp.example.com/login", loginUrl: "https://erp.example.com/login", username: "alice", password: PASSWORD });

// Public view carries no secret, only secretSet.
assert.equal(pub.domain, "erp.example.com", "domain normalized to hostname");
assert.equal(pub.username, "alice");
assert.equal(pub.secretSet, true, "secret is set");
assert.equal(pub.password, undefined, "public view never includes the password");
assert.equal(pub.secretProtected, undefined, "public view never includes the protected record");

// Listing is also secret-free.
const list = store.listCredentialsPublic();
assert.equal(list.length, 1);
assert.equal(list[0].secretSet, true);
assert.equal(list[0].password, undefined, "listing never includes the password");

// THE security invariant: the plaintext password must not be on disk.
const onDisk = fs.readFileSync(filePath, "utf8");
assert.ok(!onDisk.includes(PASSWORD), "plaintext password is NEVER written to disk");
assert.ok(/secretProtected/.test(onDisk), "stored as a protected record");

// Main-process retrieval round-trips the real password.
const withSecret = store.getCredentialWithSecret("erp.example.com");
assert.equal(withSecret.password, PASSWORD, "getCredentialWithSecret returns the real password (main process only)");

// Domain matching for re-login lookup: exact + subdomain.
assert.equal(store.findCredentialForUrl("https://erp.example.com/api/orders")?.domain, "erp.example.com", "matches exact host");
assert.equal(store.findCredentialForUrl("https://sso.erp.example.com/auth")?.domain, "erp.example.com", "matches subdomain");
assert.equal(store.findCredentialForUrl("https://other.com/x"), null, "no match for an unrelated host");

// Upsert: blank password keeps the stored secret; new password replaces it.
store.saveCredential({ domain: "erp.example.com", username: "alice2" });
assert.equal(store.getCredentialWithSecret("erp.example.com").password, PASSWORD, "blank password keeps the existing secret");
assert.equal(store.listCredentialsPublic()[0].username, "alice2", "other fields update");
store.saveCredential({ domain: "erp.example.com", password: "new-pass" });
assert.equal(store.getCredentialWithSecret("erp.example.com").password, "new-pass", "new password replaces the old one");
assert.equal(store.listCredentialsPublic().length, 1, "still one credential for the domain (upsert, not append)");

// Delete.
assert.equal(store.deleteCredential("erp.example.com"), true, "delete reports success");
assert.equal(store.listCredentialsPublic().length, 0, "credential removed");
assert.equal(store.getCredentialWithSecret("erp.example.com"), null, "nothing to retrieve after delete");

fs.rmSync(dir, { recursive: true, force: true });
console.log("web-credential-store: ok");
