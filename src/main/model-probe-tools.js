"use strict";

/**
 * Tool fixtures the compatibility probe sends: a minimal probe tool, and decoys
 * shaped like Lily's real toolset (long names, nested object parameters) so a
 * gateway that passes a toy tool but chokes on real ones is caught here, not
 * on the user's first turn. Extracted from model-compatibility-probe.js to keep
 * that module inside its line ratchet.
 */
const AGENT_SHAPE_DECOY_TOOLS = Object.freeze([
  {
    type: "function",
    function: {
      // 44 chars — covers Lily's longest real tool name with headroom
      name: "lily_probe_agent_tool_shape_name_len_check_a",
      description: "Probe decoy mirroring Lily's longest real tool names.",
      parameters: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lily_probe_nested_params",
      description: "Probe decoy mirroring Lily tools with nested object parameters.",
      parameters: {
        type: "object",
        properties: {
          range: {
            type: "object",
            properties: {
              start: { type: "integer" },
              end: { type: "integer" },
            },
            required: ["start"],
          },
        },
        required: ["range"],
        additionalProperties: false,
      },
    },
  },
]);

function toolProbeFields(extraTools = [], toolChoice = null) {
  return {
    tools: [{
      type: "function",
      function: {
        name: "lily_probe_tool",
        description: "Return a probe result.",
        parameters: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
          },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    }, ...extraTools],
    tool_choice: toolChoice || {
      type: "function",
      function: { name: "lily_probe_tool" },
    },
  };
}

// The server's own word for "I ran out of room": finish_reason "length" with
// nothing produced. A reasoning model spends its budget on thinking first, and
// how much it needs varies by model AND by prompt — deepseek-v4 used ~50 tokens,
// a large official reasoning model can use thousands. So the budget is not
// guessed from the model name: it is raised only when the server says it was
// exhausted, along this ladder, and the working value is reused downstream.
// One step only: 4096 covers a simple prompt's reasoning on every model seen so
// far, and a probe must not burn 16k thinking tokens against a 10 s timeout.
const OUTPUT_BUDGET_LADDER = Object.freeze([512, 4096]);
function budgetExhausted(shape) {
  return Boolean(shape && !shape.hasContent && !shape.hasToolCalls && shape.finishReason === "length");
}
/** Re-send with a larger budget while the server reports exhaustion. Returns the
 *  last result plus the budget that produced it. */
async function withBudgetLadder(send, first) {
  let result = first, maxTokens = OUTPUT_BUDGET_LADDER[0];
  for (const next of OUTPUT_BUDGET_LADDER.slice(1)) {
    if (!(result.ok && budgetExhausted(result.shape))) break;
    const retry = await send(next);
    if (!retry.ok) break; // a rejection at the larger size keeps the smaller, valid answer
    result = retry; maxTokens = next;
  }
  return { result, maxTokens };
}

module.exports = { AGENT_SHAPE_DECOY_TOOLS, toolProbeFields, OUTPUT_BUDGET_LADDER, budgetExhausted, withBudgetLadder };
