#!/usr/bin/env node
// Verifies multi-provider media gateway wiring for the Volcengine (Ark) sample:
//   1. client-config env delivery — gateway mode keeps the key server-side (only
//      a short token leaves), direct mode delivers the real key + endpoint;
//   2. the /llm/media/:provider/* proxy route — provider routing, server-side
//      Bearer injection, and token provider-id enforcement.
// Env is set BEFORE the dynamic imports so config.js picks up the test key.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

process.env.MODEL_GATEWAY_ENABLED = "true";
process.env.MODEL_GATEWAY_TOKEN_SECRET = "test-media-gateway-secret";
process.env.DASHSCOPE_API_KEY = "dashscope-secret";
process.env.VISION_UPSTREAM_BASE_URL = "https://vision-compatible.test.local/compatible-mode/v1";
process.env.DASHSCOPE_MEDIA_BASE_URL = "https://dashscope-media.test.local/api/v1";
process.env.VOLCENGINE_API_KEY = "volc-secret";
process.env.VOLCENGINE_BASE_URL = "https://ark.test.local/api/v3";
process.env.KLING_ACCESS_KEY = "kling-ak";
process.env.KLING_SECRET_KEY = "kling-sk";
process.env.KLING_BASE_URL = "https://kling.test.local";
process.env.MINIMAX_API_KEY = "mm-secret";
process.env.MINIMAX_GROUP_ID = "grp-9";
process.env.MINIMAX_BASE_URL = "https://minimax.test.local";
process.env.MODEL_GATEWAY_PROVIDERS = JSON.stringify({
  vision: {
    type: "openai",
    baseUrl: "https://vision-compatible.test.local/compatible-mode/v1",
    apiKey: "vision-secret",
  },
});

const { withGatewayRuntimeConfig, buildEnvManagedClientConfig } = await import("../server/src/services/client-config.js");
const { signModelGatewayToken, verifyModelGatewayToken } = await import("../server/src/services/model-gateway/auth.js");
const { mediaGatewayRoutes } = await import("../server/src/services/media-gateway.js");

const mediaGatewaySource = fs.readFileSync(
  new URL("../server/src/services/media-gateway.js", import.meta.url),
  "utf8",
);
assert.match(
  mediaGatewaySource,
  /gatewayAccountRequired\(\{\s*token,\s*enforcementEnabled:/,
  "media usage must share the model gateway's account/license precedence instead of maintaining a divergent copy",
);

const request = { headers: { host: "ignored.example.com" }, protocol: "http" };
const input = { deviceId: "dev_media_test", licenseId: "lic_media_test" };
const options = { publicBaseUrl: "https://lily.example.com" };

// --- gateway mode: real Ark key must NOT leak; a verifiable token is delivered.
const gw = withGatewayRuntimeConfig({}, request, input, { ...options, mediaDeliveryMode: "gateway" });
const gwEnv = gw.runtime.env;
assert.equal(gwEnv.VOLCENGINE_BASE_URL, "https://lily.example.com/llm/media/volcengine");
assert.notEqual(gwEnv.VOLCENGINE_API_KEY, "volc-secret", "raw Ark key must NOT be delivered in gateway mode");
assert.equal(verifyModelGatewayToken(gwEnv.VOLCENGINE_API_KEY, "volcengine-media").ok, true);

// --- direct mode: real key + real endpoint delivered for a straight connection.
const direct = withGatewayRuntimeConfig({}, request, input, { ...options, mediaDeliveryMode: "direct" });
const directEnv = direct.runtime.env;
assert.equal(directEnv.VOLCENGINE_API_KEY, "volc-secret");
assert.equal(directEnv.VOLCENGINE_BASE_URL, "https://ark.test.local/api/v3");

// Kling: gateway hides AccessKey/SecretKey behind a token; direct delivers both.
assert.equal(gwEnv.KLING_BASE_URL, "https://lily.example.com/llm/media/kling");
assert.equal(verifyModelGatewayToken(gwEnv.KLING_API_KEY, "kling-media").ok, true);
assert.equal(gwEnv.KLING_SECRET_KEY, undefined, "Kling SecretKey must NOT leak in gateway mode");
assert.equal(directEnv.KLING_ACCESS_KEY, "kling-ak");
assert.equal(directEnv.KLING_SECRET_KEY, "kling-sk");
// MiniMax GroupId is delivered only in direct mode (appended server-side in gateway).
assert.equal(directEnv.MINIMAX_GROUP_ID, "grp-9");
assert.equal(gwEnv.MINIMAX_GROUP_ID, undefined, "GroupId must not be delivered in gateway mode");

// --- non-secret config + default-provider env delivery; no chat preset leak.
const managed = buildEnvManagedClientConfig(
  {
    volcengineApiKey: "volc-secret",
    volcengineImageModel: "doubao-seedream-4-0-250828",
    volcengineVideoModel: "doubao-seedance-1-0-lite-t2v-250428",
    mediaImageProvider: "volcengine",
    mediaVideoProvider: "dashscope",
  },
  {},
);
assert.equal(managed.models, undefined, "media key must not create a chat preset");
assert.equal(managed.runtime.env.VOLCENGINE_IMAGE_MODEL, "doubao-seedream-4-0-250828");
assert.equal(managed.runtime.env.LILY_IMAGE_PROVIDER, "volcengine");
assert.equal(managed.runtime.env.LILY_VIDEO_PROVIDER, "dashscope");

// --- proxy route handler: capture registered routes via a fake fastify app.
const routes = {};
const fakeApp = {
  post(routePath, _opts, handler) { routes[`POST ${routePath}`] = handler; },
  get(routePath, _opts, handler) { routes[`GET ${routePath}`] = handler; },
};
await mediaGatewayRoutes(fakeApp);
assert.ok(routes["POST /llm/media/:provider/*"], "generic media proxy route must be registered");
assert.ok(routes["POST /llm/dashscope-media/*"], "back-compat dashscope alias must remain");

function fakeReply() {
  return {
    _code: 200,
    _headers: {},
    code(c) { this._code = c; return this; },
    header(name, value) { this._headers[name.toLowerCase()] = value; return this; },
    send(payload) { this._sent = payload; return this; },
  };
}

const realFetch = globalThis.fetch;
let captured = null;
const captures = [];
globalThis.fetch = async (url, init) => {
  captured = { url, init };
  captures.push(captured);
  if (String(url).endsWith("/embeddings")) {
    return {
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({
        object: "list",
        model: JSON.parse(init.body).model,
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
      }),
    };
  }
  if (url === "http://127.0.0.1:18012/generate") {
    return {
      status: 200,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({
          output: {
            task_id: "lily-img",
            image_url: "http://127.0.0.1:8012/outputs/generated.png",
            public_url: "https://cdn.example.com/public/generated.png",
          },
        }),
    };
  }
  if (url === "http://127.0.0.1:18010/generate") {
    return {
      status: 200,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({
          ok: true,
          kind: "wan",
          file: "/mnt/media-services/outputs/wan/generated.mp4",
        }),
    };
  }
  if (url === "http://127.0.0.1:18013/generate") {
    return {
      status: 200,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({
          ok: true,
          kind: "tts",
          file: "/mnt/media-services/outputs/tts/generated.wav",
          speaker: JSON.parse(init.body).voice,
        }),
    };
  }
  if (url === "http://127.0.0.1:18012/outputs/generated.png") {
    return {
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "image/png" : "") },
      arrayBuffer: async () => Buffer.from("lily-png").buffer,
    };
  }
  if (url === "http://127.0.0.1:18012/file?path=%2Fmnt%2Fmedia-services%2Foutputs%2Fflux%2Fgenerated.png") {
    return {
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "image/png" : "") },
      arrayBuffer: async () => Buffer.from("lily-file-png").buffer,
    };
  }
  if (url === "http://127.0.0.1:18010/file?path=%2Fmnt%2Fmedia-services%2Foutputs%2Fwan%2Fgenerated.mp4") {
    return {
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "video/mp4" : "") },
      arrayBuffer: async () => Buffer.from("lily-file-mp4").buffer,
    };
  }
  return { status: 200, headers: { get: () => "application/json" }, text: async () => '{"id":"cgt-1"}' };
};

try {
  const goodToken = signModelGatewayToken({ deviceId: input.deviceId, licenseId: input.licenseId, providerId: "volcengine-media" });
  const reply = fakeReply();
  await routes["POST /llm/media/:provider/*"](
    {
      method: "POST",
      url: "/llm/media/volcengine/contents/generations/tasks",
      params: { provider: "volcengine", "*": "contents/generations/tasks" },
      headers: { authorization: `Bearer ${goodToken}` },
      body: { model: "doubao-seedance-1-0-lite-t2v-250428" },
    },
    reply,
  );
  assert.equal(reply._code, 200, "valid request should proxy through");
  assert.equal(captured.url, "https://ark.test.local/api/v3/contents/generations/tasks");
  assert.equal(captured.init.headers.Authorization, "Bearer volc-secret", "server must inject the real Ark key");

  // Account usage enforcement is on by default. A media token with neither
  // account userId nor licenseId must be rejected before proxying to upstream.
  const anonymousToken = signModelGatewayToken({ deviceId: input.deviceId, providerId: "volcengine-media" });
  const reply402 = fakeReply();
  await routes["POST /llm/media/:provider/*"](
    {
      method: "POST",
      url: "/llm/media/volcengine/contents/generations/tasks",
      params: { provider: "volcengine", "*": "contents/generations/tasks" },
      headers: { authorization: `Bearer ${anonymousToken}` },
      body: { model: "doubao-seedance-1-0-lite-t2v-250428" },
    },
    reply402,
  );
  assert.equal(reply402._code, 402, "anonymous media token must be rejected when usage enforcement is enabled");

  // Wrong-provider token must be rejected (token bound to vision, not volcengine).
  const wrongToken = signModelGatewayToken({ deviceId: input.deviceId, providerId: "vision" });
  const reply401 = fakeReply();
  await routes["POST /llm/media/:provider/*"](
    {
      method: "POST",
      url: "/llm/media/volcengine/images/generations",
      params: { provider: "volcengine", "*": "images/generations" },
      headers: { authorization: `Bearer ${wrongToken}` },
      body: {},
    },
    reply401,
  );
  assert.equal(reply401._code, 401, "token bound to a different provider must be rejected");

  // Unknown provider must 404, not fall through.
  const reply404 = fakeReply();
  await routes["POST /llm/media/:provider/*"](
    {
      method: "POST",
      url: "/llm/media/nope/x",
      params: { provider: "nope", "*": "x" },
      headers: { authorization: `Bearer ${goodToken}` },
      body: {},
    },
    reply404,
  );
  assert.equal(reply404._code, 404, "unknown media provider must 404");

  // DashScope media must not reuse the vision compatible-mode base URL. Vision
  // is only the credential/token id; media endpoints need their own api/v1 host.
  const dashscopeToken = signModelGatewayToken({ deviceId: input.deviceId, licenseId: input.licenseId, providerId: "vision" });
  const dashscopeReply = fakeReply();
  await routes["POST /llm/dashscope-media/*"](
    {
      method: "POST",
      url: "/llm/dashscope-media/services/audio/tts/SpeechSynthesizer",
      params: { "*": "services/audio/tts/SpeechSynthesizer" },
      headers: { authorization: `Bearer ${dashscopeToken}` },
      body: { model: "cosyvoice-v3-flash" },
    },
    dashscopeReply,
  );
  assert.equal(dashscopeReply._code, 200);
  assert.equal(captured.url, "https://dashscope-media.test.local/api/v1/services/audio/tts/SpeechSynthesizer");
  assert.equal(captured.init.headers.Authorization, "Bearer vision-secret");

  // Vision-key embeddings relay: managed semantic memory recall reuses the vision
  // token + server-side DashScope key, forwarding to the compatible-mode
  // /embeddings endpoint. Wrong-provider tokens are rejected.
  assert.ok(routes["POST /llm/vision/embeddings"], "vision embeddings relay must be registered");
  const embedReply = fakeReply();
  await routes["POST /llm/vision/embeddings"](
    {
      method: "POST",
      url: "/llm/vision/embeddings",
      headers: { authorization: `Bearer ${dashscopeToken}` },
      body: { model: "text-embedding-v3", input: ["数据库连不上", "postgres refused"] },
    },
    embedReply,
  );
  assert.equal(embedReply._code, 200, "valid vision token should proxy embeddings");
  assert.equal(captured.url, "https://vision-compatible.test.local/compatible-mode/v1/embeddings", "embeddings forwards to the vision compatible-mode /embeddings");
  assert.equal(captured.init.headers.Authorization, "Bearer vision-secret", "server injects the real server-side vision/DashScope key, never the client token");
  assert.equal(JSON.parse(captured.init.body).model, "text-embedding-v3", "client embedding model passes through");
  assert.deepEqual(JSON.parse(embedReply._sent).data[0].embedding, [0.1, 0.2, 0.3]);

  const wrongEmbedToken = signModelGatewayToken({ deviceId: input.deviceId, licenseId: input.licenseId, providerId: "volcengine-media" });
  const wrongEmbedReply = fakeReply();
  await routes["POST /llm/vision/embeddings"](
    {
      method: "POST",
      url: "/llm/vision/embeddings",
      headers: { authorization: `Bearer ${wrongEmbedToken}` },
      body: { model: "text-embedding-v3", input: ["x"] },
    },
    wrongEmbedReply,
  );
  assert.equal(wrongEmbedReply._code, 401, "token bound to a non-vision provider must be rejected");

  // Kling proxy: server must mint a JWT (iss=AccessKey, signed with SecretKey),
  // never forward the raw token.
  const klingToken = signModelGatewayToken({ deviceId: input.deviceId, licenseId: input.licenseId, providerId: "kling-media" });
  const klingReply = fakeReply();
  await routes["POST /llm/media/:provider/*"](
    {
      method: "POST",
      url: "/llm/media/kling/v1/videos/text2video",
      params: { provider: "kling", "*": "v1/videos/text2video" },
      headers: { authorization: `Bearer ${klingToken}` },
      body: { model_name: "kling-v1-6" },
    },
    klingReply,
  );
  assert.equal(klingReply._code, 200);
  assert.equal(captured.url, "https://kling.test.local/v1/videos/text2video");
  const klingAuth = /^Bearer (.+)$/.exec(captured.init.headers.Authorization)[1];
  const [jh, jp, js] = klingAuth.split(".");
  const expectedSig = crypto
    .createHmac("sha256", "kling-sk")
    .update(`${jh}.${jp}`)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  assert.equal(js, expectedSig, "server-minted Kling JWT signature must verify with the SecretKey");
  assert.equal(JSON.parse(Buffer.from(jp.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()).iss, "kling-ak");

  // MiniMax proxy: server appends GroupId to the upstream query.
  const mmToken = signModelGatewayToken({ deviceId: input.deviceId, licenseId: input.licenseId, providerId: "minimax-media" });
  const mmReply = fakeReply();
  await routes["POST /llm/media/:provider/*"](
    {
      method: "POST",
      url: "/llm/media/minimax/v1/video_generation",
      params: { provider: "minimax", "*": "v1/video_generation" },
      headers: { authorization: `Bearer ${mmToken}` },
      body: { model: "MiniMax-Hailuo-2.3" },
    },
    mmReply,
  );
  assert.equal(mmReply._code, 200);
  assert.equal(captured.url, "https://minimax.test.local/v1/video_generation?GroupId=grp-9");
  assert.equal(captured.init.headers.Authorization, "Bearer mm-secret");

  // Lily GPU media proxy: client calls the public Lily gateway, server forwards
  // The self-hosted GPU provider and its private route, asset proxy and
  // filesystem-path handling were retired on 2026-09-23; every remaining
  // provider is exercised through the generic route above.
} finally {
  globalThis.fetch = realFetch;
}

console.log("media-gateway-providers: ok");
