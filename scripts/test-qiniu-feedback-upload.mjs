#!/usr/bin/env node
process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";
process.env.QINIU_ACCESS_KEY = "test-ak";
process.env.QINIU_SECRET_KEY = "test-sk";
process.env.QINIU_BUCKET = "test-bucket";
process.env.QINIU_PUBLIC_BASE_URL = "https://cdn.test";
process.env.QINIU_UPLOAD_URL = "https://upload.test";

const {
  createFeedbackUploadToken,
  normalizeFeedbackAttachmentInput,
  normalizeSubmittedAttachment,
} = await import("../server/src/services/qiniu-upload.js");

const token = createFeedbackUploadToken({
  deviceId: "dev_test",
  draftId: "draft_test",
  fileName: "bug screenshot.png",
  mimeType: "image/png",
  sizeBytes: 1024,
});

if (!token.token.startsWith("test-ak:")) {
  throw new Error(`unexpected upload token: ${token.token}`);
}
if (!token.key.startsWith("feedback/dev_test/draft_test/")) {
  throw new Error(`unexpected object key: ${token.key}`);
}
if (token.publicUrl !== `https://cdn.test/${token.key}`) {
  throw new Error(`unexpected public URL: ${token.publicUrl}`);
}
if (normalizeFeedbackAttachmentInput({ mimeType: "text/plain", sizeBytes: 10 }).ok) {
  throw new Error("plain text must not be accepted as feedback image attachment");
}
if (normalizeFeedbackAttachmentInput({ mimeType: "image/png", sizeBytes: 11 * 1024 * 1024 }).ok) {
  throw new Error("oversized image must not be accepted");
}

const submitted = normalizeSubmittedAttachment({
  key: token.key,
  mimeType: "image/png",
  sizeBytes: 1024,
  name: "bug.png",
});
if (!submitted || submitted.object_key !== token.key || submitted.public_url !== token.publicUrl) {
  throw new Error(`submitted attachment was not normalized: ${JSON.stringify(submitted)}`);
}

console.log("qiniu-feedback-upload: ok");
