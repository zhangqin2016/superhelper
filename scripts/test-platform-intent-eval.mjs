#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildTaskContract } = require("../src/main/task-contract.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");
const { planCapabilityReadiness } = require("../src/main/capability-readiness.js");

const fixture = JSON.parse(fs.readFileSync("fixtures/evals/platform-intent-contract.json", "utf8"));
assert.equal(fixture.schemaVersion, 1);
assert(Array.isArray(fixture.scenarios) && fixture.scenarios.length >= 5);

function archivedAssistant(contract, userText) {
  return {
    role: "assistant",
    content: "Turn completed.",
    record: {
      terminal: "turn.completed",
      user: { text: userText },
      meta: {
        taskContract: {
          active: contract.active,
          kind: contract.kind,
          taskType: contract.taskType,
          categories: contract.categories,
          verificationStrategy: contract.verificationStrategy || [],
          externalFact: contract.externalFactPolicy?.required
            ? {
                reasonCodes: contract.externalFactPolicy.reasonCodes,
                researchProhibited: contract.externalFactPolicy.researchProhibited,
                scopeClarificationRecommended: contract.externalFactPolicy.scopeClarificationRecommended,
              }
            : null,
          intentContract: contract.intentContract,
        },
      },
    },
  };
}

function assertIncludes(actual, expected, label) {
  for (const item of expected || []) {
    assert(actual.includes(item), `${label} must include ${item}; got ${JSON.stringify(actual)}`);
  }
}

for (const scenario of fixture.scenarios) {
  assert(scenario.id && Array.isArray(scenario.turns) && scenario.turns.length > 0);
  const messages = [];
  let firstContract = null;
  let previousContract = null;

  for (const turn of scenario.turns) {
    const files = Array.isArray(turn.files) ? turn.files : [];
    const contract = buildTaskContract({ text: turn.user, files, messages });
    const policy = buildTurnPolicy({ text: turn.user, taskContract: contract });
    const readiness = planCapabilityReadiness({
      text: turn.user,
      files,
      intentContract: contract.intentContract,
      turnPolicy: policy,
    });
    const expected = turn.expect || {};
    const label = `${scenario.id}: ${turn.user}`;

    for (const key of ["active", "taskType"]) {
      if (key in expected) assert.equal(contract[key], expected[key], `${label} ${key}`);
    }
    if ("relation" in expected) assert.equal(contract.intentContract?.relation, expected.relation, `${label} relation`);
    if ("revision" in expected) assert.equal(contract.intentContract?.revision, expected.revision, `${label} revision`);
    if ("rigor" in expected) assert.equal(policy.rigor, expected.rigor, `${label} rigor`);
    if ("externalEvidenceRequired" in expected) {
      assert.equal(contract.externalFactPolicy?.required, expected.externalEvidenceRequired, `${label} external evidence`);
    }
    if ("sourceLinksRequired" in expected) {
      assert.equal(contract.externalFactPolicy?.requiresSourceLinks, expected.sourceLinksRequired, `${label} source links`);
    }
    if ("researchProhibited" in expected) {
      assert.equal(contract.externalFactPolicy?.researchProhibited, expected.researchProhibited, `${label} research constraint`);
    }
    if ("scopeClarificationRecommended" in expected) {
      assert.equal(
        contract.externalFactPolicy?.scopeClarificationRecommended,
        expected.scopeClarificationRecommended,
        `${label} scope clarification`,
      );
    }
    if (expected.reusePreviousContract) {
      assert.equal(contract.intentContract?.contractId, previousContract?.contractId, `${label} contract identity`);
    }
    if ("objectiveEqualsFirst" in expected) {
      assert.equal(
        contract.intentContract?.objective === firstContract?.objective,
        expected.objectiveEqualsFirst,
        `${label} objective continuity`,
      );
    }
    if (expected.constraintIncludes) {
      assert(
        contract.intentContract?.constraints?.some((item) => item.includes(expected.constraintIncludes)),
        `${label} must preserve negative constraint`,
      );
    }

    assertIncludes(contract.verificationStrategy || [], expected.verificationIncludes, `${label} verification`);
    assertIncludes(readiness.requiredPackIds, expected.requiredPackIncludes, `${label} required packs`);
    assertIncludes(readiness.enhancementPackIds, expected.enhancementPackIncludes, `${label} enhancement packs`);
    assertIncludes(readiness.recommendedSkillIds, expected.skillIncludes, `${label} skills`);
    if (Array.isArray(expected.skillExact)) {
      assert.deepEqual(readiness.recommendedSkillIds, expected.skillExact, `${label} exact skills`);
    }

    firstContract ||= contract.intentContract;
    previousContract = contract.intentContract;
    messages.push({ role: "user", content: turn.user });
    messages.push(archivedAssistant(contract, turn.user));
  }
}

console.log(`platform-intent-eval: ok (${fixture.scenarios.length} scenarios)`);
