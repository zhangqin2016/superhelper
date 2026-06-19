#!/usr/bin/env node
/**
 * A learned draft written one level too deep (inbox/<id>/<id>/, e.g. the
 * generator invoked with --out already including the id) used to get stuck
 * invisibly in the inbox — the user couldn't find their workspace skill.
 * collectLearnedSkillDrafts must tolerate that single nesting and still register.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { collectLearnedSkillDrafts } = require("../src/main/learned-skills.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-inbox-"));

function writeDraft(dir, id, name = "X") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "skill.manifest.json"), JSON.stringify({ schemaVersion: 1, id, name, version: "1.0.0" }));
  fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${name}\n`);
}

try {
  // flat (correct) draft
  writeDraft(path.join(tmp, "bar"), "bar", "Bar");
  // nested draft: inbox/foo/foo/ (the bug) — manifest is one level deep
  writeDraft(path.join(tmp, "foo", "foo"), "foo", "Foo Nested");
  // junk dir: no manifest at top, no single valid child → must be skipped
  fs.mkdirSync(path.join(tmp, "baz", "sub-a"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "baz", "sub-b"), { recursive: true });

  const registered = [];
  const fakeRegister = (dir, manifest) => {
    registered.push({ dir, id: manifest.id });
    return `learned-${manifest.id}`;
  };

  const ids = collectLearnedSkillDrafts(fakeRegister, tmp, {});

  assert(ids.includes("learned-bar"), "flat draft registered");
  assert(ids.includes("learned-foo"), "NESTED draft registered (the fix) — workspace skill no longer stuck");
  assert(!ids.includes("learned-baz"), "junk dir without a valid draft is skipped");

  // the nested draft must be registered from the inner dir (where the manifest is)
  const foo = registered.find((r) => r.id === "foo");
  assert(foo.dir === path.join(tmp, "foo", "foo"), `nested draft registered from inner dir, got ${foo.dir}`);

  // successfully-registered drafts are consumed (outer inbox dir removed)
  assert(!fs.existsSync(path.join(tmp, "bar")), "flat draft consumed from inbox");
  assert(!fs.existsSync(path.join(tmp, "foo")), "nested draft's outer dir consumed from inbox");
  // the junk dir stays for the model to fix
  assert(fs.existsSync(path.join(tmp, "baz")), "junk dir left in inbox");

  console.log("PASS: test-learned-skills-collect (7 tests)");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
