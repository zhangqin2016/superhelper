#!/usr/bin/env node
/**
 * Guide evals — does the model OBEY the rules it was shown, and DISCOVER the
 * skills the index told it about?
 *
 * This is the live half of the "no dumber" ruler. The offline half,
 * scripts/test-agent-guide-rule-contract.mjs, proves each rule is still IN the
 * assembled guide; that runs on every change with no credentials. This proves
 * the model acts on it, and needs a real gateway.
 *
 * Deliberately separate from run-model-evals.mjs. That suite answers "did the
 * MODEL get worse" and its baselines were recorded without the guide in
 * context; this one answers "did the GUIDE stop working". Same model, different
 * question, so different baselines — mixing them would make one suite's
 * re-baseline silently invalidate the other's.
 *
 * Usage:
 *   LILY_EVAL_BASE_URL=https://gw/v1 LILY_EVAL_API_KEY=sk-... \
 *   LILY_EVAL_MODEL="Qwen/Qwen3.5-27B" node scripts/eval/run-guide-evals.mjs
 *
 *   --update-baseline   accept current results as the new baseline
 *   --case <id>         run a single case
 *   --locale <tag>      assemble the guide in this locale (default zh-CN)
 *
 * Baselines live in scripts/eval/baselines-guide/<model>.<locale>.json.
 * Exit codes: 0 ok / 1 selected-case failure or baseline regression / 2 setup failure.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { evaluateModelEval, parseModelEvalArgs } from "./model-eval-policy.mjs";
import { buildGuideEvalCases } from "./guide-eval-cases.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// Must be set BEFORE the runtime module loads skill-manager, hence the dynamic
// import: the guide's placeholders resolve real runtime paths under userData.
if (!process.env.LILY_USER_DATA_DIR) {
  const evalUserData = path.join(os.tmpdir(), "lily-guide-eval-userdata");
  fs.mkdirSync(evalUserData, { recursive: true });
  process.env.LILY_USER_DATA_DIR = evalUserData;
}
process.env.LILY_HOME ||= process.env.LILY_USER_DATA_DIR;
const { buildEvalPlatformConfig } = await import("./model-eval-runtime.mjs");

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = String(process.argv[index + 1] || "").trim();
  return value && !value.startsWith("-") ? value : fallback;
}
const locale = argValue("--locale", "zh-CN");
// The model is not deterministic. Measured on deepseek-v4-pro: a single run
// scored 9/9, 8/9, 9/9 on the same unchanged code, so a boolean single-run
// baseline reports a FALSE REGRESSION roughly one run in three. Repeating each
// case and taking the majority turns that variance into a signal the gate can
// trust; the recorded successes/runs also make a drifting rate visible before
// it crosses the majority line.
const repeat = Math.max(1, Math.min(9, Number.parseInt(argValue("--repeat", "1"), 10) || 1));

// The guide must be assembled from the REAL skill directories, or the skill
// index the discovery cases depend on would be fictional.
const skillsDir = path.join(repoRoot, "resources", "skills");
const skills = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const skillDir = path.join(skillsDir, entry.name);
    const manifest = JSON.parse(fs.readFileSync(path.join(skillDir, "skill.manifest.json"), "utf8"));
    return { id: manifest.id || entry.name, skillDir, manifest };
  })
  .sort((a, b) => a.id.localeCompare(b.id));
const skillDirs = Object.fromEntries(skills.map((skill) => [skill.id, path.join(skill.skillDir, "SKILL.md")]));

const CASES = buildGuideEvalCases({ skillDirs });
const caseIds = CASES.map((item) => item.id);
const CANARY_ID = CASES.find((item) => item.kind === "canary")?.id || "";
if (!CANARY_ID) {
  console.error("guide evals require a canary case: without one, a suite that never saw the guide still looks green");
  process.exit(2);
}

const parsedArgs = parseModelEvalArgs(process.argv.slice(2), caseIds);
if (!parsedArgs.ok) {
  const detail = parsedArgs.error === "UNKNOWN_CASE"
    ? `unknown case ${JSON.stringify(parsedArgs.onlyCase)}; expected one of: ${caseIds.join(", ")}`
    : `expected one of: ${caseIds.join(", ")}`;
  console.error(`invalid --case: ${detail}`);
  process.exit(2);
}
const { updateBaseline, onlyCase } = parsedArgs;

const baseUrl = process.env.LILY_EVAL_BASE_URL || "";
const apiKey = process.env.LILY_EVAL_API_KEY || "";
const model = process.env.LILY_EVAL_MODEL || "";
if (!baseUrl || !model) {
  console.error("set LILY_EVAL_BASE_URL / LILY_EVAL_API_KEY / LILY_EVAL_MODEL");
  process.exit(2);
}

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

async function buildPlatformConfig() {
  const { probeCustomModelProfile } = require("../../src/main/model-compatibility-probe.js");
  const probe = await probeCustomModelProfile({ protocol: "openai", baseUrl, apiKey, model, timeoutMs: 60_000 });
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
  const cfg = buildEvalPlatformConfig({
    lilyEnv,
    compatibilityProfile: probe.profile,
    agentGuide: { skills, locale },
  });
  if (!cfg.ok) {
    console.error(`engine config build failed: ${cfg.reason}`);
    process.exit(2);
  }
  return { configContent: cfg.configContent, profile: probe.profile, runtimeEnv: cfg.runtimeEnv, guideBytes: cfg.guideBytes };
}

function runEngineTurn(configPath, cwd, prompt, runtimeEnv = {}, timeoutMs = 180_000) {
  const out = execFileSync(engineBin(), ["run", prompt], {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    env: {
      ...process.env,
      ...runtimeEnv,
      PWD: cwd,
      OPENCODE_CONFIG: configPath,
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    },
  });
  return out
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((line) => !/^\s*>\s/.test(line))
    .join("\n")
    .trim();
}

const { configContent, profile, runtimeEnv, guideBytes } = await buildPlatformConfig();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "lily-guide-eval-"));
const configPath = path.join(work, "opencode-guide-eval-config.json");
fs.writeFileSync(configPath, configContent);

console.log(`model: ${model}`);
console.log(`locale: ${locale}   system prompt with guide: ${guideBytes}B   skills indexed: ${skills.length}   repeat: ${repeat}`);
console.log(`profile: overlay=${Boolean(profile?.requestBodyOverlay)} toolShapeCompat=${Boolean(profile?.toolShapeCompat)} grade=${runtimeEnv.LILY_MODEL_CAPABILITY_GRADE || "standard"}\n`);

const results = {};
for (const c of CASES) {
  if (onlyCase && c.id !== onlyCase) continue;
  let successes = 0;
  let lastFailure = "";
  let lastError = "";
  let sample = "";
  for (let attempt = 0; attempt < repeat; attempt += 1) {
    const dir = fs.mkdtempSync(path.join(work, `${c.id}-${attempt}-`));
    try {
      if (c.setup) c.setup(dir);
      const text = runEngineTurn(configPath, dir, c.prompt, runtimeEnv);
      if (c.check(text)) {
        successes += 1;
        if (!sample) sample = text.slice(0, 160);
      } else {
        lastFailure = text.slice(0, 220);
      }
    } catch (err) {
      lastError = String(err?.message || err).slice(0, 200);
    }
  }
  // Majority, so one unlucky sample neither fails a healthy case nor hides a
  // broken one.
  const pass = successes >= Math.ceil(repeat / 2);
  results[c.id] = {
    pass,
    kind: c.kind,
    runs: repeat,
    successes,
    sample: sample || lastFailure.slice(0, 160),
    ...(lastError ? { error: lastError } : {}),
  };
  const rate = repeat > 1 ? ` (${successes}/${repeat})` : "";
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${c.kind.padEnd(9)} ${c.id}${rate}` +
    `${pass || !lastFailure ? "" : `\n      output: ${JSON.stringify(lastFailure)}`}` +
    `${lastError ? `\n      error: ${lastError}` : ""}`,
  );
}
fs.rmSync(work, { recursive: true, force: true });

// A failed canary means the guide never reached the model, so nothing else in
// this run measured what it claims to. That is a broken instrument, not a set
// of model failures — report it as setup and refuse to write a baseline.
if (results[CANARY_ID] && results[CANARY_ID].pass === false) {
  console.error(
    `\nCANARY FAILED (${CANARY_ID}): the assembled guide did not reach the model, so every other case in this run is meaningless. ` +
    "Fix the injection before reading or writing a baseline.",
  );
  process.exit(2);
}

const baselineDir = path.join(here, "baselines-guide");
const baselinePath = path.join(baselineDir, `${model.replace(/[^a-zA-Z0-9.-]+/g, "_")}.${locale}.json`);
let baseline = null;
if (fs.existsSync(baselinePath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    baseline = parsed == null ? {} : parsed;
  } catch {
    baseline = {};
  }
}

const outcome = evaluateModelEval({ results, baseline, onlyCase, updateBaseline, expectedCaseIds: caseIds });
for (const id of outcome.regressions) {
  console.log(`REGRESSION  ${id}: baseline passed, now fails`);
}

const passCount = Object.values(results).filter((r) => r.pass).length;
const byKind = {};
for (const [id, value] of Object.entries(results)) {
  const kind = value.kind || "?";
  byKind[kind] = byKind[kind] || { pass: 0, total: 0 };
  byKind[kind].total += 1;
  if (value.pass) byKind[kind].pass += 1;
  void id;
}
console.log(`\n${passCount}/${Object.keys(results).length} passed  (${Object.entries(byKind).map(([k, v]) => `${k} ${v.pass}/${v.total}`).join(", ")})`);
if (repeat > 1) {
  const unstable = Object.entries(results)
    .filter(([, v]) => Number.isFinite(v.successes) && v.successes > 0 && v.successes < v.runs)
    .map(([id, v]) => `${id} ${v.successes}/${v.runs}`);
  if (unstable.length) {
    console.log(`unstable (will flip a future run, tighten the prompt or the check): ${unstable.join(", ")}`);
  }
}
if (outcome.missingBaseline) {
  console.error(`baseline missing: ${path.relative(repoRoot, baselinePath)} (run with --update-baseline after reviewing live results)`);
}
if (outcome.setupError) console.error(`guide eval setup invalid: ${outcome.setupError}`);

if (updateBaseline && !onlyCase && outcome.exitCode !== 2) {
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify({ model, locale, updatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`baseline written: ${path.relative(repoRoot, baselinePath)}`);
}
process.exit(outcome.exitCode);
