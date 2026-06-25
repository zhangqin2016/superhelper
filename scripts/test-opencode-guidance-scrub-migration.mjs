#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { scrubInjectedOpencodeGuidanceParts } = require("../src/main/data-migration.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-opencode-scrub-"));
const dbPath = path.join(dir, "opencode.db");
const db = openDatabase(dbPath);
db.exec(`
  CREATE TABLE message (
    id text PRIMARY KEY,
    session_id text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL
  );
  CREATE TABLE part (
    id text PRIMARY KEY,
    message_id text NOT NULL,
    session_id text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL
  );
`);
db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", "m1", "s1", 1, 1, "{}");
db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", "p1", "m1", "s1", 1, 1, JSON.stringify({ type: "text", text: "# 智能工作台全局说明\nhidden" }));
db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", "p2", "m1", "s1", 2, 2, JSON.stringify({ type: "text", text: "真实问题" }));
db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", "m2", "s1", 3, 3, "{}");
db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", "p3", "m2", "s1", 3, 3, JSON.stringify({ type: "text", text: "# 智能工作台全局说明\nonly hidden" }));
db.close();

assert.equal(scrubInjectedOpencodeGuidanceParts(dbPath), 2, "two injected parts scrubbed");

const verify = openDatabase(dbPath);
assert.equal(verify.get("SELECT COUNT(*) AS count FROM part WHERE data LIKE ?", "%# 智能工作台全局说明%").count, 0, "no injected marker remains");
assert.equal(verify.get("SELECT COUNT(*) AS count FROM part WHERE data LIKE ?", "%真实问题%").count, 1, "real user part remains");
assert.equal(verify.get("SELECT COUNT(*) AS count FROM message WHERE id = ?", "m1").count, 1, "message with real part remains");
assert.equal(verify.get("SELECT COUNT(*) AS count FROM message WHERE id = ?", "m2").count, 0, "message left empty by scrub is removed");
verify.close();

console.log("opencode-guidance-scrub-migration: ok");
