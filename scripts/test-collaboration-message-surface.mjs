// Static source-boundary guards only; real interaction tests run in Electron.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const module of [
  "collaboration-inbox.js",
  "collaboration-timeline.js",
  "collaboration-composer.js",
  "collaboration-friends.js",
]) {
  const file = path.join(root, "src/renderer/modules", module);
  assert.equal(fs.existsSync(file), true, `${module} owns its collaboration interaction slice`);
}

const timeline = fs.readFileSync(path.join(root, "src/renderer/modules/collaboration-timeline.js"), "utf8");
assert.match(timeline, /clientCommandId/, "optimistic messages retain their idempotency identity");
assert.match(timeline, /delivery_unknown/, "ambiguous delivery is shown as recoverable, not failed");
assert.doesNotMatch(timeline, /innerHTML\s*=/, "message text is never rendered as untrusted HTML");

const composer = fs.readFileSync(path.join(root, "src/renderer/modules/collaboration-composer.js"), "utf8");
assert.match(composer, /if\s*\(event\.key\s*!==\s*"Enter"\s*\|\|\s*event\.shiftKey\s*\|\|\s*event\.isComposing\s*\|\|\s*event\.keyCode\s*===\s*229\)\s*return;/,
  "composer preserves multiline and IME paths before sending on Enter");
assert.match(composer, /const api\s*=\s*\(\)\s*=>\s*window\.assistantClient\?\.collaboration;/,
  "composer's API accessor is bound only to the closed preload collaboration surface");
assert.match(composer, /await api\(\)\?\.send\?\.\(/, "composer sends through that closed collaboration API accessor");
assert.doesNotMatch(composer, /\b(?:fetch|XMLHttpRequest|WebSocket|ipcRenderer)\b/, "composer cannot bypass the closed preload route");

const friends = fs.readFileSync(path.join(root, "src/renderer/modules/collaboration-friends.js"), "utf8");
assert.match(friends, /renderCollaborationFriends/, "friend workflow is rendered as a dedicated slice");

console.log("collaboration message source surface checks passed (not interaction E2E)");
