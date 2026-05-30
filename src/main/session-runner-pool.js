"use strict";

const { AgentSession } = require("./agent-session");
const { resolveAgentCommand } = require("./agent-command");
const { getActivePermissionMode } = require("./permission-settings");

class SessionRunnerPool {
  constructor() {
    /** @type {Map<string, AgentSession>} */
    this._sessions = new Map();
  }

  has(sessionId) {
    return this._sessions.has(sessionId);
  }

  getSessionIds() {
    return [...this._sessions.keys()];
  }

  /**
   * @param {string} sessionId
   * @param {string} cwd
   * @param {{ stagingDir?: string, disallowedTools?: string[], resumeSessionId?: string | null, configDir?: string }} [extra]
   */
  ensure(sessionId, cwd, extra = {}) {
    const agentCommand = resolveAgentCommand();
    if (!agentCommand) {
      throw new Error("AGENT_NOT_READY");
    }

    let runner = this._sessions.get(sessionId);
    if (!runner) {
      runner = new AgentSession(sessionId);
      this._sessions.set(sessionId, runner);
    }

    runner.ensureProcess(cwd, {
      agentCommand,
      permissionMode: getActivePermissionMode(),
      disallowedTools: extra.disallowedTools || [],
      stagingDir: extra.stagingDir,
      resumeSessionId: extra.resumeSessionId || null,
      configDir: extra.configDir,
    });

    return runner;
  }

  get(sessionId) {
    return this._sessions.get(sessionId) || null;
  }

  sendMessage(sessionId, text) {
    const runner = this._sessions.get(sessionId);
    if (!runner) throw new Error("NO_RUNNER");
    return runner.sendUserMessage(text);
  }

  interrupt(sessionId) {
    this._sessions.get(sessionId)?.interrupt();
  }

  terminateSession(sessionId) {
    const runner = this._sessions.get(sessionId);
    if (!runner) return;
    runner.terminate();
    this._sessions.delete(sessionId);
  }

  terminateAll() {
    for (const sessionId of [...this._sessions.keys()]) {
      this.terminateSession(sessionId);
    }
  }
}

module.exports = { SessionRunnerPool };
