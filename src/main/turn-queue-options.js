"use strict";

const { documentDeliveryDispatchOptions } = require("./document-delivery-turn");
const { scheduledTaskTurnOptions } = require("./scheduled-task-turn-options");
const { normalizeRequiredTools } = require("./required-tool-completion");

function queueDispatchOptions(opts = {}) {
  const localAssistant = opts.localAssistant && typeof opts.localAssistant === "object" ? opts.localAssistant : null;
  const queueOrigin = opts.queueOrigin || (opts.scheduledTaskId ? "scheduled_task" : localAssistant ? "local_assistant" : "user");
  const options = {
    engineText: typeof opts.engineText === "string" ? opts.engineText : null,
    recordUser: opts.recordUser !== false,
    recovery: opts.recovery && typeof opts.recovery === "object" ? opts.recovery : null,
    localAssistant,
    reloadSkillsBeforeStart: Boolean(opts.reloadSkillsBeforeStart),
    spawnEngine: opts.spawnEngine,
    skipPreflight: Boolean(opts.skipPreflight),
    skipVision: Boolean(opts.skipVision),
    skipDocument: Boolean(opts.skipDocument),
    ...scheduledTaskTurnOptions(opts),
    queueOrigin,
    queueVisibility: opts.queueVisibility === "background" ? "background" : "composer",
    ...documentDeliveryDispatchOptions(opts),
    externalCommand: opts.externalCommand && typeof opts.externalCommand === "object" ? opts.externalCommand : null,
    requiredSuccessfulTools: normalizeRequiredTools(opts.requiredSuccessfulTools),
    turnId: typeof opts.turnId === "string" ? opts.turnId : null,
    durableQueueKey: typeof opts.durableQueueKey === "string" ? opts.durableQueueKey : null,
    modelSelection: opts.modelSelection && typeof opts.modelSelection === "object" ? opts.modelSelection : null,
  };
  if (Object.hasOwn(opts, "sourceTurnId")) options.sourceTurnId = opts.sourceTurnId;
  if (opts.sourceTaskCore && typeof opts.sourceTaskCore === "object") options.sourceTaskCore = opts.sourceTaskCore;
  return options;
}

module.exports = { queueDispatchOptions };
