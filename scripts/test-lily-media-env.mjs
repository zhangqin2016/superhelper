#!/usr/bin/env node
import assert from "node:assert/strict";
import { stripDisabledLilyMediaEnv } from "../server/src/services/lily-media-env.js";

const config = {
  runtime: {
    env: {
      LILY_MEDIA_API_KEY: "stale-token",
      LILY_MEDIA_BASE_URL: "https://stale.example/media",
      LILY_MEDIA_IMAGE_ENDPOINT: "https://stale.example/image",
      LILY_MEDIA_VIDEO_ENDPOINT: "https://stale.example/video",
      LILY_MEDIA_SPEECH_ENDPOINT: "https://stale.example/speech",
      LILY_IMAGE_PROVIDER: "lily",
      LILY_VIDEO_PROVIDER: "lily",
      LILY_SPEECH_PROVIDER: "lily",
    },
  },
};

stripDisabledLilyMediaEnv(config, { image: true, video: false, speech: false, shared: false });
assert.equal(config.runtime.env.LILY_MEDIA_IMAGE_ENDPOINT, "https://stale.example/image");
assert.equal(config.runtime.env.LILY_MEDIA_VIDEO_ENDPOINT, undefined);
assert.equal(config.runtime.env.LILY_MEDIA_SPEECH_ENDPOINT, undefined);
assert.equal(config.runtime.env.LILY_MEDIA_BASE_URL, undefined);
assert.equal(config.runtime.env.LILY_IMAGE_PROVIDER, "lily");
assert.equal(config.runtime.env.LILY_VIDEO_PROVIDER, undefined);
assert.equal(config.runtime.env.LILY_SPEECH_PROVIDER, undefined);
assert.equal(config.runtime.env.LILY_MEDIA_API_KEY, "stale-token");

stripDisabledLilyMediaEnv(config, { image: false, video: false, speech: false, shared: false });
assert.equal(config.runtime.env.LILY_MEDIA_IMAGE_ENDPOINT, undefined);
assert.equal(config.runtime.env.LILY_MEDIA_API_KEY, undefined);
assert.equal(config.runtime.env.LILY_IMAGE_PROVIDER, undefined);

console.log("lily media env tests passed");
