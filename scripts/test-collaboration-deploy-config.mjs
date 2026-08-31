import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readCollaborationObjectConfig } from "../server/src/services/collaboration/object-config.js";

const keys = ["COLLAB_QINIU_ACCESS_KEY", "COLLAB_QINIU_SECRET_KEY", "COLLAB_QINIU_BUCKET", "COLLAB_QINIU_PRIVATE_BASE_URL", "COLLAB_QINIU_UPLOAD_URL", "COLLAB_QINIU_PRIVATE_BUCKET", "COLLAB_OBJECT_KEK", "COLLAB_OBJECT_KEK_VERSION", "COLLAB_OBJECT_KEKS"];
for (const file of ["server/.env.example", "deploy/baota/.env.example"]) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const entries = text.split("\n").filter((line) => /^[A-Z_]+=/.test(line)).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
  const env = Object.fromEntries(entries);
  for (const key of keys) assert.equal(entries.filter(([name]) => name === key).length, 1, `${file}: exactly one explicit ${key}`);
  assert.equal(env.COLLABORATION_ENABLED, "false");
  assert.equal(env.COLLABORATION_ATTACHMENTS_ENABLED, "false");
  assert.equal(env.COLLABORATION_WORKSPACE_SHARES_ENABLED, "false");
  assert.equal(env.COLLAB_QINIU_PRIVATE_BUCKET, "false", "sample must not claim the operator verified bucket ACL");
  for (const key of ["COLLAB_QINIU_ACCESS_KEY", "COLLAB_QINIU_SECRET_KEY", "COLLAB_OBJECT_KEK", "COLLAB_OBJECT_KEKS"]) assert.equal(env[key], "", "no sample or live credentials");
  const config = readCollaborationObjectConfig(env);
  assert.equal(config.collaborationObjectStorage.privateBucket, false);
  assert.equal(config.collaborationObjectKekVersion, "v1");
}
for (const variant of ["", ".app-only", ".external-postgres", ".images-app-only"]) {
  const text = readFileSync(new URL(`../deploy/baota/docker-compose${variant}.yml`, import.meta.url), "utf8");
  const api = text.split(/^  api:\s*$/m)[1]?.split(/^  [a-z][\w-]*:\s*$/m)[0];
  const web = text.split(/^  web:\s*$/m)[1]?.split(/^  [a-z][\w-]*:\s*$/m)[0];
  assert.match(api || "", /env_file:\s*\n\s+- \.env/, "API receives dedicated storage settings through existing env_file");
  assert.doesNotMatch(web || "", /env_file:|COLLAB_(?:OBJECT|QINIU)/, "web/browser must not receive storage keys");
}
console.log("collaboration deploy config: explicit disabled examples, empty secrets and API-only env delivery passed");
