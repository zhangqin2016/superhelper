#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(path.join(root, "server/migrations/032_collaboration_identity.sql"), "utf8");

assert.match(migration, /create table if not exists user_profiles/i);
assert.match(migration, /user_id\s+text\s+primary key/i);
assert.match(migration, /lily_id\s+text\s+not null/i);
assert.match(migration, /lily_id_display\s+text\s+not null/i);
assert.match(migration, /unique\s*\(\s*lily_id\s*\)/i);
assert.match(migration, /discoverability/i);
assert.doesNotMatch(migration, /^\s*(phone|email|mobile)\s+\w+/im);

console.log("collaboration-schema: ok");
