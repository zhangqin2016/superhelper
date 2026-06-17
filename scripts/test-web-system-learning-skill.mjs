import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const { normalizePlaybookSpec } = require("../src/main/connector-protocol.js");
const skillDir = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning");
const script = path.join(skillDir, "scripts/create_web_system_skill.cjs");
const scanner = path.join(skillDir, "scripts/scan_web_system.py");
const executor = path.join(skillDir, "scripts/execute_web_playbook.cjs");

if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) {
  throw new Error("lily-web-system-learning SKILL.md missing");
}
if (!fs.existsSync(path.join(skillDir, "skill.manifest.json"))) {
  throw new Error("lily-web-system-learning manifest missing");
}
if (!fs.existsSync(scanner)) {
  throw new Error("lily-web-system-learning scanner missing");
}
if (!fs.existsSync(executor)) {
  throw new Error("lily-web-system-learning executor missing");
}

function findPython() {
  for (const candidate of ["python3", "python"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-web-system-learning-"));
const specPath = path.join(tmp, "spec.json");
const outDir = path.join(tmp, "inbox");
fs.writeFileSync(
  specPath,
  JSON.stringify(
    {
      id: "demo-oa",
      name: "Demo OA",
      systemName: "Demo OA",
      baseUrl: "https://oa.example.com/home",
      allowedDomains: ["oa.example.com"],
      summary: "Demo OA approvals.",
      actions: [
        {
          id: "query-approval",
          name: "Query approval status",
          intentExamples: ["查审批状态"],
          risk: "read",
          confirmation: "none",
          entry: "Approvals > Mine",
          steps: ["Open my approvals.", "Search by keyword.", "Return status and latest comment."],
        },
        {
          id: "submit-leave",
          name: "Submit leave request",
          intentExamples: ["提交请假"],
          risk: "submit",
          confirmation: "explicit",
          steps: ["Open leave form.", "Fill date and reason.", "Show final values before submit."],
        },
      ],
    },
    null,
    2,
  ),
);

let result = spawnSync(process.execPath, [script, "--spec", specPath, "--out", outDir], {
  cwd: ROOT,
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error(`create_web_system_skill failed: ${result.stderr || result.stdout}`);
}

const draftDir = path.join(outDir, "demo-oa");
const skillMd = fs.readFileSync(path.join(draftDir, "SKILL.md"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(draftDir, "skill.manifest.json"), "utf8"));
const playbook = JSON.parse(fs.readFileSync(path.join(draftDir, "web-system-playbook.json"), "utf8"));
const draftExecutor = path.join(draftDir, "scripts/execute_web_playbook.cjs");
const normalizedPlaybook = normalizePlaybookSpec(playbook);
if (!skillMd.includes("Allowed domains") || !skillMd.includes("explicit confirmation")) {
  throw new Error("generated skill should include domain and confirmation guardrails");
}
if (skillMd.includes("password") && !skillMd.includes("Never ask for or store passwords")) {
  throw new Error("generated skill must not store credentials");
}
if (manifest.id !== "demo-oa" || manifest.riskLevel !== "high") {
  throw new Error(`unexpected manifest: ${JSON.stringify(manifest)}`);
}
if (normalizedPlaybook.connector.kind !== "web" || normalizedPlaybook.actions[0].action !== "web.query-approval") {
  throw new Error(`generated playbook should use the connector protocol: ${JSON.stringify(playbook)}`);
}
if (normalizedPlaybook.actions[1].confirmation !== "explicit") {
  throw new Error("submit action confirmation must survive playbook normalization");
}
if (!fs.existsSync(draftExecutor)) {
  throw new Error("generated web system skill should carry a local playbook executor");
}

const readPlanPath = path.join(tmp, "read-plan.json");
fs.writeFileSync(
  readPlanPath,
  JSON.stringify({
    action: "web.query-approval",
    operations: [
      { type: "goto", path: "/approvals", risk: "read" },
      { type: "extract", selector: "body", label: "approval list" },
    ],
  }),
);
result = spawnSync(process.execPath, [draftExecutor, "--playbook", path.join(draftDir, "web-system-playbook.json"), "--action", "web.query-approval", "--plan", readPlanPath, "--dry-run"], {
  cwd: draftDir,
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error(`web playbook executor dry-run failed: ${result.stderr || result.stdout}`);
}
const validatedReadPlan = JSON.parse(result.stdout);
if (!validatedReadPlan.ok || validatedReadPlan.reviewRequired || validatedReadPlan.operations[0].url !== "https://oa.example.com/approvals") {
  throw new Error(`unexpected validated read plan: ${result.stdout}`);
}

const unsafeReadPlanPath = path.join(tmp, "unsafe-read-plan.json");
fs.writeFileSync(
  unsafeReadPlanPath,
  JSON.stringify({
    action: "web.query-approval",
    operations: [{ type: "fill", selector: "#amount", value: "100", risk: "prepare" }],
  }),
);
result = spawnSync(process.execPath, [draftExecutor, "--playbook", path.join(draftDir, "web-system-playbook.json"), "--action", "web.query-approval", "--plan", unsafeReadPlanPath, "--dry-run"], {
  cwd: draftDir,
  encoding: "utf8",
});
if (result.status === 0 || !result.stderr.includes("risk prepare exceeds action risk read")) {
  throw new Error("read action should reject prepare/write browser operations");
}

const submitPlanPath = path.join(tmp, "submit-plan.json");
fs.writeFileSync(
  submitPlanPath,
  JSON.stringify({
    action: "web.submit-leave",
    operations: [{ type: "fill", selector: "#reason", value: "annual leave", risk: "prepare" }],
  }),
);
result = spawnSync(process.execPath, [draftExecutor, "--playbook", path.join(draftDir, "web-system-playbook.json"), "--action", "web.submit-leave", "--plan", submitPlanPath, "--dry-run"], {
  cwd: draftDir,
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error(`submit dry-run should return review-required payload: ${result.stderr || result.stdout}`);
}
const reviewPayload = JSON.parse(result.stdout);
if (!reviewPayload.reviewRequired || reviewPayload.risk !== "submit") {
  throw new Error(`submit action should require review before execution: ${result.stdout}`);
}

const parentSpecPath = path.join(tmp, "parent-domain.json");
fs.writeFileSync(
  parentSpecPath,
  JSON.stringify({
    id: "parent-oa",
    name: "Parent OA",
    baseUrl: "https://oa.example.com",
    allowedDomains: ["example.com"],
    actions: [{ id: "query-home", name: "Query home", risk: "read", confirmation: "none", steps: ["Open home."] }],
  }),
);
result = spawnSync(process.execPath, [script, "--spec", parentSpecPath, "--out", outDir, "--dry-run"], {
  cwd: ROOT,
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error(`parent domain should be accepted by skill generator: ${result.stderr || result.stdout}`);
}

const python = findPython();
if (python) {
  result = spawnSync(
    python,
    [
      scanner,
      "--base-url",
      "https://oa.example.com/home",
      "--allowed-domain",
      "oa.example.com",
      "--max-pages",
      "200",
      "--dry-run",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`scan_web_system dry-run failed: ${result.stderr || result.stdout}`);
  }
  const scanPlan = JSON.parse(result.stdout);
  if (scanPlan.mode !== "dry-run" || scanPlan.maxPages !== 100 || scanPlan.allowedDomains[0] !== "oa.example.com") {
    throw new Error(`unexpected scanner dry-run output: ${result.stdout}`);
  }

  result = spawnSync(
    python,
    [scanner, "--base-url", "https://oa.example.com", "--allowed-domain", "example.com", "--dry-run"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`scanner should allow parent-domain allowlists: ${result.stderr || result.stdout}`);
  }

  result = spawnSync(
    python,
    [scanner, "--base-url", "https://oa.example.com", "--allowed-domain", "evil.example.com", "--dry-run"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status === 0 || !result.stderr.includes("BASE_DOMAIN_NOT_ALLOWED")) {
    throw new Error("scanner should reject base URL outside the allowlist");
  }
} else {
  console.warn("web-system-learning-skill: python not found; scanner dry-run check skipped");
}

const badSpecPath = path.join(tmp, "bad.json");
fs.writeFileSync(
  badSpecPath,
  JSON.stringify({
    id: "bad-oa",
    name: "Bad OA",
    baseUrl: "https://oa.example.com",
    allowedDomains: ["oa.example.com"],
    actions: [{ id: "delete-record", name: "Delete record", risk: "destructive", confirmation: "review", steps: ["Delete it."] }],
  }),
);
result = spawnSync(process.execPath, [script, "--spec", badSpecPath, "--out", outDir, "--dry-run"], {
  cwd: ROOT,
  encoding: "utf8",
});
if (result.status === 0 || !result.stderr.includes("destructive actions require explicit confirmation")) {
  throw new Error("destructive action without explicit confirmation should fail validation");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("web-system-learning-skill: ok");
