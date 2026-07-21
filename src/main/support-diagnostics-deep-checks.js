"use strict";

/**
 * Deep diagnostics checks — the second layer behind support-diagnostics.js.
 *
 * The shallow layer (1-token ping, file-exists checks) reports "all green" in
 * exactly the situations customers hit most: the gateway accepts a bare ping
 * but rejects the real tool-shaped request, the engine binary exists but
 * crashes on launch, the session store is corrupted, or a zombie/duplicate
 * install is holding the ports. These checks reproduce the REAL code paths
 * (same probe the model-settings repair uses, a real engine spawn, a real
 * SQLite open, a real process scan) so "diagnostics normal but nothing works"
 * stops happening.
 *
 * Every check is fail-open: when a probe cannot run (missing capability,
 * enumeration failure), it reports ok-with-note instead of guessing. Only
 * positive evidence produces warning/error.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function check(status, id, label, detail = "", action = "") {
  return { id, status, label, detail, action };
}

const MODEL_DEFECT_DETAILS = Object.freeze({
  MODEL_TOOL_CALLS_UNAVAILABLE:
    "模型服务不接受工具调用请求：简单 ping 能通，但真实对话（带工具的请求）会全部失败。请更换模型或恢复 Lily 默认模型。",
  MODEL_STREAMING_NO_CONTENT:
    "模型流式响应不返回正文：简单 ping 能通，但真实对话收不到内容。请更换模型或恢复 Lily 默认模型。",
  MODEL_REASONING_ONLY:
    "模型只返回推理过程、不返回正文内容：真实对话会表现为空回复。请更换模型或恢复 Lily 默认模型。",
  MODEL_NO_CONTENT:
    "模型响应没有任何正文内容：真实对话会表现为空回复。请更换模型或恢复 Lily 默认模型。",
});

/**
 * Reuse the settings-repair probe (decoy tools shaped like Lily's real
 * toolset) against the CURRENTLY EFFECTIVE route. A bare ping passing means
 * nothing when the gateway 400s the moment real tool definitions appear.
 */
async function modelAgentConformanceCheck(options = {}) {
  const id = "model.agent_conformance";
  const label = "对话请求一致性";
  try {
    const resolveLilyEnv = options.resolveLilyEnv || (() => require("./spawn-env").resolveLilyEnv());
    const resolveModelConfig =
      options.resolveModelConfig ||
      ((env) => require("./runtime/opencode-model-config").resolveOpencodeModelConfig(env));
    const probe = options.probeFn || require("./model-compatibility-probe").probeCustomModelProfile;

    const lilyEnv = resolveLilyEnv() || {};
    const resolved = resolveModelConfig(lilyEnv);
    if (!resolved?.ok) {
      return check("ok", id, label, "跳过：当前模型配置不可用，详见模型连通性检查。");
    }

    const prev = process.env.LILY_ENABLE_CAPABILITY_GRADING;
    process.env.LILY_ENABLE_CAPABILITY_GRADING = "0"; // diagnostics only need conformance, not grading passes
    let result;
    try {
      result = await probe({
        protocol: resolved.protocol || "openai",
        baseUrl: resolved.baseUrl,
        apiKey: lilyEnv.LILY_OPENCODE_API_KEY || lilyEnv.LILY_API_KEY || "",
        model: resolved.model?.modelID || "",
        systemPromptProbeText: "",
        timeoutMs: Number(options.conformanceTimeoutMs || 15_000),
      });
    } finally {
      if (prev === undefined) delete process.env.LILY_ENABLE_CAPABILITY_GRADING;
      else process.env.LILY_ENABLE_CAPABILITY_GRADING = prev;
    }

    if (result?.diagnostics?.skipped === "non-openai-protocol") {
      return check("ok", id, label, "当前协议自带工具语义，无需一致性探测。");
    }
    if (!result?.ok) {
      const code = String(result?.error || "");
      // Only the four confirmed model-defect codes convict the model. Probe
      // transport failures (MODEL_PROBE_TIMEOUT, HTTP_5xx, fetch errors) are
      // already covered by model.connectivity — don't double-report.
      if (MODEL_DEFECT_DETAILS[code]) {
        return check("error", id, label, MODEL_DEFECT_DETAILS[code], "restore_default_model");
      }
      return check("warning", id, label, `一致性探测未完成：${code || "UNKNOWN"}。可能是网络波动，详见模型连通性检查。`);
    }
    if (result.profile?.toolShapeCompat) {
      return check("ok", id, label, "模型可用（网关要求工具形状兼容模式，运行时已自动启用）。");
    }
    return check("ok", id, label, "模型能正确处理真实对话请求（含工具调用与流式输出）。");
  } catch (err) {
    return check("ok", id, label, `一致性探测跳过：${err?.message || err}`);
  }
}

function defaultSpawnProbe(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };
    let child;
    try {
      child = spawn(file, args, { stdio: "ignore", windowsHide: true });
    } catch (err) {
      finish({ error: err });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({ timedOut: true });
    }, Math.max(1000, timeoutMs));
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ error: err });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish({ code });
    });
  });
}

/** File-exists is not enough — a binary that crashes on launch passes the shallow check. */
async function engineBootCheck(options = {}) {
  const id = "engine.boot";
  const label = "引擎启动";
  try {
    const cliPath = options.enginePath ?? safeCall(() => require("./agent-command").resolveOpencodeCommand(), "");
    if (!cliPath || !fs.existsSync(cliPath)) {
      return check("ok", id, label, "跳过：引擎文件缺失，详见 AI 引擎检查。");
    }
    const spawnProbe = options.spawnFn || defaultSpawnProbe;
    const outcome = await spawnProbe(cliPath, ["--version"], Number(options.engineBootTimeoutMs || 10_000));
    if (outcome?.timedOut) {
      return check("error", id, label, `引擎启动无响应（${options.engineBootTimeoutMs || 10_000}ms 超时）。文件存在但无法运行，可能被安全软件拦截或二进制损坏。`);
    }
    if (outcome?.error) {
      return check("error", id, label, `引擎无法启动：${outcome.error.code || outcome.error.message || outcome.error}。文件存在但无法运行。`);
    }
    if (outcome?.code !== 0) {
      return check("error", id, label, `引擎启动后立即退出（退出码 ${outcome?.code}）。文件存在但无法正常运行。`);
    }
    return check("ok", id, label, "引擎可正常启动。");
  } catch (err) {
    return check("ok", id, label, `引擎启动探测跳过：${err?.message || err}`);
  }
}

function openSqliteReadOnly(dbPath) {
  // Deliberately NOT store/sqlite-db.js: that wrapper applies WAL pragmas,
  // which WRITES to the database. Diagnostics must be strictly read-only.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.prepare("SELECT 1").get();
  } finally {
    db.close();
  }
}

/** Corrupted session storage leaves the app "normal" until every send fails. */
function sessionStoreCheck(options = {}) {
  const id = "session.store";
  const label = "会话数据";
  try {
    const config = require("./config");
    const paths = options.paths || {
      "sessions.json": safeCall(() => config.sessionsConfigPath(), ""),
      "messages.db": safeCall(() => config.messageDbPath(), ""),
      "opencode.db": safeCall(() => config.opencodeDbPath(), ""),
    };
    const problems = [];
    let checkedAny = false;

    const sessionsPath = paths["sessions.json"];
    if (sessionsPath && fs.existsSync(sessionsPath)) {
      checkedAny = true;
      try {
        JSON.parse(fs.readFileSync(sessionsPath, "utf8") || "null");
      } catch {
        problems.push("sessions.json 已损坏（JSON 解析失败）");
      }
    }

    const sqliteAvailable = safeCall(() => Boolean(require("node:sqlite").DatabaseSync), false);
    for (const name of ["messages.db", "opencode.db"]) {
      const dbPath = paths[name];
      if (!dbPath || !fs.existsSync(dbPath)) continue;
      checkedAny = true;
      if (!sqliteAvailable) continue; // cannot verify on this Node — skip silently
      try {
        openSqliteReadOnly(dbPath);
      } catch (err) {
        problems.push(`${name} 无法打开（${err?.message || err}）`);
      }
    }

    if (problems.length) {
      return check(
        "error",
        id,
        label,
        `会话数据文件损坏：${problems.join("；")}。会话记录可能无法读写，建议备份后删除损坏文件让其重建。`,
      );
    }
    if (!checkedAny) {
      return check("ok", id, label, "尚无会话数据文件（新安装），无需检查。");
    }
    return check("ok", id, label, "会话数据文件完整可读。");
  } catch (err) {
    return check("ok", id, label, `会话数据检查跳过：${err?.message || err}`);
  }
}

const PRODUCT_NAME_PATTERNS = Object.freeze([
  /lily[ -]?workbench/i,
  /智能工作台/,
  /智能助手/,
  /ai[ -]?super[ -]?terminal/i,
]);

function defaultListProcesses(timeoutMs) {
  const isWin = process.platform === "win32";
  // Windows: tasklist gives ONLY the image name ("LilyWorkbench.exe") — no
  // path, no command line. That made every Electron helper process
  // indistinguishable from a rogue duplicate install (the --type= and
  // legitimate-path filters below could never match), so every HEALTHY
  // Windows machine reported "other install locations running". CIM
  // Win32_Process carries ExecutablePath + CommandLine, which is what the
  // filters need. If CIM is blocked (WDAC/Constrained Language), we get no
  // usable evidence → the check must SKIP, never fall back to tasklist's
  // guaranteed-false positives.
  const command = isWin ? "powershell" : "ps";
  const args = isWin
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress -Depth 2"]
    : ["-eo", "pid=,args="];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(null);
    }, Math.max(1000, timeoutMs));
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      if (isWin) {
        try {
          const parsed = JSON.parse(out);
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          finish(rows
            .filter((row) => row && Number.isFinite(Number(row.ProcessId)))
            .map((row) => ({
              pid: Number(row.ProcessId),
              command: String(row.CommandLine || row.ExecutablePath || ""),
            }))
            .filter((entry) => entry.command));
        } catch {
          finish(null);
        }
        return;
      }
      const entries = [];
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m) entries.push({ pid: Number(m[1]), command: m[2] });
      }
      finish(entries);
    });
  });
}

function currentInstallRoot() {
  const appPath = safeCall(() => require("electron").app.getAppPath(), "") || "";
  const normalized = appPath.replace(/\\/g, "/");
  const mac = normalized.match(/^(.*?\.app)\/Contents\//);
  if (mac) return mac[1];
  const packed = normalized.match(/^(.*)\/resources\/app(?:\.asar)?$/);
  if (packed) return packed[1];
  return normalized; // dev: repo root
}

function isProductProcess(command) {
  return PRODUCT_NAME_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Duplicate installs ("authorized but nothing works" after side-by-side
 * renames) and zombie engines from an OLD install path both survive every
 * shallow check. ps/tasklist enumeration failing means skip, not error.
 *
 * Legitimate locations (current install root, current userData, current
 * engine dir) are excluded — the bundled runtime node lives under userData,
 * so without the exclusion every healthy machine would report zombies.
 */
async function environmentProcessesCheck(options = {}) {
  const id = "environment.processes";
  const label = "运行环境";
  try {
    const listFn = options.listProcessesFn || defaultListProcesses;
    const entries = await listFn(Number(options.processScanTimeoutMs || 10_000));
    if (!Array.isArray(entries)) {
      return check("ok", id, label, "跳过：无法枚举系统进程。");
    }

    const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const userData = normalize(safeCall(() => require("electron").app.getPath("userData"), ""));
    const enginePath = normalize(options.enginePath ?? safeCall(() => require("./agent-command").resolveOpencodeCommand(), ""));
    const engineDir = enginePath ? normalize(path.dirname(enginePath)) : "";
    const installRoot = normalize(currentInstallRoot());
    const legitimateRoots = [installRoot, userData, engineDir].filter(Boolean);
    const isLegitimate = (command) => {
      const normalized = normalize(command);
      return legitimateRoots.some((root) => normalized.startsWith(root));
    };

    const instances = new Map(); // normalized binary path → example command
    const zombies = [];
    for (const entry of entries) {
      if (!entry || entry.pid === process.pid) continue;
      if (!isProductProcess(entry.command)) continue;
      if (/--type=/.test(entry.command)) continue; // electron renderer/gpu/utility children
      if (isLegitimate(entry.command)) continue;
      const looksLikeAppMain = /\/contents\/macos\//i.test(entry.command.replace(/\\/g, "/")) || /\.exe(\s|$)/i.test(entry.command);
      if (looksLikeAppMain) {
        instances.set(normalize(entry.command).split(" ")[0], entry.command);
      } else {
        zombies.push(entry.command);
      }
    }

    const problems = [];
    if (instances.size > 0) {
      problems.push(`检测到其他安装位置的应用实例正在运行（${[...instances.values()].slice(0, 3).join("；")}）`);
    }
    if (zombies.length > 0) {
      problems.push(`检测到旧安装残留的引擎/运行时进程（${zombies.slice(0, 3).join("；")}）`);
    }
    if (problems.length) {
      return check(
        "warning",
        id,
        label,
        `${problems.join("；")}。多个实例或旧版本残留会抢占会话与端口，表现为"诊断正常但无法使用"。`,
        "close_duplicate_instances",
      );
    }
    return check("ok", id, label, "未发现重复实例或旧版本残留进程。");
  } catch (err) {
    return check("ok", id, label, `运行环境检查跳过：${err?.message || err}`);
  }
}

module.exports = {
  modelAgentConformanceCheck,
  engineBootCheck,
  sessionStoreCheck,
  environmentProcessesCheck,
};
