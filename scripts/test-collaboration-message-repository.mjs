import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../server/src/services/collaboration/message-repository.js", import.meta.url), "utf8");
for (const method of ["activeConversationMemberIds", "findReplyTarget", "findAttachments", "insertMessage", "findMessageForUpdate", "compareAndSwapMessage", "insertMessageRevision", "advanceLastReadSeq", "listHistory"]) assert.match(source, new RegExp(`async ${method}`));
assert.match(source, /user_devices[\s\S]*status", "=", "active/);
assert.match(source, /friendships[\s\S]*forUpdate/);
assert.match(source, /user_blocks[\s\S]*forUpdate/);
assert.match(source, /organization_members[\s\S]*forUpdate/);
assert.match(source, /visibleAfterSeq/);
console.log("collaboration message repository: ok");
