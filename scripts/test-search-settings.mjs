#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-search-settings-"));
process.env.LILY_USER_DATA_DIR = root;
process.resourcesPath ||= root;

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
  runtime: {
    env: {
      WEBSEARCH_IQS_API_KEY: "remote-search-token",
      WEBSEARCH_IQS_API_URL: "https://lily.example.com/llm/search/iqs",
    },
  },
});

const search = require("../src/main/search-settings.js");

{
  const env = search.getSearchSpawnEnv();
  assert.equal(env.WEBSEARCH_PROVIDER, "iqs", "IQS remains the managed default search provider");
  assert.equal(env.WEBSEARCH_IQS_API_KEY, "remote-search-token", "server-delivered IQS token must drive execution");
  assert.equal(
    env.WEBSEARCH_IQS_API_URL,
    "https://lily.example.com/llm/search/iqs",
    "server-delivered IQS gateway URL must drive execution",
  );
}

{
  const result = search.setSearchProvider("searxng");
  assert.equal(result.ok, true, "SearXNG provider should be selectable");
  const stored = JSON.parse(fs.readFileSync(path.join(root, "search-settings.json"), "utf8"));
  assert.equal(stored.providerId, "searxng", "client search choice must be persisted");
  assert.equal(search.getSearchSpawnEnv().WEBSEARCH_PROVIDER, "searxng", "persisted search choice must become execution env");
}

{
  const result = search.setSearxngUrl("https://search.example.com/query?q=test");
  assert.equal(result.ok, true, "SearXNG URL should be accepted and normalized");
  assert.equal(result.searxngUrl, "https://search.example.com");
  assert.equal(
    search.getSearchSpawnEnv().WEBSEARCH_SEARXNG_URL,
    "https://search.example.com",
    "persisted SearXNG URL must become execution env",
  );
}

console.log("search-settings: ok");
