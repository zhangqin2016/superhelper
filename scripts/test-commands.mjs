#!/usr/bin/env node
// Slash commands: template parse, $ARGUMENTS/$N substitution, /name expansion,
// multi-source loading + precedence (project overrides bundled). Expansion is a
// pure function so a wrong command never silently mangles a normal message.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// globalCommandsDir() reads userData — point it at an empty temp dir so loading
// only sees bundled + the workspace we create.
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "lily-cmd-ud-"));
process.env.LILY_USER_DATA_DIR = ud;
process.env.LILY_HOME = ud;

const { loadCommands, expandCommand, parseTemplate, applyArgs } = require("../src/main/commands.js");

// --- parseTemplate: frontmatter split ---
const p = parseTemplate("---\ndescription: Do X\nargument-hint: <thing>\n---\nBody $ARGUMENTS here");
assert.equal(p.description, "Do X", "description parsed");
assert.equal(p.argHint, "<thing>", "argument-hint parsed");
assert.equal(p.template, "Body $ARGUMENTS here", "body is the template (frontmatter stripped)");

// --- applyArgs: $ARGUMENTS / $@ / $1..$9 / quotes ---
assert.equal(applyArgs("re: $ARGUMENTS", "the auth flow"), "re: the auth flow", "$ARGUMENTS = full rest");
assert.equal(applyArgs("$1 then $2", "alpha beta gamma"), "alpha then beta", "positional $1/$2");
assert.equal(applyArgs('$1', '"two words" tail'), "two words", "$1 respects quotes");
assert.equal(applyArgs("[$3]", "only one"), "[]", "missing positional -> empty");

// --- expandCommand ---
const cmds = [{ name: "review", template: "Review: $ARGUMENTS" }, { name: "dir:sub", template: "X" }];
assert.equal(expandCommand("hello world", cmds), null, "normal text is not a command");
assert.equal(expandCommand("/nope args", cmds), null, "unknown command -> null (sent as-is)");
const ex = expandCommand("/review the parser", cmds);
assert.ok(ex && ex.name === "review" && ex.prompt === "Review: the parser", "known command expands with args");
assert.equal(expandCommand("/REVIEW x", cmds).name, "review", "command match is case-insensitive");
assert.ok(expandCommand("/dir:sub", cmds), "namespaced command name matches");

// --- loadCommands: bundled defaults + project override precedence ---
const bundled = loadCommands("");
const names = bundled.map((c) => c.name);
for (const n of ["review", "explain", "test-fix"]) assert.ok(names.includes(n), `bundled command ${n} loaded`);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "lily-cmd-ws-"));
fs.mkdirSync(path.join(ws, ".claude", "commands"), { recursive: true });
fs.writeFileSync(path.join(ws, ".claude", "commands", "review.md"), "PROJECT REVIEW $ARGUMENTS");
fs.writeFileSync(path.join(ws, ".claude", "commands", "deploy.md"), "---\ndescription: ship it\n---\nDeploy $ARGUMENTS");
const withWs = loadCommands(ws);
const review = withWs.find((c) => c.name === "review");
assert.equal(review.source, "project", "project command overrides bundled on name collision");
assert.equal(review.template, "PROJECT REVIEW $ARGUMENTS", "project template wins");
assert.ok(withWs.find((c) => c.name === "deploy" && c.description === "ship it"), "project-only command loaded with description");

fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(ws, { recursive: true, force: true });
console.log("commands: ok");
