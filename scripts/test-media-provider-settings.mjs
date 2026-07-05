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

console.log("media-provider-settings: ok");
