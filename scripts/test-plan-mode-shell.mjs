#!/usr/bin/env node
//
// Plan mode investigates with the shell (2026-09-28 integration audit): it used
// to deny EVERY bash command, so a plan could not run `ls` or `git log`, where
// the engine's plan agent and Claude Code's plan mode both allow it. A provably
// read-only command now runs; anything else asks the user; edits stay denied.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isProvablyReadOnlyShell } = require("../src/main/runtime/shell-read-only.js");
const { decidePermission } = require("../src/main/runtime/opencode-permission-policy.js");

const readOnly = [
  "ls -la",
  "pwd",
  "cat README.md",
  "head -n 40 src/main.js",
  "rg -n \"decidePermission\" src/main",
  "grep -rn TODO src",
  "find . -name package.json -maxdepth 3",
  "git status",
  "git log --oneline -20",
  "git diff HEAD~1 -- src/main/turn-orchestrator.js",
  "git show --stat HEAD",
  "wc -l src/main/*.js",
  "ls src && git status",
  "cat package.json | jq .version",
  "du -sh node_modules",
  "sort names.txt",
  "tree -L 2 src",
];
for (const command of readOnly) {
  assert.equal(isProvablyReadOnlyShell(command), true, `read-only: ${command}`);
}

const notProvable = [
  "",
  "echo hi > notes.txt",
  "cat a >> b",
  "ls; rm -rf build",
  "ls && npm install",
  "cat $(rm -rf ~)",
  "cat `rm -rf ~`",
  "find . -name '*.tmp' -delete",
  "find . -exec rm {} \\;",
  "rg --pre ./evil.sh foo",
  "sort -o names.txt names.txt",
  "sort -ro out.txt in.txt",
  "tree -o tree.txt",
  "git branch new-feature",
  "git checkout main",
  "git -c core.pager=evil log",
  "git log --output=patch.txt",
  "git diff --output=out.patch",
  "grep -rl foo . | xargs rm",
  "FOO=bar ls",
  "sleep 100 &",
  "python3 script.py",
  "node -e \"require('fs').writeFileSync('x','y')\"",
  "sed -i s/a/b/ file.txt",
  "cat <<EOF > x\nhi\nEOF",
  "ls |",
];
for (const command of notProvable) {
  assert.equal(isProvablyReadOnlyShell(command), false, `not provably read-only: ${JSON.stringify(command)}`);
}

// Plan mode: read-only shell runs, anything else is the user's call, edits denied.
assert.equal(decidePermission("plan", "bash", { command: "git log --oneline -5" }, {}), "allow", "plan runs read-only shell");
assert.equal(decidePermission("plan", "bash", { command: "npm install" }, {}), "ask", "plan asks before any other shell");
assert.equal(decidePermission("plan", "bash", { command: "npm install" }, { nonInteractive: true }), "deny", "unattended plan turn still denies what it would ask");
assert.equal(decidePermission("plan", "edit", { filePath: "src/a.js" }, {}), "deny", "plan still denies edits");
assert.equal(decidePermission("plan", "write", { filePath: "src/a.js" }, {}), "deny", "plan still denies writes");
assert.equal(decidePermission("plan", "bash", { command: "rm -rf /" }, {}), "ask", "catastrophic backstop unchanged");

console.log(`plan-mode-shell: ok (${readOnly.length} read-only, ${notProvable.length} refused)`);
