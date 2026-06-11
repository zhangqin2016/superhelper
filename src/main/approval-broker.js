"use strict";

const {
  needsUserApproval,
  buildControlResponse,
  buildRememberAllowPermissions,
  withPersistentDestination,
  buildControlCancelRequest,
  buildHookContinueResponse,
  buildHookPreToolUseResponse,
  buildHookStopResponse,
} = require("./control-protocol");
const { resolvePlanPreview, PLAN_PREVIEW_MAX } = require("./plan-preview");

/**
 * Owns the user-blocking control surface of a session: pending permission
 * requests (canUseTool), AskUserQuestion prompts, and hook decisions —
 * including their UI timeouts and the control-protocol responses.
 *
 * Everything side-effectful is injected: writing control lines, ingesting
 * runtime events, emitting notices, and the turn bookkeeping hooks.
 */
class ApprovalBroker {
  /**
   * @param {object} deps
   * @param {(payload: object) => unknown} deps.writeControl
   * @param {(drafts: object[]) => void} deps.ingest
   * @param {(notice: object) => void} deps.emitNotice
   * @param {() => void} deps.onBlockingRequest marks tool use + clears idle quiesce
   * @param {() => void} deps.onActivity stream activity (re-arms watchdogs)
   * @param {() => void} deps.pollGate re-checks the deferred-result gate
   * @param {() => string} deps.permissionMode
   * @param {() => number} deps.timeoutMs read at use time
   * @param {(input: object) => unknown[]} deps.normalizeQuestions injected by
   *   the session host — only the host may touch runtime/adapters (boundary
   *   ratchet).
   */
  constructor({ writeControl, ingest, emitNotice, onBlockingRequest, onActivity, pollGate, permissionMode, timeoutMs, normalizeQuestions }) {
    this._normalizeQuestions = normalizeQuestions;
    this._writeControl = writeControl;
    this._ingest = ingest;
    this._emitNotice = emitNotice;
    this._onBlockingRequest = onBlockingRequest;
    this._onActivity = onActivity;
    this._pollGate = pollGate;
    this._permissionMode = permissionMode;
    this._timeoutMs = timeoutMs;
    /** @type {Map<string, { toolName: string, input: Record<string, unknown>, suggestions?: unknown[] }>} */
    this._pendingPermissions = new Map();
    /** @type {Map<string, { hookName: string, toolName: string, requestId: string }>} */
    this._pendingHooks = new Map();
  }

  permissionCount() {
    return this._pendingPermissions.size;
  }

  hookCount() {
    return this._pendingHooks.size;
  }

  permissionIds() {
    return [...this._pendingPermissions.keys()];
  }

  hookIds() {
    return [...this._pendingHooks.keys()];
  }

  clearPermissions(notifyCancel = false) {
    if (this._pendingPermissions.size === 0) return;
    const ids = [...this._pendingPermissions.keys()];
    this._pendingPermissions.clear();
    if (notifyCancel) {
      for (const requestId of ids) {
        this._ingest([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
      }
    }
  }

  clearHooks(notifyCancel = false) {
    if (this._pendingHooks.size === 0) return;
    const ids = [...this._pendingHooks.keys()];
    this._pendingHooks.clear();
    if (notifyCancel) {
      for (const requestId of ids) {
        this._ingest([{ type: "hook.resolved", payload: { requestId, cancelled: true } }]);
      }
    }
  }

  denyAllPermissions(message) {
    for (const [requestId] of this._pendingPermissions) {
      this._writeControl(buildControlResponse(requestId, { behavior: "deny", message }));
      this._writeControl(buildControlCancelRequest(requestId));
      this._ingest([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
    }
    this._pendingPermissions.clear();
  }

  respondPermission(requestId, decision) {
    const pending = this._pendingPermissions.get(requestId);
    if (!pending) return false;

    this._pendingPermissions.delete(requestId);
    if (decision.allow) {
      /** @type {{ behavior: "allow", updatedInput: Record<string, unknown>, updatedPermissions?: unknown[] }} */
      const allowDecision = {
        behavior: "allow",
        updatedInput: pending.input,
      };
      if (decision.remember && pending.toolName) {
        allowDecision.updatedPermissions =
          Array.isArray(pending.suggestions) && pending.suggestions.length
            ? withPersistentDestination(pending.suggestions)
            : buildRememberAllowPermissions(pending.toolName);
      }
      this._writeControl(buildControlResponse(requestId, allowDecision));
    } else {
      this._emitNotice({
        code: "permissionUserDenied",
        level: "warning",
        panel: true,
        replace: true,
        done: true,
        toolName: pending.toolName,
      });
      this._writeControl(
        buildControlResponse(requestId, {
          behavior: "deny",
          message: decision.message || "User denied this action",
        }),
      );
      this._writeControl(buildControlCancelRequest(requestId));
    }
    this._ingest([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
    this._onActivity();
    this._pollGate();
    return true;
  }

  respondUserQuestion(requestId, payload = {}) {
    const pending = this._pendingPermissions.get(requestId);
    if (!pending || pending.toolName !== "AskUserQuestion") return false;

    const questions = this._normalizeQuestions(pending.input || {});
    const answers =
      payload.answers && typeof payload.answers === "object" ? payload.answers : {};
    const response = typeof payload.response === "string" ? payload.response.trim() : "";

    this._pendingPermissions.delete(requestId);
    this._writeControl(
      buildControlResponse(requestId, {
        behavior: "allow",
        updatedInput: {
          questions,
          answers,
          ...(response ? { response } : {}),
        },
      }),
    );
    this._ingest([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
    this._onActivity();
    this._pollGate();
    return true;
  }

  /** CLI-side cancel (control_cancel): drop silently, no response/event. */
  dropPermission(requestId) {
    return this._pendingPermissions.delete(requestId);
  }

  cancelPermission(requestId) {
    if (!this._pendingPermissions.has(requestId)) return false;
    this._pendingPermissions.delete(requestId);
    this._writeControl(buildControlCancelRequest(requestId));
    this._ingest([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
    this._pollGate();
    return true;
  }

  allowToolUse(requestId, input) {
    this._writeControl(
      buildControlResponse(requestId, {
        behavior: "allow",
        updatedInput: input || {},
      }),
    );
    this._onActivity();
  }

  handleCanUseTool(canUse, log) {
    const { requestId, toolName, input, title, description, decisionReason, suggestions } = canUse;
    const permissionMode = this._permissionMode();

    if (toolName === "AskUserQuestion") {
      this.handleAskUserQuestion(canUse);
      return;
    }

    log?.info("permission-check tool=%s mode=%s needsApproval=%s",
      toolName, permissionMode, needsUserApproval(toolName, permissionMode));

    if (!needsUserApproval(toolName, permissionMode)) {
      this.allowToolUse(requestId, input);
      return;
    }

    if (permissionMode === "dontAsk") {
      this._emitNotice({
        code: "permissionAutoDenied",
        level: "warning",
        panel: true,
        replace: true,
        done: true,
        toolName,
      });
      this._writeControl(
        buildControlResponse(requestId, {
          behavior: "deny",
          message: "Skipped because confirmations are turned off",
        }),
      );
      this._onActivity();
      return;
    }

    this._pendingPermissions.set(requestId, { toolName, input, suggestions });
    this._onBlockingRequest();
    const planPreview = resolvePlanPreview(input, description);
    this._ingest([{
      type: "permission.requested",
      payload: {
        requestId,
        toolName,
        input,
        title,
        description,
        decisionReason,
        suggestions,
        planPreview,
        planPreviewTruncated: planPreview.length >= PLAN_PREVIEW_MAX,
      },
    }]);

    setTimeout(() => {
      if (!this._pendingPermissions.has(requestId)) return;
      this._emitNotice({
        code: "permissionTimeout",
        level: "warning",
        panel: true,
        toast: true,
        done: true,
        requestId,
        toolName,
      });
      this.respondPermission(requestId, {
        allow: false,
        message: "Permission request timed out",
      });
    }, this._timeoutMs());
  }

  handleAskUserQuestion(canUse) {
    const { requestId, input } = canUse;
    const questions = this._normalizeQuestions(input || {});
    this._pendingPermissions.set(requestId, {
      toolName: "AskUserQuestion",
      input: { ...input, questions },
    });
    this._onBlockingRequest();
    this._ingest([{
      type: "user_question.requested",
      payload: {
        requestId,
        input,
        questions,
      },
    }]);
  }

  handleHookPreToolUse(action) {
    const { requestId, toolName, permissionDecision, decisionReason, notice } = action;

    if (permissionDecision !== "ask") {
      const detail = toolName ? `${toolName}` : "";
      this._emitNotice({ ...notice, detail: detail || notice.detail, done: true });
      this._writeControl(buildHookContinueResponse(requestId));
      return;
    }

    this._pendingHooks.set(requestId, {
      hookName: action.hookName || "PreToolUse",
      toolName: toolName || "unknown",
      requestId,
    });
    this._onBlockingRequest();

    this._emitNotice({
      ...notice,
      detail: toolName
        ? `${toolName}${decisionReason ? ` — ${decisionReason}` : ""}`
        : notice.detail,
    });

    setTimeout(() => {
      if (!this._pendingHooks.has(requestId)) return;
      this._emitNotice({
        code: "hookTimeout",
        level: "warning",
        panel: true,
        toast: true,
        done: true,
        requestId,
        detail: `${toolName}: Hook decision timed out, denied`,
      });
      this.respondHook(requestId, { allow: false });
    }, this._timeoutMs());
  }

  handleHookStop(action) {
    const { requestId, hookName, notice } = action;

    this._pendingHooks.set(requestId, {
      hookName: hookName || "Stop",
      requestId,
      toolName: "",
    });
    this._onBlockingRequest();

    this._emitNotice(notice);

    setTimeout(() => {
      if (!this._pendingHooks.has(requestId)) return;
      this.respondHook(requestId, { allow: true });
    }, this._timeoutMs());
  }

  handleHookInfoOnly(action) {
    this._emitNotice(action.notice);
    this._writeControl(buildHookContinueResponse(action.requestId));
  }

  respondHook(requestId, decision) {
    const pending = this._pendingHooks.get(requestId);
    if (!pending) return false;

    this._pendingHooks.delete(requestId);

    if (pending.hookName === "PreToolUse") {
      this._writeControl(
        buildHookPreToolUseResponse(requestId, {
          allow: Boolean(decision.allow),
          updatedInput: decision.updatedInput || undefined,
        }),
      );
    } else if (pending.hookName === "Stop" || pending.hookName === "SubagentStop") {
      this._writeControl(
        buildHookStopResponse(requestId, {
          allow: Boolean(decision.allow),
          reason: decision.reason,
        }),
      );
    } else {
      this._writeControl(buildHookContinueResponse(requestId));
    }

    this._ingest([{ type: "hook.resolved", payload: { requestId, hookName: pending.hookName } }]);
    this._onActivity();
    this._pollGate();
    return true;
  }
}

module.exports = { ApprovalBroker };
