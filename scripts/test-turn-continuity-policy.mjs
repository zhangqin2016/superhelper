#!/usr/bin/env node
/**
 * Two ways a conversation used to lose work for reasons that were not its
 * fault, both observed in one session on 2026-09-23.
 *
 * A gateway that answers "temporarily unavailable" says nothing about whether
 * the engine session is healthy; when no side-effecting tool ran, discarding the
 * resume id there costs the whole context for a one-minute upstream outage. And an objective is prose, so
 * validating it as if it were an identifier rejected every multi-line goal —
 * silently, because the caller projects the task graph fail-open.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { shouldDropResumeAfterVisibleFailure } = require("../src/main/opencode-session-failure-policy.js");
const { createAgentTaskGraph, addAgentTask } = require("../src/main/agent-task-graph.js");

let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

// --------------------------------------------------- upstream vs. session
{
  const overloaded = { code: "MODEL_OVERLOADED" };
  assert.equal(
    shouldDropResumeAfterVisibleFailure({ classified: overloaded, wasResumed: true, sessionStateIndeterminate: false }),
    false,
    "nothing irreversible ran, so the resume is sound and only the upstream failed",
  );
  assert.equal(
    shouldDropResumeAfterVisibleFailure({ classified: overloaded, wasResumed: true, sessionStateIndeterminate: true }),
    true,
    "a side-effecting tool may have run unaccounted for — the original rule stands",
  );
  check("a transient upstream failure costs the conversation nothing when nothing irreversible ran");
}

{
  // The evidence only ever excuses a resumed session. Nothing else moves.
  assert.equal(shouldDropResumeAfterVisibleFailure({ classified: { code: "SESSION_INVALID" }, sessionStateIndeterminate: false }), true, "an invalid session must always be dropped");
  assert.equal(
    shouldDropResumeAfterVisibleFailure({ classified: { code: "MODEL_OVERLOADED" }, payload: { attachmentFallback: true }, sessionStateIndeterminate: false }),
    true,
    "an attachment fallback still needs isolating",
  );
  assert.equal(shouldDropResumeAfterVisibleFailure({ classified: { code: "SOMETHING_ELSE" }, wasResumed: true }), false, "an unrelated failure is unchanged");
  check("session-level faults and attachment isolation are untouched by the narrowing");
}

{
  // Default argument: a caller that has not been taught the new evidence yet
  // must keep getting the strict answer.
  assert.equal(
    shouldDropResumeAfterVisibleFailure({ classified: { code: "MODEL_OVERLOADED" }, wasResumed: true }),
    true,
    "omitting the evidence reproduces the previous behaviour exactly",
  );
  check("the narrowing is opt-in by evidence, so it cannot silently relax an old caller");
}

// ------------------------------------------------------- objective as prose
const graph = () => createAgentTaskGraph({ taskRunId: "run_1", sessionId: "s1", principalId: "p1", now: 1 });
const withObjective = (objective) => {
  const g = graph();
  addAgentTask(g, { id: "lead_1", agentId: "lead", depth: 0, objective, replaySafe: false, maxAttempts: 1, now: 1 });
  return g.tasks.lead_1;
};

{
  const multiline = "Ship the release:\n- cut the branch\n- run the suite\n- publish";
  assert.equal(withObjective(multiline).objective, multiline, "a multi-line objective is kept verbatim, line breaks and all");
  check("an objective written across several lines builds the graph instead of silently killing it");
}

{
  assert.equal(withObjective("first\r\nsecond").objective, "first\nsecond", "line endings are normalised so the same goal hashes the same everywhere");
  assert.equal(withObjective("col\tone").objective, "col\tone", "tabs are content too");
  assert.equal(withObjective("  padded  ").objective, "padded");
  check("line endings are normalised and surrounding whitespace trimmed");
}

{
  assert.throws(() => withObjective(""), /AGENT_TASK_FIELD_INVALID/, "an empty objective is still refused");
  assert.throws(() => withObjective("x".repeat(2_001)), /AGENT_TASK_FIELD_INVALID/, "the length bound is unchanged");
  assert.throws(() => withObjective(`bad${String.fromCharCode(0)}byte`), /AGENT_TASK_FIELD_INVALID/, "a NUL is still refused");
  assert.throws(() => withObjective(`bell${String.fromCharCode(7)}`), /AGENT_TASK_FIELD_INVALID/, "other control characters are still refused");
  check("only line breaks and tabs were allowed in; every other rejection stands");
}

{
  // Identifiers must NOT have been loosened along with the prose field.
  assert.throws(
    () => createAgentTaskGraph({ taskRunId: "run\n1", sessionId: "s1", principalId: "p1", now: 1 }),
    /AGENT_TASK_FIELD_INVALID/,
    "an identifier with a newline is still invalid",
  );
  check("identifiers keep the strict single-line rule");
}

console.log(`turn-continuity-policy: ok (${checks} checks)`);
