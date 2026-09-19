#!/usr/bin/env node
// Small helpers that were copied verbatim have one home each.
// codedError: 7 identical copies → src/main/coded-error.js.
// isPlainObject: 5 identical copies → src/main/plain-object.js.
// (Three codedError variants that build a different message on purpose stay
// where they are — they are not copies.) [gate: helper-single-copies]
// Run: node scripts/test-shared-helpers.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { codedError } = require("../src/main/coded-error.js");
const { isPlainObject } = require("../src/main/plain-object.js");
let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

check("codedError carries the code in both places callers read it", () => {
  const e = codedError("THING_MISSING", "no thing", { status: 404 });
  assert.equal(e.code, "THING_MISSING"); assert.equal(e.message, "THING_MISSING: no thing"); assert.equal(e.status, 404);
  assert.equal(codedError("X").message, "X: X", "the message defaults to the code");
  assert.equal(codedError("X", "m", { code: "Y" }).code, "X", "details never overwrite the code");
});

check("isPlainObject is the usual definition", () => {
  assert.equal(isPlainObject({}), true); assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false); assert.equal(isPlainObject(null), false); assert.equal(isPlainObject(new Date()), false);
});

check("no verbatim copy of either helper remains", () => {
  const offenders = [];
  const CE = /function codedError\(code, message = code\) \{\n\s*const error = new Error\(`\$\{code\}: \$\{message\}`\);/;
  const IPO = /function isPlainObject\(value\) \{\n\s*if \(!value \|\| typeof value !== "object" \|\| Array\.isArray\(value\)\) return false;\n\s*const prototype = Object\.getPrototypeOf\(value\);/;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const rel = path.relative(ROOT, full);
      if (rel === "src/main/coded-error.js" || rel === "src/main/plain-object.js") continue;
      const code = fs.readFileSync(full, "utf8");
      if (CE.test(code)) offenders.push(`${rel}: codedError copy`);
      if (IPO.test(code)) offenders.push(`${rel}: isPlainObject copy`);
    }
  };
  walk(path.join(ROOT, "src/main"));
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

console.log(`\n${checks} checks passed (shared helpers)`);
