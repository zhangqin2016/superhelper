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
assert.match(index, /id="mobilePairQr"/, "the scannable QR image host exists");
assert.match(index, /id="mobilePairPendingList"/, "the pending list host exists");
assert.match(index, /id="mobilePairDeviceList"/, "the paired-devices management host exists");

const panel = read("src/renderer/modules/settings-panel.js");
assert.match(panel, /"mobile"/, "mobile is a registered settings page");
assert.match(panel, /onMobilePairingPageShown/, "polling starts when the page opens");
assert.match(panel, /onMobilePairingPageHidden/, "polling stops when the page closes");

const app = read("src/renderer/app.js");
assert.match(app, /initMobilePairingSettings/, "app initializes the mobile pairing UI");

const mod = read("src/renderer/modules/mobile-pairing-settings.js");
for (const call of ["mobilePairingCreateChallenge", "mobilePairingPollPending", "mobilePairingListDevices", "mobilePairingApprove", "mobilePairingDeny", "mobilePairingRevoke", "mobilePairingStatus"]) {
  assert.match(mod, new RegExp(call), `renderer calls preload ${call}`);
}
// Feature-off / kill-switch hides the nav entry instead of showing a dead page.
assert.match(mod, /nav\.hidden = true/, "the nav entry hides when the feature is unavailable");

// Every i18n key the UI/module reference exists in all three locales.
const keys = [
  "settings.nav.mobile", "settings.mobileDesc", "settings.mobilePairStart", "settings.mobilePairScan", "settings.mobilePairCodeHint",
  "settings.mobilePairExpiry", "settings.mobilePairPending", "settings.mobilePairNoPending",
  "settings.mobilePairDevice", "settings.mobilePairApprove", "settings.mobilePairDeny",
  "settings.mobilePairApproved", "settings.mobilePairBridged", "settings.mobilePairLoginRequired",
  "settings.mobilePairChallengeFailed", "settings.mobilePairActionFailed",
  "settings.mobilePairPaired", "settings.mobilePairNoPaired", "settings.mobilePairRevoke", "settings.mobilePairRevoked",
];
for (const loc of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(read(`src/renderer/i18n/locales/${loc}.json`));
  for (const k of keys) assert.ok(messages[k], `${loc} missing ${k}`);
}

console.log("mobile-pairing-ui: ok");
