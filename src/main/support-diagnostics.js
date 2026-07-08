"use strict";

const fs = require("node:fs");
const os = require("node:os");
const { appVersion } = require("./config");

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return value
      .replace(/\b(sk-[A-Za-z0-9._-]{6,})\b/g, "[redacted-key]")
      .replace(/\b(lilygw\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted-token]");
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/key|token|secret|authorization|signature/i.test(key)) {
      out[key] = raw ? "[redacted]" : raw;
    } else {
      out[key] = redact(raw);
    }
  }
  return out;
}

function check(status, id, label, detail = "", action = "") {
  return { id, status, label, detail, action };
}

function worstStatus(checks) {
  if (checks.some((item) => item.status === "error")) return "error";
  if (checks.some((item) => item.status === "warning")) return "warning";
  return "ok";
}

function activeModelCheck(models, connection) {
  const activePreset = (models.presets || []).find((preset) => preset.id === models.activePresetId) || null;
  if (!models.presets?.length) {
    return check(
      "error",
      "model.default",
      "Lily 默认模型",
      "没有可用的服务端模型配置。请刷新服务配置或检查网络。",
      "refresh_service_config",
    );
  }
  if (activePreset?.custom || models.apiGateway?.mode === "custom") {
    return check(
      "warning",
      "model.default",
      "Lily 默认模型",
      "当前正在使用自定义模型或自定义 API，可能覆盖 Lily 默认模型。",
      "restore_default_model",
    );
  }
  if (connection?.managed && !connection.ok) {
    return check(
      "warning",
      "model.default",
      "Lily 默认模型",
      "默认模型需要刷新服务配置后才能使用。",
      "refresh_service_config",
    );
  }
  return check("ok", "model.default", "Lily 默认模型", "当前使用 Lily 托管模型配置。");
}

function serviceConfigCheck({ remoteReady, refreshResult }) {
  if (refreshResult && refreshResult.ok === false) {
    return check(
      "warning",
      "service.config",
      "服务配置",
      `服务配置刷新失败：${refreshResult.error || "CONFIG_REFRESH_FAILED"}`,
      "refresh_service_config",
    );
  }
  if (!remoteReady) {
    return check("warning", "service.config", "服务配置", "没有可用的服务端模型配置缓存。", "refresh_service_config");
  }
  return check("ok", "service.config", "服务配置", "服务端配置可用。");
}

function engineCheck({ includeEngine }) {
  if (!includeEngine) return check("ok", "engine.available", "AI 引擎", "本次未检查引擎文件。");
  const cliPath = safeCall(() => require("./agent-command").resolveOpencodeCommand(), "");
  if (!cliPath) return check("error", "engine.available", "AI 引擎", "没有找到内置 AI 引擎。");
  if (!fs.existsSync(cliPath)) return check("error", "engine.available", "AI 引擎", `引擎文件不存在：${cliPath}`);
  return check("ok", "engine.available", "AI 引擎", "内置 AI 引擎存在。");
}

async function runSupportDiagnosticsPublic(options = {}) {
  const refreshService = options.refreshService !== false;
  let refreshResult = null;
  if (refreshService) {
    refreshResult = await Promise.resolve()
      .then(() => require("./ipc-utils").refreshRemoteConfigForSend({
        force: true,
        timeoutMs: Number(options.timeoutMs || 45_000),
        repairManagedService: true,
        refreshLicense: false,
        reason: "support_diagnostics",
      }))
      .catch((err) => ({ ok: false, error: err?.message || String(err) }));
  }

  const modelPresets = require("./model-presets");
  const remoteConfig = require("./remote-config");
  const models = modelPresets.listPresetsPublic();
  const connection = modelPresets.getActiveModelConnectionStatus(
    safeCall(() => require("./spawn-env").resolveLilyEnv(), null),
  );
  const remoteReady = remoteConfig.hasRemoteModelCatalogSync();
  const license = safeCall(() => require("./license-manager").getLicenseStatus(), null);
  const policy = safeCall(() => require("./service-client").getClientPolicy(), {});
  const watchdog = safeCall(() => require("./app-watchdog").getLastWatchdogSnapshot?.(), null);

  const checks = [
    activeModelCheck(models, connection),
    serviceConfigCheck({ remoteReady, refreshResult }),
    engineCheck({ includeEngine: options.includeEngine !== false }),
  ];
  if (license) {
    checks.push(check(
      license.valid || license.activated ? "ok" : "warning",
      "license.status",
      "授权状态",
      license.valid || license.activated ? "授权信息可用。" : `授权未就绪：${license.error || "INACTIVE"}`,
      license.valid || license.activated ? "" : "activate_license",
    ));
  }

  const status = worstStatus(checks);
  const recommendedActions = [];
  if (checks.some((item) => item.action === "restore_default_model")) {
    recommendedActions.push({ id: "restore_default_model", label: "恢复 Lily 默认模型" });
  }
  if (checks.some((item) => item.action === "refresh_service_config")) {
    recommendedActions.push({ id: "refresh_service_config", label: "刷新服务配置" });
  }

  return redact({
    ok: true,
    generatedAt: new Date().toISOString(),
    summary: {
      status,
      title: status === "ok" ? "未发现明显异常" : "发现可修复问题",
      issueCount: checks.filter((item) => item.status !== "ok").length,
    },
    checks,
    recommendedActions,
    context: {
      appVersion: appVersion(),
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      policyRegion: policy?.region || "",
      model: {
        activePresetId: models.activePresetId || "",
        managedByService: Boolean(models.managedByService),
        activeIsCustom: Boolean((models.presets || []).find((preset) => preset.id === models.activePresetId)?.custom),
        apiGatewayMode: models.apiGateway?.mode || "",
        presetCount: (models.presets || []).length,
      },
      service: {
        remoteReady,
        refreshOk: refreshResult ? Boolean(refreshResult.ok) : null,
        refreshError: refreshResult?.ok === false ? String(refreshResult.error || "") : "",
      },
      license: license ? {
        activated: Boolean(license.activated),
        valid: Boolean(license.valid),
        error: license.error || "",
        plan: license.plan || "",
      } : null,
      watchdog,
    },
  });
}

async function submitDiagnosticsFeedbackPublic(input = {}) {
  const diagnostic = redact(input.diagnostic || await runSupportDiagnosticsPublic({ refreshService: false }));
  const firstIssue = (diagnostic.checks || []).find((item) => item.status !== "ok");
  const eventSubtype = firstIssue ? `${firstIssue.id.replace(/[^a-z0-9]+/gi, "_")}_${firstIssue.status}` : "all_ok";
  const result = await require("./service-client").reportRuntimeDiagnostic({
    eventType: "support",
    eventSubtype,
    normalizedKind: "support_diagnostics",
    severity: diagnostic.summary?.status === "error" ? "error" : diagnostic.summary?.status === "warning" ? "warning" : "info",
    summary: String(input.message || diagnostic.summary?.title || "Support diagnostics").slice(0, 1000),
    trace: {
      schemaVersion: 1,
      message: String(input.message || "").slice(0, 1000),
      summary: diagnostic.summary || {},
      checks: diagnostic.checks || [],
      recommendedActions: diagnostic.recommendedActions || [],
      context: diagnostic.context || {},
    },
  });
  if (!result.ok) {
    return { ok: false, error: result.error || "DIAGNOSTIC_UPLOAD_FAILED", detail: result.detail || null };
  }
  return { ok: true, id: result.json?.id || null };
}

module.exports = {
  runSupportDiagnosticsPublic,
  submitDiagnosticsFeedbackPublic,
  redact,
};
