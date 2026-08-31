import assert from "node:assert/strict";
import fs from "node:fs";
const keys = ["attach", "attachment", "sendSelected", "select", "confirmSend", "caption", "download", "save", "saved", "pause", "resume", "cancel", "bytes", "completedParts", "messageCancellation", "destinationExists", "permissionDenied", "failed", "unavailable", "updated", "prepared", "encrypting", "queued", "uploading", "uploaded", "verifying", "verified", "bound", "downloading", "decrypting", "ready", "paused", "cancelled", "waiting_attachments", "confirming", "persisted"];
for (const language of ["zh-CN", "en", "ar"]) {
  const values = JSON.parse(fs.readFileSync(new URL(`../src/renderer/i18n/locales/${language}.json`, import.meta.url), "utf8"));
  for (const key of keys) assert.ok(values[`collaboration.transfer.${key}`], `${language}: missing transfer.${key}`);
  for (const key of ["ready_to_handoff", "submitting", "delivery_unknown", "message_failed", "message_paused", "cancellation_requested", "recoveryBlocked"]) assert.ok(values[`collaboration.transfer.${key}`], `${language}: missing IPC send state ${key}`);
}
const source = fs.readFileSync(new URL("../src/renderer/modules/collaboration-attachments.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
assert.doesNotMatch(source, /inputPath|destinationPath|signedUrl|verifiedFile/);
console.log("attachment locale and renderer boundary checks passed");
