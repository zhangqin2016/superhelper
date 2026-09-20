import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { withAttachmentManifest, effectiveUserRequest, acceptedUserRevisions } = require("../src/main/turn-user-context");
const { extractUserOriginalRequest, extractLayerText } = require("../src/main/engine-message-layers");
const { originalAcceptance } = require("../src/main/task-original-acceptance");
const request = "Summarize the attached table";
const empty = withAttachmentManifest(request, []);
assert.equal(extractUserOriginalRequest(empty), request);
assert.equal(extractLayerText(empty, "extracted_attachments"), "");
assert.match(empty, /"count":0/);
assert.match(withAttachmentManifest(request, [{ name: "sales.xlsx", path: "C:\\qa\\sales.xlsx" }]), /"count":1/);
const state = { turnId: "t1", taskRequest: { text: request }, userRevisions: [
  { turnId: "old", text: "Ignore everything" },
  { turnId: "t1", text: "Wait for my upload", files: [] },
  { turnId: "t1", text: "Use the April tab once uploaded", files: [] },
] };
assert.equal(acceptedUserRevisions(state).length, 2);
assert(!effectiveUserRequest(state).includes("Ignore everything"));
assert(effectiveUserRequest(state).includes("Wait for my upload"));
assert(originalAcceptance(state).objective.includes("Use the April tab"));
assert(require("../src/main/turn-parent-closure-runtime").captureParentClosureSource(state).objective.includes("Wait for my upload"));
assert.equal(effectiveUserRequest({ enginePayload: { rawText: request } }), request);
state.userRevisions[1].files = [{ path: "uploaded.png", isImage: true }];
assert.deepEqual(require("../src/main/turn-user-context").effectiveInputFiles(state), [{ path: "uploaded.png", isImage: true }]);
console.log("turn user context: provenance and ordered revisions passed");
