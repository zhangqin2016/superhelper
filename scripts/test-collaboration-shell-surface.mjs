// Static source-boundary guards only; real interaction tests run in Electron.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
const center = fs.readFileSync(path.join(root, "src/renderer/modules/collaboration-center.js"), "utf8");
for (const id of ["collaborationNavButton", "collaborationCenter", "collaborationInbox", "collaborationConversation", "collaborationStatus", "collaborationLive"]) {
  assert.match(html, new RegExp(`id="${id}"`), `shell includes ${id}`);
}
assert.match(html, /class="collaboration-column collaboration-nav"/, "shell has a navigation column");
assert.match(html, /class="collaboration-column collaboration-inbox"/, "shell has an inbox column");
assert.match(html, /class="collaboration-column collaboration-conversation"/, "shell has a conversation column");
assert.match(app, /initCollaborationCenter\(/, "application initializes collaboration entry gating");
assert.match(center, /policy\?\.collaboration\?\.enabled === true/, "remote signed policy gates the entry");
assert.match(center, /onStateChange/, "shell refreshes from durable main-process state changes");
assert.match(html, /aria-live="polite"/, "availability changes are announced without stealing focus");
assert.match(html, /collaboration-scope-badge/, "conversation shell has a scope badge");
for (const locale of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(fs.readFileSync(path.join(root, `src/renderer/i18n/locales/${locale}.json`), "utf8"));
  for (const key of ["collaboration.nav", "collaboration.inbox", "collaboration.empty", "collaboration.statusUnavailable", "collaboration.scopePersonal"]) {
    assert.equal(typeof messages[key], "string", `${locale} has ${key}`);
  }
}

console.log("collaboration shell source surface checks passed (not interaction E2E)");
