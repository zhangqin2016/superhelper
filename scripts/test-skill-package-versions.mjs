#!/usr/bin/env node
import assert from "node:assert/strict";
import { publishedPackConflict } from "../server/src/services/skill-package-versions.js";
const a = "a".repeat(64), b = "b".repeat(64);
assert.deepEqual(publishedPackConflict({ sha256: a }, b), { code: "SKILL_VERSION_IMMUTABLE", publishedSha256: a }, "a different pack under a published version is refused");
assert.equal(publishedPackConflict({ sha256: a.toUpperCase() }, a), null, "the same pack (metadata update) is allowed");
assert.equal(publishedPackConflict(undefined, b), null, "a new version is allowed");
assert.equal(publishedPackConflict({ sha256: "" }, b), null, "a row without a digest does not block");
console.log("skill-package-versions: ok (4 checks)");
