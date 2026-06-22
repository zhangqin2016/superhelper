#!/usr/bin/env node
/**
 * Why this matters: a workspace app carries executable skills/scripts, so the
 * client verifies a publisher signature over {appId, sha256} before installing.
 * The server signs (security.signWorkspaceApp) and the desktop client verifies
 * (crypto-signing.verifyDetached) — INDEPENDENT implementations. They interop
 * only if both canonicalize identically (stableStringify) and use the same
 * encoding (base64url) + algorithm (ed25519, null). These pin that, and that a
 * tampered sha256 / wrong key is rejected.
 */
import crypto from "node:crypto";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = module.createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { verifyDetached, signDetached, stableStringify: clientStable } = require(
  path.join(ROOT, "src/main/crypto-signing.js"),
);
// Server canonicalizer (ESM) — must match the client's byte-for-byte.
const { stableStringify: serverStable } = await import(path.join(ROOT, "server/src/services/security.js"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. The two stableStringify implementations must agree, or no signature interops.
const payload = { appId: "daily-stock-analysis", sha256: "a".repeat(64) };
const reordered = { sha256: "a".repeat(64), appId: "daily-stock-analysis" };
assert(clientStable(payload) === serverStable(payload), "client/server stableStringify must match");
assert(clientStable(payload) === serverStable(reordered), "stableStringify must be key-order independent");

// 2. ed25519 round-trip: a signature made the server's way verifies the client's way.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const pubPem = publicKey.export({ type: "spki", format: "pem" });
// signWorkspaceApp(payload) ≡ crypto.sign(null, stableStringify(payload), key) + base64url,
// which is exactly what signDetached does — so reuse it as the server-side stand-in.
const signature = signDetached(payload, privPem);
assert(verifyDetached(payload, signature, pubPem) === true, "valid signature must verify");

// 3. Rejections: tampered content, wrong key, missing signature.
assert(verifyDetached({ appId: payload.appId, sha256: "b".repeat(64) }, signature, pubPem) === false, "tampered sha256 must fail");
assert(verifyDetached({ appId: "other-app", sha256: payload.sha256 }, signature, pubPem) === false, "swapped appId must fail");
const otherPub = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
assert(verifyDetached(payload, signature, otherPub) === false, "wrong key must fail");
assert(verifyDetached(payload, "", pubPem) === false, "missing signature must fail");

console.log("app-signature: ok");
