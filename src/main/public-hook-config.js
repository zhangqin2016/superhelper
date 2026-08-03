"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SAFE_ENV_KEYS = new Set(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "WINDIR"]);

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

class PublicHookConfigStore {
  constructor(filePath) { this.filePath = filePath; }
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed?.hooks) ? parsed.hooks : [];
    } catch { return []; }
  }
  save(hooks) { atomicWrite(this.filePath, { schemaVersion: 1, hooks }); }
  upsert(hook) {
    const hooks = this.load().filter((item) => String(item.id) !== String(hook.id));
    hooks.push(hook);
    this.save(hooks);
  }
  remove(id) {
    const before = this.load();
    const after = before.filter((item) => String(item.id) !== String(id));
    if (after.length !== before.length) this.save(after);
    return after.length !== before.length;
  }
}

function commandExecutor(hook, event) {
  const argv = Array.isArray(hook.config?.command) ? hook.config.command.map(String) : [];
  if (!argv.length || !path.isAbsolute(argv[0])) throw new Error("PUBLIC_HOOK_COMMAND_ABSOLUTE_PATH_REQUIRED");
  const env = {};
  for (const key of SAFE_ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { shell: false, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error("PUBLIC_HOOK_TIMEOUT"));
    }, hook.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-16_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      if (code !== 0) return finish(reject, new Error(stderr || `PUBLIC_HOOK_COMMAND_EXIT_${code}`));
      try { finish(resolve, stdout.trim() ? JSON.parse(stdout) : {}); }
      catch { finish(reject, new Error("PUBLIC_HOOK_OUTPUT_INVALID")); }
    });
    child.stdin.on("error", (error) => finish(reject, error));
    child.stdin.end(JSON.stringify(event));
  });
}

async function httpExecutor(hook, event, allowedOrigins) {
  const url = new URL(String(hook.config?.url || ""));
  if (!allowedOrigins.has(url.origin)) throw new Error("PUBLIC_HOOK_HTTP_ORIGIN_DENIED");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), hook.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`PUBLIC_HOOK_HTTP_${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } finally { clearTimeout(timer); }
}

function createPublicHookExecutors(injected = {}) {
  const allowedOrigins = new Set(String(process.env.LILY_PUBLIC_HOOK_HTTP_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean));
  return {
    command: commandExecutor,
    http: (hook, event) => httpExecutor(hook, event, allowedOrigins),
    prompt: injected.prompt || (async () => { throw new Error("PUBLIC_HOOK_PROMPT_EXECUTOR_UNAVAILABLE"); }),
    agent: injected.agent || (async () => { throw new Error("PUBLIC_HOOK_AGENT_EXECUTOR_UNAVAILABLE"); }),
    mcp: injected.mcp || (async () => { throw new Error("PUBLIC_HOOK_MCP_EXECUTOR_UNAVAILABLE"); }),
  };
}

module.exports = { PublicHookConfigStore, createPublicHookExecutors };
