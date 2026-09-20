"use strict";

function captureParentClosureSource(state, payload = {}) {
  return {
    taskContract: state.taskContract || state.pendingTaskContract || null,
    taskCore: state.taskCore || null,
    objective: require("./turn-user-context").effectiveUserRequest(state, state.enginePayload?.rawText || state.currentPayload?.rawText || "").trim(),
    files: require("./turn-user-context").effectiveInputFiles(state),
    payload,
    workState: require("./turn-work-state").summarizeWorkState(state),
    state: {
      turnId: state.turnId,
      enginePayload: { rawText: require("./turn-user-context").effectiveUserRequest(state) },
      tools: new Map([...((state.tools && state.tools.entries?.()) || [])].map(([id, tool]) => [id, {
        id: tool?.id || id,
        name: tool?.name || "",
        status: tool?.status || "running",
        input: tool?.input && typeof tool.input === "object" ? { ...tool.input } : {},
      }])),
      pendingPermissions: new Map(state.pendingPermissions || []),
      pendingQuestions: new Map(state.pendingQuestions || []),
      pendingHooks: new Map(state.pendingHooks || []),
      currentPayload: { parentClosureRecovery: Boolean(state.currentPayload?.parentClosureRecovery) },
    },
  };
}

module.exports = {
  captureParentClosureSource,
};
