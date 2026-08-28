"use strict";

const catalog = require("./model-selection-catalog");
const { estimateTokensForText } = require("./context-budget-manager");

function resolveModelForTurn({ selection, text, files } = {}) {
  return catalog.resolveTurnModel({ selection, text, files });
}

function resolveTurnModel(opts, text, files, context = {}) {
  let receipt = null;
  if (opts?.sourceTurnId && context.sessionId) {
    try {
      const source = context.manager?.getTurnInputByTurnId?.(context.sessionId, opts.sourceTurnId);
      if (source?.sessionId === context.sessionId) receipt = source.metadata?.modelRoute;
    } catch {
      return { ok: false, error: "MODEL_SNAPSHOT_UNAVAILABLE" };
    }
  }
  let retained = 0;
  try {
    const summary = require("./session-memory").readSessionSummary(context.sessionId) || {};
    retained = Math.max(0, Number(summary.retainedContextTokens ?? summary.lastEnginePromptTokens) || 0);
  } catch { /* a new/headless session has no retained history */ }
  const promptTokens = estimateTokensForText(text).tokens + 4096;
  const route = catalog.resolveTurnModel({
    selection: receipt?.selection || opts?.modelSelection || undefined,
    pinnedModelId: receipt?.selectionId || "", text, files, sessionId: context.sessionId,
    requirements: { tools: true, contextTokens: retained + promptTokens, allowContextMaintenance: true },
  });
  if (route.ok && receipt?.modelId && (receipt.modelId !== route.model?.modelID
    || (receipt.providerId && receipt.providerId !== route.model?.providerID && !catalog.matchesLegacyModelReceipt?.(receipt, route.model)))) {
    return { ok: false, error: "MODEL_SNAPSHOT_UNAVAILABLE" };
  }
  return route;
}

function modelRouteFailure(route) {
  const details = {
    INVALID_MODEL_SELECTION: "所选模型当前不可用，请在输入框旁重新选择模型。",
    NO_ELIGIBLE_MODEL: "自动候选中没有可用模型，请重新勾选或恢复推荐。",
    MODEL_SELECTION_READ_FAILED: "模型选择设置读取失败，未更换模型，请重启后重试。",
    MODEL_SNAPSHOT_UNAVAILABLE: "无法读取原任务的模型记录，未更换模型，请稍后重试。",
    MODEL_CATALOG_STALE: "模型配置暂未续期成功，未更换模型，请稍后重试。",
  };
  return {
    ok: false,
    error: route?.error || "NO_MODEL_AVAILABLE",
    detail: details[route?.error] || "当前没有可用模型，请刷新模型目录后重试。",
  };
}

function runtimeModelPool(override) {
  return Array.isArray(override) ? override : catalog.listRuntimeModelIds();
}

function refreshModelExecution(execution) {
  const model = execution.model;
  const route = catalog.resolveTurnModel({ selection: { mode: "manual", manualModelId: model.id }, pinnedModelId: model.id });
  if (!route.ok || !route.execution || route.model.modelID !== model.modelID || route.model.providerID !== model.providerID) {
    throw new Error("MODEL_SNAPSHOT_UNAVAILABLE");
  }
  return route.execution;
}

function allowImageFileParts(route) {
  if (route?.model) return Boolean(route.model.capabilities?.vision);
  try {
    return Boolean(require("./model-presets").activePresetSupportsVision?.());
  } catch {
    return false;
  }
}

function routeTrace(route) {
  return {
    identityVersion: 2,
    mode: route?.mode || "auto",
    reason: route?.reason || "legacy_active_model",
    modelId: route?.model?.modelID || "",
    providerId: route?.model?.providerID || "",
    selectionId: route?.model?.id || "",
    selection: route?.selection || null,
    label: route?.model?.label || "",
  };
}

function routeMetadata(route) {
  return route?.model ? { modelRoute: routeTrace(route) } : {};
}

module.exports = { resolveModelForTurn, resolveTurnModel, modelRouteFailure, runtimeModelPool, refreshModelExecution, allowImageFileParts, routeTrace, routeMetadata };
