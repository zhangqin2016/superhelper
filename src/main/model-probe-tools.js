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

module.exports = { AGENT_SHAPE_DECOY_TOOLS, toolProbeFields };
