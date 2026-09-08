#!/usr/bin/env node
/**
 * A provider quirk no shipped rule knows must be fixable WITHOUT a desktop
 * release: the server delivers a hint in the signed client config, the client
 * caches it with the rest of remote config, and the shape learner applies it.
 * Malformed hints are ignored at every hop.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- server: env → hints, defensively ---------------------------------------
const { parseRequestShapeHints } = await import(pathToFileURL(path.join(root, "server/src/services/request-shape-hints.js")).href);
const hint = { id: "acme-logprobs", when: { message: "logprobs.*not available" }, then: { omit: ["logprobs"] } };
assert.deepEqual(parseRequestShapeHints(JSON.stringify([hint, { nonsense: true }, "x", { id: "no-then", when: {} }])), [hint], "only well-formed hints pass; junk is dropped, not thrown");
assert.deepEqual(parseRequestShapeHints("not json"), []); assert.deepEqual(parseRequestShapeHints(""), []); assert.deepEqual(parseRequestShapeHints(JSON.stringify({ a: 1 })), []);
process.env.MODEL_REQUEST_SHAPE_HINTS_JSON = JSON.stringify([hint]);
process.env.DEEPSEEK_API_KEY ||= "sk-test-deepseek-key-for-config";
const { buildEnvManagedClientConfig } = await import(pathToFileURL(path.join(root, "server/src/services/client-config.js")).href);
const built = buildEnvManagedClientConfig({ deepseekApiKey: "sk-test", modelGatewayDefaultProvider: "deepseek" }, { deepseek: { id: "deepseek", type: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-test", model: "deepseek-v4-pro", headers: {} } });
const delivered = built?.config?.models?.requestShapeHints || built?.models?.requestShapeHints || null;
assert.deepEqual(delivered, [hint], `the env hint rides models.requestShapeHints in the delivered config: ${JSON.stringify(built).slice(0, 300)}`);
delete process.env.MODEL_REQUEST_SHAPE_HINTS_JSON;

// --- client: cached remote config → hints, and the learner uses them ---------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shape-hints-"));
process.env.LILY_USER_DATA_DIR = tmp; process.env.LILY_HOME = os.homedir(); process.env.LILY_DOCUMENTS_DIR = tmp;
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { getPath: () => tmp, isPackaged: false }, safeStorage: { isEncryptionAvailable: () => false } } };
const remoteConfig = require("../src/main/remote-config.js");
assert.deepEqual(remoteConfig.getRemoteRequestShapeHintsSync(), [], "no cache → no hints, no throw");
// The cache is the protected record remote-config itself writes (Base64 form here: the fake keychain is unavailable).
const state = { effectiveConfig: { schemaVersion: 1, models: { source: "service", presets: [], requestShapeHints: [hint, { broken: true }] } } };
fs.writeFileSync(path.join(tmp, "remote-config-cache.json"), JSON.stringify({ config: { encrypted: false, data: Buffer.from(JSON.stringify(state), "utf8").toString("base64") }, updatedAt: new Date().toISOString() }));
remoteConfig.reloadRemoteConfigCache?.();
const hints = remoteConfig.getRemoteRequestShapeHintsSync();
assert.deepEqual(hints, [hint], `client reads exactly the well-formed hints from its cache: ${JSON.stringify(hints)}`);
const shape = require("../src/main/openai-request-shape.js");
// The learner reaches remote-config on its own (default provider) — the real wiring, not an injected stub.
const learned = shape.classifyShapeRejection({ status: 400, error: shape.parseOpenAiError(400, { error: { message: "The logprobs feature is not available on this deployment" } }), shape: null, sentBody: { max_tokens: 8, logprobs: true } });
assert.equal(learned?.reason, "hint:acme-logprobs", `a server-delivered hint fixes a quirk no built-in rule knows: ${JSON.stringify(learned)}`);
assert.deepEqual(learned.shape.omit, ["logprobs"]);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("request shape remote hints: ok");
