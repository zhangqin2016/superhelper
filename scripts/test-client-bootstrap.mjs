#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildClientBootstrapPolicy,
  clientFeatureEnabled,
  resolveClientRegion,
} from "../server/src/services/client-bootstrap.js";

assert.equal(
  resolveClientRegion({ headers: { host: "lilyuae.lilywb.cn" } }),
  "uae",
  "UAE edge host should force UAE policy",
);
assert.equal(
  resolveClientRegion({ headers: { host: "lilych.lilywb.cn", "cf-ipcountry": "AE" } }),
  "uae",
  "UAE source country should receive UAE policy even from bootstrap host",
);
assert.equal(
  resolveClientRegion({ headers: { host: "lilych.lilywb.cn", "cf-ipcountry": "CN" } }),
  "china",
  "China source country should receive China policy",
);

const uae = buildClientBootstrapPolicy({ headers: { host: "lilych.lilywb.cn", "x-lily-region": "uae" } });
assert.equal(uae.ok, true);
assert.equal(uae.region, "uae");
assert.equal(uae.apiBaseUrl, "https://lilyuae.lilywb.cn");
assert.equal(uae.gatewayBaseUrl, "https://lilyuae.lilywb.cn");
assert.equal(uae.modelGatewayBaseUrl, "https://lilyuae.lilywb.cn/llm");
assert.equal(uae.features.accountLogin, false);
assert.equal(uae.features.purchase, false);
assert.equal(uae.features.licenseActivation, true);
assert.equal(uae.features.usage, true);
assert.equal(uae.features.modelDirect, false);
assert.equal(uae.routing.modelMode, "gateway");
assert.equal(uae.routing.releaseChannel, "domestic");

const china = buildClientBootstrapPolicy({ headers: { host: "lilych.lilywb.cn" } });
assert.equal(china.region, "china");
assert.equal(china.apiBaseUrl, "https://lilych.lilywb.cn");
assert.equal(china.features.accountLogin, true);
assert.equal(china.features.purchase, true);
assert.equal(china.features.usage, true);
assert.equal(china.features.modelDirect, false);

assert.equal(clientFeatureEnabled({ headers: { host: "lilyuae.lilywb.cn" } }, "accountLogin"), false);
assert.equal(clientFeatureEnabled({ headers: { host: "lilyuae.lilywb.cn" } }, "purchase"), false);
assert.equal(clientFeatureEnabled({ headers: { host: "lilych.lilywb.cn" } }, "accountLogin"), true);

console.log("client-bootstrap: ok");
