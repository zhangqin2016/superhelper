#!/usr/bin/env node
// Static guard for the desktop Mobile Command settings UI: the page exists, is
// registered, the renderer module is wired and talks to the preload IPC, and
// all its i18n keys exist in every locale. (Pixels/UX still need the running
// app; this locks the structure so it can't silently rot.)

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const index = read("src/renderer/index.html");
assert.match(index, /data-settings-page="mobile"/, "the mobile settings page/nav exists");
assert.match(index, /id="settingsPageMobile"/, "the mobile settings page section exists");
assert.match(index, /id="mobilePairStartBtn"/, "the generate-code button exists");
assert.match(index, /id="mobilePairDirectBtn"/, "the generate-direct-code button exists");
assert.match(index, /id="mobilePairDirectCode"/, "the direct code display exists");
assert.match(index, /id="mobilePairDirectPassword"/, "the direct password display exists");
assert.match(index, /id="mobilePairQr"/, "the scannable QR image host exists");
assert.match(index, /id="mobilePairPendingList"/, "the pending list host exists");
assert.match(index, /id="mobilePairDeviceList"/, "the paired-devices management host exists");
assert.match(index, /id="mobilePairCapabilityStatus"/, "the capability status host exists");

const panel = read("src/renderer/modules/settings-panel.js");
assert.match(panel, /"mobile"/, "mobile is a registered settings page");
assert.match(panel, /onMobilePairingPageShown/, "polling starts when the page opens");
assert.match(panel, /onMobilePairingPageHidden/, "polling stops when the page closes");

const app = read("src/renderer/app.js");
assert.match(app, /initMobilePairingSettings/, "app initializes the mobile pairing UI");

const mod = read("src/renderer/modules/mobile-pairing-settings.js");
for (const call of ["mobileGetState", "mobileCreateChallenge", "mobileCreateDirectCode", "mobileApprove", "mobileDeny", "mobileRevoke", "onMobileState"]) {
  assert.match(mod, new RegExp(call), `renderer calls preload ${call}`);
}
// Feature-off / kill-switch hides the nav entry instead of showing a dead page.
assert.match(mod, /nav\.hidden = true/, "the nav entry hides when the feature is unavailable");
assert.match(mod, /mobilePairCapabilityStatus/, "the renderer updates capability status");
assert.match(mod, /settings\.mobilePairCapabilitiesDemo/, "the renderer labels demo-only capability state");
assert.match(mod, /settings\.mobilePairCapabilitiesLive/, "the renderer labels server-enabled live capability state");
assert.match(mod, /caps\.observeControl\?\.enabled/, "observe/control is rendered from server capabilities");
assert.match(mod, /caps\.voice\?\.enabled/, "voice is rendered from server capabilities");

// Every i18n key the UI/module reference exists in all three locales.
const keys = [
  "settings.nav.mobile", "settings.mobileDesc", "settings.mobilePairStart", "settings.mobilePairScan", "settings.mobilePairCodeHint",
  "settings.mobilePairDirectStart", "settings.mobilePairDirectTitle", "settings.mobilePairDirectCode", "settings.mobilePairDirectPassword",
  "settings.mobilePairPending",
  "settings.mobilePairDevice", "settings.mobilePairApprove", "settings.mobilePairDeny",
  "settings.mobilePairApproved", "settings.mobilePairLoginRequired",
  "settings.mobilePairCapabilitiesDemo", "settings.mobilePairCapabilitiesLive",
  "settings.mobilePairChallengeFailed", "settings.mobilePairActionFailed",
  "settings.mobilePairPaired", "settings.mobilePairNoPaired", "settings.mobilePairRevoke", "settings.mobilePairRevoked",
];
// …and every key actually referenced (markup of the mobile page + t() calls in
// the module), so a new label can never ship untranslated.
const section = index.slice(index.indexOf('id="settingsPageMobile"'), index.indexOf('id="settingsPageMemory"'));
for (const m of section.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)) keys.push(m[1]);
for (const m of mod.matchAll(/\bt\("([^"]+)"/g)) keys.push(m[1]);
for (const loc of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(read(`src/renderer/i18n/locales/${loc}.json`));
  for (const k of new Set(keys)) assert.ok(messages[k], `${loc} missing ${k}`);
}

// Live, not polled-only: the page listens for main-process change pushes and
// renders presence + a readable phone name, and asks before unpairing.
assert.match(mod, /onMobileState\?\.\(applyState\)/, "the page renders pushed state");
assert.doesNotMatch(mod, /setInterval\(\(\) => \{ void refresh/, "the page never polls the main process");
assert.match(mod, /CHANNEL_NOTICE/, "a signed-out / outdated / offline channel is said, not hidden");
assert.match(mod, /grant\.online/, "each paired phone shows whether it is on the line");
assert.match(mod, /mobileLabel/, "phones are named by model, not only an opaque id");
assert.match(mod, /ui\.confirmingRevoke/, "unpairing asks for an inline confirmation");
assert.match(mod, /mobilePairInlinePending/, "a scanning phone's approval appears inside the QR panel");

console.log("mobile-pairing-ui: ok");
