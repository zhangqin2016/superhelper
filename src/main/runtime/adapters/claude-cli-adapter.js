"use strict";

const { normalizeClaudeEvent } = require("../../claude-event-normalizer");
const {
  runtimeEventFromAction,
  isWarningAction,
} = require("../runtime-events");
const { backgroundActivityFromEvent } = require("../runtime-activity");

class ClaudeCliAdapter {
  constructor() {
    this.name = "claude-cli";
  }

  normalizeEvent(ev) {
    const actions = normalizeClaudeEvent(ev);
    const runtimeEvents = actions
      .map((action) => runtimeEventFromAction(action))
      .filter(Boolean);
    const warnings = actions.filter(isWarningAction);
    const backgroundActivity = backgroundActivityFromEvent(ev);
    return {
      adapter: this.name,
      rawType: ev?.type || "",
      rawSubtype: ev?.subtype || "",
      actions,
      runtimeEvents,
      warnings,
      backgroundActivity,
    };
  }
}

module.exports = {
  ClaudeCliAdapter,
};
