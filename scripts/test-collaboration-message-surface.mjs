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
assert.match(composer, /Shift\+Enter/, "composer keeps a multiline keyboard path");
assert.match(composer, /assistantClient\?\.collaboration\?\.send/, "composer sends through the closed collaboration API");

const friends = fs.readFileSync(path.join(root, "src/renderer/modules/collaboration-friends.js"), "utf8");
assert.match(friends, /renderCollaborationFriends/, "friend workflow is rendered as a dedicated slice");

console.log("collaboration message source surface checks passed (not interaction E2E)");
