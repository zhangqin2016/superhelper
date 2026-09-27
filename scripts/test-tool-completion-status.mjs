#!/usr/bin/env node
// The shared recovery-aware tool classifier, used by BOTH the main turn summary
// and the subagent projection so a recovered retry never reads as a failed task.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { isFailedToolStatus, isDoneToolStatus, partitionToolCompletion } = require("../src/main/tool-completion-status.js");

assert.equal(isFailedToolStatus("failed"), true);
assert.equal(isFailedToolStatus("timeout"), true);
assert.equal(isFailedToolStatus("running"), false);
assert.equal(isDoneToolStatus("success"), true);
assert.equal(isDoneToolStatus("completed"), true);
assert.equal(isDoneToolStatus("failed"), false);

// A no-match grep (exit 1) that a LATER grep recovers is recovered, not failed.
{
  const part = partitionToolCompletion([
    { id: "1", name: "grep", status: "failed" },
    { id: "2", name: "grep", status: "done" },
  ]);
  assert.equal(part.failed.length, 0, "recovered failure is not failed");
  assert.equal(part.recovered.length, 1);
  assert.equal(part.done.length, 1);
}

// A failure with no later same-name success stays failed.
{
  const part = partitionToolCompletion([
    { id: "1", name: "bash", status: "failed" },
    { id: "2", name: "read", status: "done" },
  ]);
  assert.equal(part.failed.length, 1, "an unrecovered failure stays failed");
  assert.equal(part.recovered.length, 0);
}

// Recovery is per-tool-name and order-sensitive: a success BEFORE the failure
// does not recover it (the later attempt failed).
{
  const part = partitionToolCompletion([
    { id: "1", name: "bash", status: "done" },
    { id: "2", name: "bash", status: "failed" },
  ]);
  assert.equal(part.failed.length, 1, "an earlier success does not recover a later failure");
  assert.equal(part.recovered.length, 0);
}

console.log("tool-completion-status: ok");
