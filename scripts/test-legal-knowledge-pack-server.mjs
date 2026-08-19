import assert from "node:assert/strict";
import {
  LEGAL_KB_CHARACTER_ID,
  isValidLegalPackArtifact,
  newestLegalPack,
  legalPackArtifactForViewer,
} from "../server/src/services/legal-knowledge-packs.js";
import { qiniuPrivateDownloadUrlForUrl } from "../server/src/services/qiniu-download.js";

assert.equal(LEGAL_KB_CHARACTER_ID, "lily-cn-legal-counsel");
const rows = [
  {
    id: "old",
    pack_id: "legal-cn-enterprise",
    character_id: LEGAL_KB_CHARACTER_ID,
    version: "V23.2",
    url: "https://qny.lanrensoft.cn/legal-kb/V23.2.zip",
    sha256: "a".repeat(64),
    size_bytes: 100,
    format: "zip",
    schema_version: 1,
    min_plan: "free",
    enabled: true,
    created_at: "2026-08-10T00:00:00.000Z",
  },
  {
    id: "new",
    pack_id: "legal-cn-enterprise",
    character_id: LEGAL_KB_CHARACTER_ID,
    version: "V23.3",
    url: "https://qny.lanrensoft.cn/legal-kb/V23.3.zip",
    sha256: "b".repeat(64),
    size_bytes: 200,
    format: "zip",
    schema_version: 1,
    min_plan: "free",
    enabled: true,
    created_at: "2026-08-17T00:00:00.000Z",
  },
];
assert.equal(newestLegalPack(rows).id, "new");
assert.equal(isValidLegalPackArtifact(rows[1]), true);
assert.equal(isValidLegalPackArtifact({ ...rows[1], url: "http://evil.test/a.zip" }), false);
assert.equal(isValidLegalPackArtifact({ ...rows[1], sha256: "bad" }), false);
assert.equal(legalPackArtifactForViewer(rows, { characterId: LEGAL_KB_CHARACTER_ID, viewerPlan: "pro" }).ok, true);
assert.equal(legalPackArtifactForViewer(rows, { characterId: LEGAL_KB_CHARACTER_ID, viewerPlan: "free" }).ok, true);
assert.equal(legalPackArtifactForViewer(rows, { characterId: "other", viewerPlan: "enterprise" }).code, "LEGAL_KB_NOT_FOUND");
assert.equal(legalPackArtifactForViewer(rows.map((row) => ({ ...row, enabled: false })), { characterId: LEGAL_KB_CHARACTER_ID, viewerPlan: "enterprise" }).code, "LEGAL_KB_NOT_FOUND");

const signedUrl = qiniuPrivateDownloadUrlForUrl({
  url: rows[1].url,
  qiniuConfig: {
    publicBaseUrl: "https://qny.lanrensoft.cn",
    accessKey: "ak",
    secretKey: "sk",
  },
  nowMs: 1_755_408_000_000,
});
assert.match(signedUrl, /^https:\/\/qny\.lanrensoft\.cn\/legal-kb\/V23\.3\.zip\?e=\d+&token=ak:/);
assert.equal(qiniuPrivateDownloadUrlForUrl({
  url: rows[1].url,
  qiniuConfig: { publicBaseUrl: "https://other.example", accessKey: "ak", secretKey: "sk" },
}), rows[1].url);

console.log("legal kb server tests passed");
