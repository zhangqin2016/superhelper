#!/usr/bin/env node
// The config rule form offered six media providers as chips (Lily / DashScope /
// Volcengine / Kling / MiniMax / Zhipu) from a list hardcoded in the browser
// bundle, while delivery decided availability from a separately hand-written
// list, and four of the six needed a credential stored under a DIFFERENT id
// (`volcengine-media` for a chip reading 火山方舟). Production had none of those
// rows, so ticking those chips saved and was silently dropped — and nothing in
// the console said where to configure them. One catalog now feeds delivery, the
// admin API and the form.
// [gate: media-provider-manageability]
// Run: node scripts/test-media-provider-manageability.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_media_catalog_test";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  MEDIA_PROVIDER_CATALOG,
  MEDIA_CREDENTIAL_PROVIDER_IDS,
  availableMediaProviders,
  mediaProviderStatus,
} = await import("../server/src/services/media-provider-catalog.js");

let checks = 0;
const check = (name, fn) => {
  const done = () => { checks += 1; console.log(`ok - ${name}`); };
  const result = fn();
  return result?.then ? result.then(done) : done();
};

check("every provider names where its credential lives", () => {
  // No provider is special: the self-hosted GPU entry and its bespoke
  // integration (own env vars, own gateway routes, own contracts) were retired
  // on 2026-09-23. Every entry here is reached the same way.
  assert.deepEqual(MEDIA_PROVIDER_CATALOG.map((p) => p.id), ["dashscope", "volcengine", "kling", "minimax", "zhipu"]);
  for (const entry of MEDIA_PROVIDER_CATALOG) {
    assert.ok(entry.label && entry.labelEn, `${entry.id} is named for an operator`);
    assert.ok(entry.kinds.length, `${entry.id} declares what it can generate`);
    assert.ok(entry.credentialProviderId, `${entry.id} is reached through a credential row, like every other provider`);
  }
  // The four ids an operator could never guess from the chip label.
  assert.deepEqual(MEDIA_CREDENTIAL_PROVIDER_IDS, ["vision", "volcengine-media", "kling-media", "minimax-media", "zhipu-media"]);
  assert.equal(MEDIA_PROVIDER_CATALOG.length, MEDIA_CREDENTIAL_PROVIDER_IDS.length, "no provider is reached any other way");
});

check("a provider with no credential is reported unusable, from either source", () => {
  const status = mediaProviderStatus({
    providers: { "kling-media": { apiKey: "k" } },
    serverConfig: { minimaxApiKey: "m" },
  });
  const byId = Object.fromEntries(status.map((entry) => [entry.id, entry]));
  assert.equal(byId.kling.configured, true);
  assert.equal(byId.kling.source, "provider", "a stored credential row counts");
  assert.equal(byId.minimax.configured, true);
  assert.equal(byId.minimax.source, "env", "so does a server env var");
  assert.equal(byId.volcengine.configured, false);
  assert.equal(byId.volcengine.credentialProviderId, "volcengine-media", "and the fix is named");
});

check("what delivery may offer is derived from the same status", () => {
  const status = mediaProviderStatus({ providers: { vision: { apiKey: "v" } }, serverConfig: {} });
  const available = availableMediaProviders(status);
  assert.deepEqual(available.image, ["dashscope"]);
  assert.deepEqual(available.speech, ["dashscope"], "speech only from providers that declare it");
  assert.deepEqual(availableMediaProviders(mediaProviderStatus({})), { image: [], video: [], speech: [] }, "nothing configured offers nothing");
});

check("delivery builds availability from the catalog, not a second hand-written list", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/src/services/client-config.js"), "utf8");
  assert.match(src, /const mediaAvailability = availableMediaProviders\(mediaStatus\)/, "availability is derived once");
  assert.match(src, /resolveMediaSelection\(configCopy, mediaAvailability\)/, "the selection uses it");
  assert.ok(!/media-provider-contracts/.test(src), "the bespoke contract layer is gone with the provider that needed it");
  assert.ok(!/volcengineKey \? "volcengine" : null/.test(src), "the hand-written availability list is gone");
});

check("the console answers which providers are usable, and the form renders that answer", () => {
  const route = fs.readFileSync(path.join(ROOT, "server/src/routes/admin/model-providers.js"), "utf8");
  assert.match(route, /"\/api\/admin\/media-providers"/, "the admin can ask");
  assert.match(route, /mediaProviders: mediaProviderStatus\(/);
  const form = fs.readFileSync(path.join(ROOT, "web/components/config-profile-form.js"), "utf8");
  assert.match(form, /mediaProviders\.length \? mediaProviders : MEDIA_PROVIDERS/, "server catalog first, packaged list as the floor");
  assert.match(form, /disabled=\{!ready\}/, "an unusable provider cannot be ticked");
  assert.match(form, /copy\.mediaUnconfigured/, "and says why, with the id to create");
  assert.match(form, /p\.kinds\.includes\(modality\)/, "a provider is only offered for what it can generate");
  const page = fs.readFileSync(path.join(ROOT, "web/app/admin/config/profiles/new/page.js"), "utf8");
  assert.match(page, /loadAdmin\("\/api\/admin\/media-providers"/);
  const providersPage = fs.readFileSync(path.join(ROOT, "web/app/admin/config/providers/page.js"), "utf8");
  assert.match(providersPage, /loadAdmin\("\/api\/admin\/media-providers"/, "the providers page knows which credentials are awaited");
  const panel = fs.readFileSync(path.join(ROOT, "web/components/model-providers-panel.js"), "utf8");
  assert.match(panel, /datalist id="known-provider-ids"/, "the unguessable ids are offered, not guessed");
});

check("the unusable-provider notice is translated in all three locales", () => {
  const copy = fs.readFileSync(path.join(ROOT, "web/components/config-profile-copy.js"), "utf8");
  const matches = copy.match(/mediaUnconfigured: "/g) || [];
  assert.equal(matches.length, 3, "zh, en and ar all explain it");
  assert.match(copy, /模型供应商/, "the Chinese notice points at the page that fixes it");
});

check("no media provider gets a private integration", () => {
  // The rule the self-hosted GPU broke: a provider is a catalog entry, a
  // credential row and an adapter — never its own env plumbing, its own gateway
  // route or its own contract module.
  const gateway = fs.readFileSync(path.join(ROOT, "server/src/services/media-gateway.js"), "utf8");
  assert.match(gateway, /"\/llm\/media\/:provider\/\*"/, "one generic route serves every provider");
  assert.ok(!/llm\/media\/lily/.test(gateway), "and no provider has a route of its own");
  const clientConfig = fs.readFileSync(path.join(ROOT, "server/src/services/client-config.js"), "utf8");
  assert.ok(!/LILY_MEDIA_(IMAGE|VIDEO|SPEECH|BASE)/.test(clientConfig), "no provider ships its own endpoint env");
  assert.ok(!fs.existsSync(path.join(ROOT, "server/src/services/media-provider-contracts.js")), "no provider ships its own contract module");
  assert.ok(!fs.existsSync(path.join(ROOT, "server/src/services/lily-media-env.js")));
  assert.ok(!fs.existsSync(path.join(ROOT, "server/src/services/model-gateway/builtin-media-providers.js")), "and none is a read-only built-in row");
  for (const skill of ["lily-image-generation", "lily-video-generation"]) {
    assert.ok(!fs.existsSync(path.join(ROOT, `resources/skills/${skill}/scripts/providers/lily.cjs`)), `${skill} has no bespoke adapter`);
  }
});

await check("the rule form offers exactly the catalog — a retired provider cannot linger as an option", async () => {
  // Retiring the self-hosted GPU left "Lily 自有 GPU" selectable in the config
  // rule form: a hand-written list drifts from the catalog it copies.
  const builder = fs.readFileSync(path.join(ROOT, "web/components/config-profile-config-builder.js"), "utf8");
  const block = builder.slice(builder.indexOf("export const MEDIA_PROVIDERS"), builder.indexOf("];", builder.indexOf("export const MEDIA_PROVIDERS")));
  const offered = [...block.matchAll(/id: "([a-z0-9-]+)"/g)].map((m) => m[1]);
  const { MEDIA_PROVIDER_IDS } = await import("../server/src/services/media-provider-catalog.js");
  assert.deepEqual([...offered].sort(), [...MEDIA_PROVIDER_IDS].sort());
});

console.log(`\n${checks} checks passed (media provider manageability)`);
