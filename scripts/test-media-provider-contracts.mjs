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

const { buildMediaProviderContracts, openApiGenerateSchemaToContract } = await import("../server/src/services/media-provider-contracts.js");
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

const liveWanContract = openApiGenerateSchemaToContract({
  modality: "video",
  displayName: "Lily GPU Video (Wan)",
  endpointEnv: "LILY_MEDIA_VIDEO_ENDPOINT",
  authEnv: "LILY_MEDIA_API_KEY",
  mediaType: "video",
  extract: ["$.file"],
  schema: {
    required: ["prompt"],
    properties: {
      prompt: { type: "string", title: "Prompt", default: "" },
      negative_prompt: { anyOf: [{ type: "string" }, { type: "null" }], title: "Negative Prompt" },
      image_base64: { anyOf: [{ type: "string" }, { type: "null" }], title: "Image Base64" },
      width: { anyOf: [{ type: "integer" }, { type: "null" }], title: "Width", default: 512 },
      height: { anyOf: [{ type: "integer" }, { type: "null" }], title: "Height", default: 320 },
      frames: { anyOf: [{ type: "integer" }, { type: "null" }], title: "Frames", default: 17 },
      steps: { anyOf: [{ type: "integer" }, { type: "null" }], title: "Steps", default: 4 },
      seed: { anyOf: [{ type: "integer" }, { type: "null" }], title: "Seed" },
    },
  },
});
assert.deepEqual(Object.keys(liveWanContract.params), ["prompt", "negative_prompt", "image_base64", "width", "height", "frames", "steps", "seed"]);
assert.equal(liveWanContract.params.prompt.required, true);
assert.equal(liveWanContract.params.width.type, "number");
assert.equal(liveWanContract.params.width.default, 512);
assert.equal(liveWanContract.request.template.width, "{{width}}");

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

const liveCfg = withGatewayRuntimeConfig(
  { runtime: { env: {} } },
  { headers: { host: "lily.example.com" }, protocol: "https" },
  { deviceId: "dev_contract", licenseId: "lic_contract" },
  {
    publicBaseUrl: "https://lily.example.com",
    mediaDeliveryMode: "gateway",
    mediaContracts: {
      schemaVersion: 1,
      selected: { image: "lily", video: "lily", speech: "lily" },
      contracts: { video: { lily: liveWanContract } },
    },
  },
);
assert.equal(liveCfg.media.contracts.contracts.video.lily.params.width.default, 512);
assert.equal(liveCfg.media.contracts.contracts.video.lily.params.ratio, undefined, "live service contract must replace stale hardcoded video params");

console.log("media-provider-contracts: ok");
