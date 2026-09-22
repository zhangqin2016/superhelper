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
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

check("every provider names where its credential lives", () => {
  assert.deepEqual(MEDIA_PROVIDER_CATALOG.map((p) => p.id), ["lily", "dashscope", "volcengine", "kling", "minimax", "zhipu"]);
  for (const entry of MEDIA_PROVIDER_CATALOG) {
    assert.ok(entry.label && entry.labelEn, `${entry.id} is named for an operator`);
    assert.ok(entry.kinds.length, `${entry.id} declares what it can generate`);
    assert.ok(entry.credentialProviderId || entry.envVars.length, `${entry.id} says where its credential comes from`);
  }
  // The four ids an operator could never guess from the chip label.
  assert.deepEqual(MEDIA_CREDENTIAL_PROVIDER_IDS, ["vision", "volcengine-media", "kling-media", "minimax-media", "zhipu-media"]);
});

check("a provider with no credential is reported unusable, from either source", () => {
  const status = mediaProviderStatus({
    providers: { "kling-media": { apiKey: "k" } },
    serverConfig: { minimaxApiKey: "m" },
    lilyKinds: { image: true, video: false, speech: false },
  });
  const byId = Object.fromEntries(status.map((entry) => [entry.id, entry]));
  assert.equal(byId.kling.configured, true);
  assert.equal(byId.kling.source, "provider", "a stored credential row counts");
  assert.equal(byId.minimax.configured, true);
  assert.equal(byId.minimax.source, "env", "so does a server env var");
  assert.equal(byId.volcengine.configured, false);
  assert.equal(byId.volcengine.credentialProviderId, "volcengine-media", "and the fix is named");
  assert.deepEqual(byId.lily.kinds, ["image"], "Lily reports only the kinds it actually serves");
});

check("what delivery may offer is derived from the same status", () => {
  const status = mediaProviderStatus({ providers: { vision: { apiKey: "v" } }, serverConfig: {}, lilyKinds: {} });
  const available = availableMediaProviders(status);
  assert.deepEqual(available.image, ["dashscope"]);
  assert.deepEqual(available.speech, ["dashscope"], "speech only from providers that declare it");
  assert.deepEqual(availableMediaProviders(mediaProviderStatus({})), { image: [], video: [], speech: [] }, "nothing configured offers nothing");
});

check("delivery builds availability from the catalog, not a second hand-written list", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/src/services/client-config.js"), "utf8");
  assert.match(src, /const mediaAvailability = availableMediaProviders\(mediaStatus\)/, "availability is derived once");
  assert.match(src, /resolveMediaSelection\(configCopy, mediaAvailability\)/, "the selection uses it");
  assert.match(src, /available: mediaAvailability,/, "and so do the provider contracts — one list, not two");
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

console.log(`\n${checks} checks passed (media provider manageability)`);
