"use strict";

function captureParentClosureSource(state, payload = {}) {
  // A recovery turn's own text may be the platform's correction; its objective
  // is the request it inherited (turn-recovery-context).
  const request = state.recoveryObjective || state.enginePayload?.rawText || state.currentPayload?.rawText || "";
  return {
    taskContract: state.taskContract || state.pendingTaskContract || null,
    taskCore: state.taskCore || null,
    objective: require("./turn-user-context").effectiveUserRequest(state, request).trim(),
    files: require("./turn-user-context").effectiveInputFiles(state),
    payload,
    workState: require("./turn-work-state").summarizeWorkState(state),
    state: {
      turnId: state.turnId,
      enginePayload: { rawText: require("./turn-user-context").effectiveUserRequest(state, state.recoveryObjective || undefined) },
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
