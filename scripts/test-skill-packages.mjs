#!/usr/bin/env node
import assert from "node:assert/strict";
process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";
import {
  buildSkillRegistry,
  evaluateSkillPackageQuality,
  isValidSkillArtifactUrl,
  isValidSkillSha256,
  newestSkillPackages,
  skillPackageObjectKey,
  validateSkillPackageArtifact,
} from "../server/src/services/skill-packages.js";

assert.equal(isValidSkillArtifactUrl("https://cdn.example.com/a.skillpack.zip"), true);
assert.equal(isValidSkillArtifactUrl("http://cdn.example.com/a.skillpack.zip"), false);
assert.equal(isValidSkillArtifactUrl("not a url"), false);

assert.equal(isValidSkillSha256("a".repeat(64)), true);
assert.equal(isValidSkillSha256("A".repeat(64)), true);
assert.equal(isValidSkillSha256("abc"), false);

const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const validArtifact = validateSkillPackageArtifact({
  buffer: zipBytes,
  fileName: "lily-code.skillpack.zip",
});
assert.equal(validArtifact.ok, true);
assert.equal(validArtifact.sizeBytes, zipBytes.length);
assert.equal(
  validateSkillPackageArtifact({ buffer: Buffer.from("plain text"), fileName: "bad.txt" }).code,
  "INVALID_SKILL_PACKAGE_NAME",
);
assert.equal(
  validateSkillPackageArtifact({ buffer: Buffer.from("plain text"), fileName: "bad.skillpack.zip" }).code,
  "INVALID_SKILL_PACKAGE_ZIP",
);
assert.equal(
  skillPackageObjectKey({
    skillId: "lily code",
    version: "1.0.0",
    fileName: "lily code.skillpack.zip",
    id: "skillpkg_test",
  }),
  "skill-packages/lily-code/1.0.0/skillpkg_test-lily-code.skillpack.zip",
);

process.env.QINIU_ACCESS_KEY = "test-ak";
process.env.QINIU_SECRET_KEY = "test-sk";
process.env.QINIU_BUCKET = "test-bucket";
process.env.QINIU_PUBLIC_BASE_URL = "https://cdn.test";
process.env.QINIU_UPLOAD_URL = "https://upload.test";
const qiniuConfig = {
  publicBaseUrl: "https://cdn.test",
  accessKey: "test-ak",
  secretKey: "test-sk",
  bucket: "test-bucket",
  uploadUrl: "https://upload.test",
};
const { uploadBufferToQiniu } = await import("../server/src/services/qiniu-upload.js");
const uploaded = await uploadBufferToQiniu({
  key: "skill-packages/lily-code/1.0.0/lily-code.skillpack.zip",
  buffer: zipBytes,
  fileName: "lily-code.skillpack.zip",
  mimeType: "application/zip",
  qiniuConfig,
  fetchImpl: async (url, options) => {
    assert.equal(url, "https://upload.test");
    assert.equal(options.method, "POST");
    assert.equal(typeof options.body?.get, "function");
    assert.equal(options.body.get("key"), "skill-packages/lily-code/1.0.0/lily-code.skillpack.zip");
    assert.ok(String(options.body.get("token")).startsWith("test-ak:"));
    return { ok: true, status: 200 };
  },
});
assert.equal(uploaded.publicUrl, "https://cdn.test/skill-packages/lily-code/1.0.0/lily-code.skillpack.zip");
assert.equal(uploaded.sizeBytes, zipBytes.length);

const rows = [
  {
    skill_id: "lily-code",
    name: "Code",
    version: "1.0.0",
    artifact_url: "https://cdn.example.com/lily-code-1.skillpack.zip",
    sha256: "a".repeat(64),
    enabled: true,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    skill_id: "lily-code",
    name: "Code",
    version: "1.1.0",
    artifact_url: "https://cdn.example.com/lily-code-1.1.skillpack.zip",
    sha256: "b".repeat(64),
    category: "coding",
    category_label: "编程创作",
    capability_layer: "workflow",
    risk_level: "medium",
    default_eligible: true,
    featured: true,
    enabled: true,
    created_at: "2026-01-02T00:00:00.000Z",
  },
  {
    skill_id: "lily-hidden",
    name: "Hidden",
    version: "9.0.0",
    artifact_url: "https://cdn.example.com/hidden.skillpack.zip",
    sha256: "c".repeat(64),
    enabled: false,
    created_at: "2026-01-03T00:00:00.000Z",
  },
];

const newest = newestSkillPackages(rows);
assert.equal(newest.length, 1, "disabled packages must not enter the public registry");
assert.equal(newest[0].version, "1.1.0", "registry must publish newest enabled package per skill id");

const registry = buildSkillRegistry(rows, { registryUrl: "https://service.example.com/api/skills/registry" });
assert.equal(registry.schemaVersion, 1);
assert.equal(registry.registryUrl, "https://service.example.com/api/skills/registry");
assert.equal(registry.skills.length, 1);
assert.equal(registry.skills[0].id, "lily-code");
assert.equal(registry.skills[0].sourceType, "zip");
assert.equal(registry.skills[0].downloadUrl, "https://cdn.example.com/lily-code-1.1.skillpack.zip");
assert.equal(registry.skills[0].sha256, "b".repeat(64));
assert.equal(registry.skills[0].category, "coding");
assert.equal(registry.skills[0].capabilityLayer, "workflow");
assert.equal(registry.skills[0].riskLevel, "medium");
assert.equal(registry.skills[0].defaultEligible, true);
assert.equal(registry.skills[0].featured, true);

const highQualityInput = {
  skillId: "lily-app-builder",
  name: "Lily App Builder",
  description: "Turns plain-language requests for webpages, small tools, scripts, automations, and local apps into runnable deliverables with verification and exact paths.",
  version: "1.0.0",
  category: "coding",
  capabilityLayer: "workflow",
  sourceKind: "lily",
  artifactUrl: "https://cdn.example.com/lily-app-builder.skillpack.zip",
  sha256: "d".repeat(64),
  riskLevel: "low",
  defaultEligible: true,
  featured: true,
};
const highQuality = evaluateSkillPackageQuality(highQualityInput);
assert.equal(highQuality.ok, true, `high-quality skill should pass: ${highQuality.issues.join(", ")}`);

const weakDescription = evaluateSkillPackageQuality({
  ...highQualityInput,
  description: "Useful skill",
});
assert.equal(weakDescription.ok, false);
assert.equal(
  weakDescription.issues.some((issue) => issue.includes("Description")),
  true,
);

const highRiskDefault = evaluateSkillPackageQuality({
  ...highQualityInput,
  riskLevel: "high",
});
assert.equal(highRiskDefault.ok, false);
assert.equal(
  highRiskDefault.issues.some((issue) => issue.includes("High-risk")),
  true,
);

const externalDefault = evaluateSkillPackageQuality({
  ...highQualityInput,
  sourceKind: "external",
});
assert.equal(externalDefault.ok, false);
assert.equal(
  externalDefault.issues.some((issue) => issue.includes("Lily-reviewed")),
  true,
);

console.log("skill-packages: ok");
