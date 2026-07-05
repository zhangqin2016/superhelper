import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const configPath = require.resolve("../src/main/config.js");

function withConfigEnv(env = {}, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  delete require.cache[configPath];
  const config = require(configPath);
  try {
    return fn(config);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

withConfigEnv({ LILY_APP_EDITION: undefined }, (config) => {
  assert.equal(config.appEdition().id, "domestic");
  assert.equal(config.appEdition().serviceApiBaseUrl, "https://lilych.lilywb.cn");
  assert.equal(config.appEdition().features.account, true);
});

withConfigEnv({ LILY_APP_EDITION: "overseas" }, (config) => {
  assert.equal(config.appEdition().id, "overseas");
  assert.equal(config.appEdition().features.account, false);
  assert.equal(config.appEdition().serviceApiBaseUrl, "https://lilyxinjiapo.lilywb.cn");
});

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-edition-"));
  const file = path.join(tmp, "app-edition.json");
  fs.writeFileSync(file, JSON.stringify({ id: "overseas" }), "utf8");
  withConfigEnv({ LILY_APP_EDITION: undefined, LILY_APP_EDITION_FILE: file }, (config) => {
    assert.equal(config.appEdition().id, "overseas");
    assert.equal(config.appEdition().features.account, false);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("app-edition: ok");
