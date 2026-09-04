#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "server/scripts/migrate.mjs"), "utf8");

assert.match(source, /const client = await pool\.connect\(\)/, "migrations must reserve one database connection");
assert.match(source, /await client\.query\("begin"\)/, "migration transaction must begin on the reserved connection");
assert.match(source, /await client\.query\(sql\)/, "migration SQL must run on the reserved connection");
assert.match(source, /await client\.query\("commit"\)/, "migration transaction must commit on the reserved connection");
assert.match(source, /client\.release\(\)/, "the reserved connection must always be released");
assert(
  source.includes('.filter((name) => /^\\d{3}_[a-z0-9_]+\\.sql$/.test(name))'),
  "migration discovery must reject macOS AppleDouble files and other non-migration artifacts",
);
assert.doesNotMatch(
  source,
  /await pool\.query\("begin"\)[\s\S]*await pool\.query\("commit"\)/,
  "transaction statements must never be dispatched through the pool",
);
assert.match(source, /\[migrate\] applying \$\{file\}/, "migration logs must identify the file before executing it");

console.log("server-migration-transaction: ok");
