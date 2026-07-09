#!/usr/bin/env node
/**
 * Model regression evals — the "不变笨" release gate.
 *
 * Drives the FULL platform stack the way a real turn does: compatibility
 * probe → profile (thinking overlay / tool-shape compat) → engine config →
 * bundled opencode binary → model. A regression in ANY layer (probe, config
 * translation, engine bundle, model/gateway behavior) shows up as a case
 * flipping pass→fail against the stored baseline.
 *
 * Usage:
 *   LILY_EVAL_BASE_URL=https://gw/v1 LILY_EVAL_API_KEY=sk-... \
 *   LILY_EVAL_MODEL="Qwen/Qwen3.5-27B" node scripts/eval/run-model-evals.mjs
 *
 *   --update-baseline   accept current results as the new baseline
 *   --case <id>         run a single case
 *
 * Baselines live in scripts/eval/baselines/<model>.json (commit them).
 * Exit codes: 0 ok / 1 regression vs baseline / 2 setup failure.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const baseUrl = process.env.LILY_EVAL_BASE_URL || "";
const apiKey = process.env.LILY_EVAL_API_KEY || "";
const model = process.env.LILY_EVAL_MODEL || "";
if (!baseUrl || !model) {
  console.error("set LILY_EVAL_BASE_URL / LILY_EVAL_API_KEY / LILY_EVAL_MODEL");
  process.exit(2);
}
const updateBaseline = process.argv.includes("--update-baseline");
const onlyCase = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : "";

function engineBin() {
  const key = process.platform === "darwin"
    ? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64")
    : process.platform === "win32" ? "win32-x64" : "linux-x64";
  const bin = path.join(repoRoot, "bundles", key, "opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  if (!fs.existsSync(bin)) {
    console.error(`engine binary missing: ${bin} (run npm run engine:opencode)`);
    process.exit(2);
  }
  return bin;
}

// ---------------------------------------------------------------- platform stack
async function buildPlatformConfig() {
  // Same pipeline a saved custom model goes through: probe → profile → env →
  // engine config. Tool-shape compat has no MCP servers here (core tools
  // only), but the overlay + protocol translation are fully exercised.
  const { probeCustomModelProfile } = require("../../src/main/model-compatibility-probe.js");
  const probe = await probeCustomModelProfile({ protocol: "openai", baseUrl, apiKey, model, timeoutMs: 20_000 });
  if (!probe.ok) {
    console.error(`compatibility probe rejected the endpoint: ${probe.error}`);
    process.exit(2);
  }
  const lilyEnv = {
    LILY_OPENCODE_BASE_URL: baseUrl,
    LILY_OPENCODE_API_KEY: apiKey,
    LILY_OPENCODE_MODEL: model,
    LILY_OPENCODE_PROTOCOL: "openai",
  };
  if (probe.profile?.requestBodyOverlay) {
    lilyEnv.LILY_OPENCODE_BODY_OVERLAY_JSON = JSON.stringify(probe.profile.requestBodyOverlay);
  }
  const { resolveOpencodeModelConfig } = require("../../src/main/runtime/opencode-model-config.js");
  const cfg = resolveOpencodeModelConfig(lilyEnv);
  if (!cfg.ok) {
    console.error(`engine config build failed: ${cfg.reason}`);
    process.exit(2);
  }
  return { configContent: cfg.configContent, profile: probe.profile };
}

function runEngineTurn(configPath, cwd, prompt, timeoutMs = 180_000) {
  const out = execFileSync(engineBin(), ["run", prompt], {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    env: {
      ...process.env,
      // the engine trusts $PWD over process.cwd(); a stale value from the
      // invoking shell would silently re-root every relative file path
      PWD: cwd,
      OPENCODE_CONFIG: configPath,
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    },
  });
  // strip ansi + the "> build · model" banner lines
  return out
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((line) => !/^\s*>\s/.test(line))
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------- cases
const CJK = /[一-鿿]/;
const CASES = [
  {
    id: "basic-instruction",
    prompt: "回复且仅回复大写单词 PONG，不要任何其他内容。",
    check: (text) => /PONG/.test(text) && text.length < 200,
  },
  {
    id: "chinese-reply",
    prompt: "用一句中文介绍你能做什么。",
    check: (text) => CJK.test(text),
  },
  {
    id: "reasoning-arith",
    prompt: "一件商品先涨价20%再降价20%，最终价格是原价的百分之多少？只回答数字和百分号。",
    check: (text) => /96\s*%|96/.test(text),
  },
  {
    id: "tool-roundtrip",
    setup: (dir) => {
      fs.writeFileSync(path.join(dir, "secret.txt"), `暗号是 LILY-${"EVAL"}-7391\n`);
    },
    prompt: "读取当前目录下 secret.txt 的内容，并原样输出其中的暗号。",
    check: (text) => text.includes("LILY-EVAL-7391"),
  },
  {
    id: "negative-constraint",
    prompt: "列出三种水果的中文名，用顿号分隔。不要输出编号，不要解释。",
    check: (text) => CJK.test(text) && !/[1-3][.、)]/.test(text),
  },
];

// ---------------------------------------------------------------- run + baseline
const { configContent, profile } = await buildPlatformConfig();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "lily-eval-"));
const configPath = path.join(work, "opencode-eval-config.json");
fs.writeFileSync(configPath, configContent);

console.log(`model: ${model}`);
console.log(`profile: overlay=${Boolean(profile?.requestBodyOverlay)} toolShapeCompat=${Boolean(profile?.toolShapeCompat)}`);

const results = {};
for (const c of CASES) {
  if (onlyCase && c.id !== onlyCase) continue;
  const dir = fs.mkdtempSync(path.join(work, `${c.id}-`));
  try {
    if (c.setup) c.setup(dir);
    const text = runEngineTurn(configPath, dir, c.prompt);
    const pass = Boolean(c.check(text));
    results[c.id] = { pass, sample: text.slice(0, 160) };
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.id}${pass ? "" : `\n      output: ${JSON.stringify(text.slice(0, 200))}`}`);
  } catch (err) {
    results[c.id] = { pass: false, error: String(err?.message || err).slice(0, 200) };
    console.log(`FAIL  ${c.id} (error: ${String(err?.message || err).slice(0, 120)})`);
  }
}
fs.rmSync(work, { recursive: true, force: true });

const baselineDir = path.join(here, "baselines");
const baselinePath = path.join(baselineDir, `${model.replace(/[^a-zA-Z0-9.-]+/g, "_")}.json`);
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : null;

let regressions = 0;
if (baseline && !onlyCase) {
  for (const [id, prev] of Object.entries(baseline.results || {})) {
    if (prev.pass && results[id] && !results[id].pass) {
      console.log(`REGRESSION  ${id}: baseline passed, now fails`);
      regressions += 1;
    }
  }
}

const passCount = Object.values(results).filter((r) => r.pass).length;
console.log(`\n${passCount}/${Object.keys(results).length} passed${baseline && !onlyCase ? `, ${regressions} regression(s) vs baseline` : " (no baseline)"}`);

if (updateBaseline && !onlyCase) {
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify({ model, updatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`baseline written: ${path.relative(repoRoot, baselinePath)}`);
}
process.exit(regressions > 0 ? 1 : 0);
