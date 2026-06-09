import assert from "node:assert/strict";

process.env.QINIU_PUBLIC_BASE_URL = "https://cdn.example.test/";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";

const { normalizeAttachmentForAdmin } = await import("../server/src/routes/admin/contacts.js");

const normalized = normalizeAttachmentForAdmin({
  id: "att_1",
  object_key: "/feedback/device/draft/screenshot.png",
  public_url: "",
});

assert.equal(normalized.public_url, "https://cdn.example.test/feedback/device/draft/screenshot.png");
assert.equal(normalized.publicUrl, normalized.public_url);

const storedOnly = normalizeAttachmentForAdmin({
  id: "att_2",
  object_key: "",
  public_url: "https://legacy.example.test/screenshot.png",
});

assert.equal(storedOnly.public_url, "https://legacy.example.test/screenshot.png");
assert.equal(storedOnly.publicUrl, storedOnly.public_url);

console.log("test-admin-contact-attachments: ok");
