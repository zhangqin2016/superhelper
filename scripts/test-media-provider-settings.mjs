#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-media-provider-settings-"));
process.env.LILY_USER_DATA_DIR = root;

function writeRemoteConfig(effectiveConfig) {
  const state = {
    schemaVersion: 1,
    configVersion: "test",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    effectiveConfig,
  };
  fs.writeFileSync(
    path.join(root, "remote-config-cache.json"),
    JSON.stringify({
      config: {
        encrypted: false,
        data: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
      },
      updatedAt: new Date().toISOString(),
    }),
    "utf8",
  );
  try {
    require("../src/main/remote-config.js").reloadRemoteConfigCache();
  } catch {
    // remote-config may not be loaded yet.
  }
}

writeRemoteConfig({
  media: {
    image: { providers: ["dashscope"], default: "dashscope" },
    video: { providers: ["dashscope"], default: "dashscope" },
    speech: { providers: ["dashscope"], default: "dashscope" },
  },
  runtime: {
    env: {
      DASHSCOPE_API_KEY: "dashscope-token",
      LILY_MEDIA_IMAGE_ENDPOINT: "https://lily.example.com/llm/media/lily/image/generate",
      LILY_MEDIA_VIDEO_ENDPOINT: "https://lily.example.com/llm/media/lily/video/generate",
      LILY_MEDIA_SPEECH_ENDPOINT: "https://lily.example.com/llm/media/lily/speech/generate",
    },
  },
});

const settings = require("../src/main/media-provider-settings.js");
const publicSettings = settings.listMediaProvidersPublic();

for (const modality of ["image", "video", "speech"]) {
  assert.equal(
    publicSettings.serviceProvidersByModality[modality].includes("lily"),
    true,
    `configured first-party Lily ${modality} service must remain visible in client media settings`,
  );
}

assert.deepEqual(
  publicSettings.serviceSelection.image.providers,
  ["dashscope"],
  "stale remote media selection is preserved as the server default contract, not mutated by the client",
);

writeRemoteConfig({
  media: {
    image: { providers: ["lily"], default: "lily" },
    video: { providers: ["lily"], default: "lily" },
    speech: { providers: ["lily"], default: "lily" },
  },
  runtime: {
    env: {},
  },
});

{
  const result = settings.setModalityChoice("image", "service", "lily");
  assert.equal(result.ok, true, "choosing Lily should be persisted even if the service is temporarily unavailable");
  const env = settings.getMediaProviderSpawnEnv();
  assert.equal(env.LILY_IMAGE_PROVIDER, undefined, "unavailable selected Lily image service must not drive execution");
}

writeRemoteConfig({
  media: {
    image: { providers: ["lily", "dashscope"], default: "lily" },
    video: { providers: ["lily", "dashscope"], default: "lily" },
    speech: { providers: ["lily", "dashscope"], default: "lily" },
  },
  runtime: {
    env: {
      LILY_MEDIA_IMAGE_ENDPOINT: "https://lily.example.com/llm/media/lily/image/generate",
      LILY_MEDIA_VIDEO_ENDPOINT: "https://lily.example.com/llm/media/lily/video/generate",
      LILY_MEDIA_SPEECH_ENDPOINT: "https://lily.example.com/llm/media/lily/speech/generate",
    },
  },
});

{
  const env = settings.getMediaProviderSpawnEnv();
  assert.equal(env.LILY_IMAGE_PROVIDER, "lily", "server default must drive image execution when local JSON has no explicit choice");
  assert.equal(env.LILY_VIDEO_PROVIDER, "lily", "server default must drive video execution when local JSON has no explicit choice");
  assert.equal(env.LILY_SPEECH_PROVIDER, "lily", "server default must drive speech execution when local JSON has no explicit choice");
}

{
  const result = settings.setModalityChoice("image", "service", "lily");
  assert.equal(result.ok, true, "explicitly choosing Lily should be accepted");
  const stored = JSON.parse(fs.readFileSync(path.join(root, "media-provider-settings.json"), "utf8"));
  assert.deepEqual(
    stored.image,
    { source: "service", provider: "lily" },
    "explicit client media choice must be persisted so new runs execute with the selected provider",
  );
  assert.equal(
    settings.getMediaProviderSpawnEnv().LILY_IMAGE_PROVIDER,
    "lily",
    "persisted service choice must become execution env",
  );
}

console.log("media-provider-settings: ok");
