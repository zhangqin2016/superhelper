#!/usr/bin/env node
process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";

const appSettings = await import("../server/src/services/app-settings.js");

const normalized = appSettings.normalizeQiniuConfig({
  publicBaseUrl: "https://cdn.db",
  accessKey: "ak-db",
  secretKey: "sk-db",
  bucket: "bucket-db",
  uploadUrl: "https://upload.db",
});
if (normalized.accessKey !== "ak-db" || normalized.secretKey !== "sk-db") {
  throw new Error("normalizeQiniuConfig failed");
}

const current = appSettings.normalizeQiniuConfig({
  publicBaseUrl: "https://cdn.old",
  accessKey: "ak-old",
  secretKey: "sk-old",
  bucket: "bucket-old",
  uploadUrl: "https://upload.old",
});
const next = appSettings.normalizeQiniuConfig({
  publicBaseUrl: "https://cdn.new",
  accessKey: "ak-new",
  secretKey: "",
  bucket: "bucket-new",
  uploadUrl: "https://upload.new",
}, current);

if (next.secretKey !== "sk-old") {
  throw new Error("empty qiniu secret should keep existing value");
}
if (next.publicBaseUrl !== "https://cdn.new" || next.bucket !== "bucket-new") {
  throw new Error(`qiniu config fields did not update: ${JSON.stringify(next)}`);
}

console.log("app-settings: ok");
