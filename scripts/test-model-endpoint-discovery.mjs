// Verifies "paste the address, get the models": discoverEndpointModels hits the
// endpoint's /models and returns the ids so the user picks instead of typing —
// and fails SOFT (never throws, returns ok:false) so the caller falls back to
// manual entry. Capabilities stay the save-time probe's job.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { discoverEndpointModels } = require("../src/main/model-endpoint-discovery.js");

function server(handler) {
  const s = http.createServer(handler);
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port })));
}

test("discovers OpenAI-style /models and sends the key", async () => {
  let gotAuth = null, gotPath = null;
  const { s, port } = await server((req, res) => {
    gotAuth = req.headers.authorization; gotPath = req.url;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "gpt-x" }, { id: "gpt-x:mini" }, { id: "gpt-x" }] }));
  });
  const r = await discoverEndpointModels({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-1", protocol: "openai" });
  s.close();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.models, ["gpt-x", "gpt-x:mini"], "ids extracted and de-duped");
  assert.equal(gotPath, "/v1/models");
  assert.equal(gotAuth, "Bearer sk-1", "the key is sent");
});

test("anthropic protocol uses x-api-key", async () => {
  let gotKey = null;
  const { s, port } = await server((req, res) => {
    gotKey = req.headers["x-api-key"];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "claude-z" }] }));
  });
  const r = await discoverEndpointModels({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "ak-9", protocol: "anthropic" });
  s.close();
  assert.equal(r.ok, true);
  assert.equal(gotKey, "ak-9");
});

test("fails soft on HTTP error (no throw), so the caller falls back to manual", async () => {
  const { s, port } = await server((req, res) => { res.writeHead(401); res.end('{"error":"nope"}'); });
  const r = await discoverEndpointModels({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "" });
  s.close();
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP_401/);
});

test("fails soft on an empty model list", async () => {
  const { s, port } = await server((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{\"data\":[]}"); });
  const r = await discoverEndpointModels({ baseUrl: `http://127.0.0.1:${port}/v1` });
  s.close();
  assert.equal(r.ok, false);
  assert.equal(r.error, "NO_MODELS");
});

test("missing base URL is rejected, not thrown", async () => {
  const r = await discoverEndpointModels({ baseUrl: "", apiKey: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "BASE_URL_REQUIRED");
});
