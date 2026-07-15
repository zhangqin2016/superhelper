#!/usr/bin/env node
// Static guard for the mobile pairing web page (desktop-vouched, no login).
// Locks the pairing/relay flow structure + the exact endpoints it calls so they
// can't drift from the server. On-device round-trip is validated server-side by
// server/scripts/mobile-command-e2e.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = fs.readFileSync(path.join(ROOT, "web/app/m/pair/page.js"), "utf8");

assert.match(page, /^"use client";/, "the pairing page is a client component");

// NO login: the phone must not call any auth/SMS endpoints or hold a bearer.
assert.doesNotMatch(page, /\/api\/auth\/sms\//, "the phone does not send/verify SMS codes");
assert.doesNotMatch(page, /accessToken/, "the phone holds no account access token");
assert.doesNotMatch(page, /Authorization/, "the phone sends no bearer");

// Pairing: consume with just a device id + one-time token, get a grant token.
assert.match(page, /\/api\/mobile\/pairing\/consume/, "consumes the pairing challenge");
assert.match(page, /deviceId/, "sends the browser device id");
assert.match(page, /mobileToken/, "uses the grant-scoped token returned by consume");

// Transport: relay as the mobile role, carrying the grant token (not a bearer).
assert.match(page, /role=mobile/, "connects the relay as the mobile role");
assert.match(page, /\/api\/mobile\/relay/, "connects the relay endpoint");
assert.match(page, /grantId=/, "relay connection carries the grant id");
assert.match(page, /token=\$\{encodeURIComponent\(mobileToken\)\}/, "relay is authenticated with the grant token");

// Command envelope shape the desktop bridge expects.
assert.match(page, /type: "command"/, "sends a command envelope");
assert.match(page, /commandId/, "the command carries a commandId (idempotency)");
assert.match(page, /correlationId/, "the command carries a correlationId for diagnostics");
assert.match(page, /corr_/, "correlation ids are visually distinct from command ids");
assert.match(page, /command\.admitted/, "renders the admission ack");
assert.match(page, /command\.rejected/, "renders a rejection");
assert.match(page, /setTurnState\("queued"\)/, "send clears old reply into a queued state");
assert.match(page, /等待桌面执行/, "queued commands have a visible waiting state");
assert.match(page, /relay\.peer_offline/, "renders desktop-offline relay feedback");
assert.match(page, /frame\.correlationId/, "desktop-offline feedback includes the command correlation id when present");
assert.match(page, /连接已断开/, "shows a clear message when the relay disconnects");
assert.match(page, /无法连接桌面/, "shows a terminal message after reconnect retries are exhausted");
assert.match(page, /手机尚未连接桌面/, "send/stop while disconnected is visible");
assert.match(page, /attachmentStatus/, "renders whether phone attachments reached desktop");
assert.match(page, /图片未送达/, "warns when image attachment materialization fails");
assert.match(page, /部分图片未送达/, "warns when only some attachments materialize");

// Projected desktop turn output — the phone sees the reply it triggered.
assert.match(page, /"assistant\.delta"/, "accumulates streaming assistant text");
assert.match(page, /"turn\.started"/, "resets the reply on a new turn");
assert.match(page, /"turn\.ended"/, "marks the turn done/failed/interrupted");
assert.match(page, /桌面回复/, "renders a reply panel");
// Interrupt a running turn from the phone.
assert.match(page, /type: "interrupt"/, "can send an interrupt frame");
assert.match(page, /interrupt\.ack/, "renders the interrupt ack");
assert.match(page, /stopCorrelationId/, "interrupt frames carry a correlation id");
assert.match(page, /corr_stop_/, "stop correlation ids are visually distinct");
// Session context + recent history.
assert.match(page, /type: "session\.request"/, "requests session context on connect");
assert.match(page, /type: "sessions\.request"/, "requests selectable session list on connect");
assert.match(page, /"sessions\.list"/, "renders selectable sessions from the desktop");
assert.match(page, /type: "session\.select"/, "can select which desktop session receives mobile commands");
assert.match(page, /selectedSessionId/, "keeps the selected target session id");
assert.match(page, /<select/, "renders a mobile session picker");
assert.match(page, /"session\.context"/, "renders the session context");
assert.match(page, /sessionCtx/, "keeps session context state (title + recent history)");
// Attachments: pick + downscale an image and send it with the command.
assert.match(page, /type="file"/, "has an image picker");
assert.match(page, /accept="image\/\*"/, "picker accepts images");
assert.match(page, /fileToDownscaledAttachment/, "downscales the image before sending");
assert.match(page, /attachments: attachment \?/, "includes the attachment in the command frame");
assert.match(page, /lilySessionId: selectedSessionId/, "commands target the mobile-selected session");

// Browser dictation: speech-to-text is a mobile input convenience, distinct
// from gated production/native voice control.
assert.match(page, /SpeechRecognition/, "checks for browser speech recognition support");
assert.match(page, /startVoiceInput/, "has a browser voice dictation entry point");
assert.match(page, /语音输入不可用/, "falls back loudly when browser dictation is unavailable");
assert.match(page, /🎙/, "renders a microphone button");

// Direct connect (TeamViewer/ToDesk-style): code + password, no approval.
assert.match(page, /\/api\/mobile\/direct\/consume/, "direct-connect consumes code + password");
assert.match(page, /directConnect/, "has a direct-connect flow");
assert.match(page, /DIRECT_CODE_LOCKED/, "shows a lockout message after too many attempts");
assert.match(page, /授权码直连/, "offers a direct-code mode");

// Retry-until-approved: the relay refuses until the desktop approves.
assert.match(page, /setTimeout\(tryOnce/, "retries the relay connection until approval flips the grant active");

// Scan deep link: a QR opens /m/pair#u=<api>&t=<token>; scanning auto-pairs.
assert.match(page, /parseScanHash/, "parses the scanned QR deep link");
assert.match(page, /\bt=/, "reads the token param from the scan hash");
assert.match(page, /pageOrigin\(\)/, "falls back to the page origin as the API base when scanned");
assert.match(page, /autoPairedRef/, "auto-pairs once when opened via a scanned deep link");

// One-time token: never consume twice (StrictMode double-invoke / double tap).
assert.match(page, /consumingRef/, "guards against a double consume of the one-time token");
assert.match(page, /if \(consumingRef\.current\) return/, "pair() returns early if a consume is already in flight/done");
assert.match(page, /PAIRING_CHALLENGE_INVALID_OR_EXPIRED/, "shows a clear message when the code expired/was used");

// Final-shape capability metadata: the page shows the current demo surface and
// explicitly keeps Phase 2 live/voice/control disabled unless the server enables it.
assert.match(page, /\/api\/mobile\/capabilities/, "loads Mobile Command capability metadata");
assert.match(page, /文件上传、产物/, "capability copy includes local file upload/artifacts");
assert.match(page, /capabilities\.observeControl\?\.enabled/, "renders observe/control as server-gated");
assert.match(page, /capabilities\.voice\?\.enabled/, "renders voice as server-gated");
assert.match(page, /屏幕、鼠标键盘控制、生产语音\/ASR等待桌面证据放行/, "does not advertise Phase 2 as live");

console.log("mobile-pair-web: ok");
