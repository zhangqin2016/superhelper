#!/usr/bin/env node
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-support-contact-"));

delete process.env.LILY_SERVICE_API_BASE_URL;
delete process.env.SERVICE_API_BASE_URL;
process.resourcesPath = ROOT;

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath(name) {
        if (name === "userData") return tmp;
        if (name === "home") return os.homedir();
        return os.tmpdir();
      },
      getVersion: () => "0.1.16",
    },
  },
};

const supportContact = require(path.join(ROOT, "src/main/support-contact.js"));

const missing = await supportContact.submitContactRequestPublic({
  name: "",
  email: "bad",
  message: "short",
});
if (missing.ok || missing.error !== "VALIDATION_ERROR") {
  throw new Error("expected VALIDATION_ERROR for invalid contact payload");
}

let capturedBody = null;
const serviceClientPath = require.resolve(path.join(ROOT, "src/main/service-client.js"));
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: {
    ...require(serviceClientPath),
    submitContactRequest: async (payload) => {
      capturedBody = payload;
      return { ok: true, json: { ok: true, id: "contact_test" } };
    },
    requestFeedbackAttachmentUpload: async (payload) => ({
      ok: true,
      json: {
        key: `feedback/dev_test/test/${payload.fileName}`,
        token: "test-token",
        uploadUrl: "https://upload.test",
        publicUrl: `https://cdn.test/feedback/dev_test/test/${payload.fileName}`,
      },
    }),
    uploadFeedbackAttachment: async (upload, attachment) => ({
      ok: true,
      attachment: {
        key: upload.key,
        url: upload.publicUrl,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        width: attachment.width,
        height: attachment.height,
        sha256: attachment.sha256,
      },
    }),
    getDeviceId: () => "dev_test",
    devicePayload: () => ({ platform: "darwin", arch: "arm64" }),
  },
};
delete require.cache[require.resolve(path.join(ROOT, "src/main/support-contact.js"))];
const supportWithMock = require(path.join(ROOT, "src/main/support-contact.js"));

const feedback = await supportWithMock.submitContactRequestPublic({
  name: "Tester",
  email: "test@example.com",
  message: "Something broke in the settings panel.",
  source: "desktop-feedback",
  appendContext: {
    appVersion: "0.1.16",
    deviceId: "dev_test",
    platform: "darwin",
    arch: "arm64",
    category: "bug",
  },
  attachments: [
    {
      name: "bug.png",
      mimeType: "image/png",
      sizeBytes: 4,
      width: 120,
      height: 80,
      data: Uint8Array.from([1, 2, 3, 4]).buffer,
    },
  ],
});

if (!feedback.ok || feedback.id !== "contact_test") {
  throw new Error(`feedback submit failed: ${JSON.stringify(feedback)}`);
}
if (!capturedBody?.message.includes("App: 0.1.16") || !capturedBody.message.includes("Category: bug")) {
  throw new Error("feedback message should include appended context");
}
if (capturedBody.source !== "desktop-feedback") {
  throw new Error("expected desktop-feedback source");
}
if (capturedBody.attachments?.[0]?.key !== "feedback/dev_test/test/bug.png") {
  throw new Error(`expected uploaded attachment metadata, got ${JSON.stringify(capturedBody.attachments)}`);
}
if (capturedBody.attachments[0].data) {
  throw new Error("feedback payload must not include raw attachment bytes");
}

console.log("support-contact: ok");
