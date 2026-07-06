#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.MODEL_GATEWAY_ENABLED = "true";
process.env.MODEL_GATEWAY_TOKEN_SECRET = "test-media-contract-secret";
process.env.LILY_MEDIA_IMAGE_ENDPOINT = "http://127.0.0.1:18012/generate";
process.env.LILY_MEDIA_VIDEO_ENDPOINT = "http://127.0.0.1:18010/generate";
process.env.LILY_MEDIA_SPEECH_ENDPOINT = "http://127.0.0.1:18013/generate";
process.env.MEDIA_IMAGE_PROVIDER = "lily";
process.env.MEDIA_VIDEO_PROVIDER = "lily";
process.env.MEDIA_SPEECH_PROVIDER = "lily";

const { buildMediaProviderContracts } = await import("../server/src/services/media-provider-contracts.js");
const { withGatewayRuntimeConfig } = await import("../server/src/services/client-config.js");

const contracts = buildMediaProviderContracts({
  selected: { image: "lily", video: "lily", speech: "lily" },
  available: { image: ["lily"], video: ["lily"], speech: ["lily"] },
});

assert.equal(contracts.schemaVersion, 1);
assert.equal(contracts.selected.speech, "lily");
assert.equal(contracts.contracts.speech.lily.displayName, "Lily GPU Speech (Qwen3-TTS)");
assert.equal(contracts.contracts.speech.lily.endpointEnv, "LILY_MEDIA_SPEECH_ENDPOINT");
assert.equal(contracts.contracts.speech.lily.authEnv, "LILY_MEDIA_API_KEY");
assert.equal(contracts.contracts.speech.lily.params.voice.default, "aiden");
assert.deepEqual(
  contracts.contracts.speech.lily.params.voice.enum,
  ["aiden", "dylan", "eric", "ono_anna", "ryan", "serena", "sohee", "uncle_fu", "vivian"],
);
assert.equal(contracts.contracts.speech.lily.params.voice.aliases.longanyang, "aiden");
assert.equal(contracts.contracts.speech.lily.errors.providerFailure, "report-no-fallback");

const filtered = buildMediaProviderContracts({
  selected: { image: "lily", video: "lily", speech: "lily" },
  available: { image: ["lily"], video: [], speech: [] },
});
assert.ok(filtered.contracts.image.lily, "available Lily image contract should be present");
assert.equal(filtered.contracts.video?.lily, undefined, "unavailable Lily video contract must be omitted");
assert.equal(filtered.contracts.speech?.lily, undefined, "unavailable Lily speech contract must be omitted");

const cfg = withGatewayRuntimeConfig(
  { runtime: { env: {} } },
  { headers: { host: "lily.example.com" }, protocol: "https" },
  { deviceId: "dev_contract", licenseId: "lic_contract" },
  { publicBaseUrl: "https://lily.example.com", mediaDeliveryMode: "gateway" },
);

assert.equal(cfg.runtime.env.LILY_MEDIA_SPEECH_ENDPOINT, "https://lily.example.com/llm/media/lily/speech/generate");
assert.equal(cfg.media.speech.default, "lily");
assert.equal(cfg.media.contracts.selected.speech, "lily");
assert.equal(cfg.media.contracts.contracts.speech.lily.params.voice.default, "aiden");
assert.equal(cfg.media.contracts.contracts.speech.lily.request.template.voice, "{{voice}}");

console.log("media-provider-contracts: ok");
