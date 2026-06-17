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
const scanPath = path.join(tmp, "scan.json");
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
fs.writeFileSync(
  scanPath,
  JSON.stringify(
    {
      ok: true,
      schemaVersion: 1,
      mode: "read-only-scan",
      baseUrl: "https://oa.example.com/home",
      allowedDomains: ["oa.example.com"],
      coverage: {
        pageCount: 3,
        errorCount: 0,
        warningCount: 0,
        actionCandidateCount: 3,
        businessObjectCount: 2,
        apiContractCount: 1,
        fingerprint: "scan-fingerprint",
        limitations: ["Read-only crawl follows same-domain links and does not submit forms."],
      },
      siteMap: {
        nodes: [
          { id: "home", url: "https://oa.example.com/home", title: "Home", urlPattern: "https://oa.example.com/home" },
          { id: "approvals", url: "https://oa.example.com/approvals", title: "Approvals", urlPattern: "https://oa.example.com/approvals" },
        ],
        edges: [{ from: "https://oa.example.com/home", to: "https://oa.example.com/approvals", label: "Approvals" }],
      },
      pages: [
        {
          id: "home",
          url: "https://oa.example.com/home",
          urlPattern: "https://oa.example.com/home",
          title: "Home",
          fingerprint: "home-fp",
          headings: [{ level: "h1", text: "Home" }],
          navItems: [{ text: "Approvals", url: "https://oa.example.com/approvals" }],
          buttons: [{ text: "Search", riskHint: "read" }],
          inputs: [{ label: "Keyword", type: "search", name: "q", required: false }],
          tables: [],
          actionCandidates: [{ kind: "button", label: "Search", riskHint: "read", sourceUrl: "https://oa.example.com/home" }],
          interactionCandidates: [{ scanId: "i0", text: "More approvals", tag: "button", role: "button", riskHint: "read", reason: "safe-text" }],
        },
        {
          id: "approvals",
          url: "https://oa.example.com/approvals",
          urlPattern: "https://oa.example.com/approvals",
          title: "Approvals",
          fingerprint: "approvals-fp",
          headings: [{ level: "h1", text: "Approvals" }],
          navItems: [],
          buttons: [{ text: "Submit", riskHint: "mutating" }],
          inputs: [{ label: "Reason", type: "text", name: "reason", required: true }],
          forms: [
            {
              label: "Leave request",
              action: "https://oa.example.com/leave/submit",
              method: "post",
              riskHint: "mutating",
              fieldCount: 3,
              submitButtons: ["Submit"],
              fields: [
                { label: "Leave type", type: "select", required: true, options: [{ label: "Annual", value: "annual" }, { label: "Sick", value: "sick" }] },
                { label: "Start date", type: "date", required: true, options: [] },
                { label: "Reason", type: "text", required: true, options: [] },
              ],
            },
          ],
          formContracts: [
            {
              id: "leave-form",
              label: "Leave request",
              action: "https://oa.example.com/leave/submit",
              method: "post",
              riskHint: "mutating",
              fieldCount: 3,
              submitButtons: ["Submit"],
              fields: [
                { label: "Leave type", type: "select", required: true, options: [{ label: "Annual", value: "annual" }, { label: "Sick", value: "sick" }] },
                { label: "Start date", type: "date", required: true, options: [] },
                { label: "Reason", type: "text", required: true, options: [] },
              ],
              executionPolicy: {
                learnOnly: true,
                fillDraftAllowed: true,
                canSubmitDuringLearning: false,
                submitRequiresConfirmation: true,
              },
              apiContract: {
                id: "leave-api",
                source: "static-form",
                endpoint: "https://oa.example.com/leave/submit",
                method: "POST",
                contentType: "form",
                requestFields: [
                  { label: "Leave type", name: "", type: "select", required: true, options: [{ label: "Annual", value: "annual" }, { label: "Sick", value: "sick" }] },
                  { label: "Start date", name: "", type: "date", required: true, options: [] },
                  { label: "Reason", name: "", type: "text", required: true, options: [] },
                ],
                submitButtons: ["Submit"],
                knownStaticEndpoint: true,
                needsSubmitProbe: false,
                learningMode: "read-only",
                testEnvironment: "",
                probePolicy: {
                  requiresUserConsent: true,
                  useSyntheticValuesOnly: true,
                  abortUnsafeNetworkRequests: true,
                  redactPayloadValues: true,
                  neverCompleteBusinessSubmitDuringLearning: true,
                  allowRealSubmitInTestLab: false,
                },
              },
            },
          ],
          tables: [{ caption: "Approval list", headers: ["Title", "Status"], rowCount: 10 }],
          actionCandidates: [{ kind: "button", label: "Submit", riskHint: "mutating", sourceUrl: "https://oa.example.com/approvals" }],
        },
        {
          id: "approval-filter-panel",
          source: "interactive-readonly",
          sourceInteraction: {
            fromPageId: "home",
            fromUrl: "https://oa.example.com/home",
            scanId: "i0",
            label: "More approvals",
            reason: "safe-text",
          },
          url: "https://oa.example.com/home",
          urlPattern: "https://oa.example.com/home",
          title: "Home",
          fingerprint: "home-filter-panel-fp",
          headings: [{ level: "h2", text: "Advanced filters" }],
          navItems: [],
          buttons: [{ text: "Filter", riskHint: "read" }],
          inputs: [{ label: "Status", type: "select", name: "status", required: false, options: [{ label: "Pending", value: "pending" }] }],
          tables: [],
          actionCandidates: [{ kind: "button", label: "Filter", riskHint: "read", sourceUrl: "https://oa.example.com/home" }],
        },
      ],
      actionCandidates: [
        { kind: "button", label: "Search", riskHint: "read", sourceUrl: "https://oa.example.com/home" },
        { kind: "button", label: "Submit", riskHint: "mutating", sourceUrl: "https://oa.example.com/approvals" },
      ],
      businessObjects: [
        {
          id: "approval-object",
          name: "Approvals",
          source: "scan",
          sourceUrl: "https://oa.example.com/approvals",
          fields: [
            { name: "Reason", source: "page-input", confidence: "medium" },
            { name: "Status", source: "table-header", confidence: "medium" },
          ],
        },
      ],
      warnings: [],
    },
    null,
    2,
  ),
);

let result = spawnSync(process.execPath, [script, "--spec", specPath, "--scan", scanPath, "--out", outDir], {
  cwd: ROOT,
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error(`create_web_system_skill failed: ${result.stderr || result.stdout}`);
}

const draftDir = path.join(outDir, "demo-oa");
const skillMd = fs.readFileSync(path.join(draftDir, "SKILL.md"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(draftDir, "skill.manifest.json"), "utf8"));
const systemProfile = JSON.parse(fs.readFileSync(path.join(draftDir, "system-profile.json"), "utf8"));
const pageMap = JSON.parse(fs.readFileSync(path.join(draftDir, "page-map.json"), "utf8"));
const domainModel = JSON.parse(fs.readFileSync(path.join(draftDir, "domain-model.json"), "utf8"));
const playbook = JSON.parse(fs.readFileSync(path.join(draftDir, "web-system-playbook.json"), "utf8"));
const riskPolicy = JSON.parse(fs.readFileSync(path.join(draftDir, "risk-policy.json"), "utf8"));
const examplesJsonl = fs.readFileSync(path.join(draftDir, "examples.jsonl"), "utf8");
const changeLog = JSON.parse(fs.readFileSync(path.join(draftDir, "change-log.json"), "utf8"));
const scanArchive = JSON.parse(fs.readFileSync(path.join(draftDir, "web-system-scan.json"), "utf8"));
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
if (manifest.origin !== "workspace" || manifest.workspaceOnly !== true || manifest.category !== "workspace") {
  throw new Error(`generated web system skills must be workspace-scoped: ${JSON.stringify(manifest)}`);
}
if (normalizedPlaybook.connector.kind !== "web" || normalizedPlaybook.actions[0].action !== "web.query-approval") {
  throw new Error(`generated playbook should use the connector protocol: ${JSON.stringify(playbook)}`);
}
if (normalizedPlaybook.actions[1].confirmation !== "explicit") {
  throw new Error("submit action confirmation must survive playbook normalization");
}
if (!normalizedPlaybook.apiContracts?.some((contract) => contract.id === "leave-api" && contract.risk === "submit")) {
  throw new Error(`normalized connector playbook should preserve API contracts: ${JSON.stringify(normalizedPlaybook)}`);
}
if (normalizedPlaybook.actions[1].metadata?.executionStrategy?.preferred !== "api-first") {
  throw new Error(`normalized connector action should preserve execution strategy metadata: ${JSON.stringify(normalizedPlaybook.actions[1])}`);
}
if (!playbook.apiContracts?.some((contract) => contract.id === "leave-api" && contract.endpoint === "https://oa.example.com/leave/submit")) {
  throw new Error(`generated playbook should promote learned API contracts: ${JSON.stringify(playbook)}`);
}
if (playbook.connector.capabilities.includes("web.api") !== true) {
  throw new Error(`web connector should advertise API execution: ${JSON.stringify(playbook.connector)}`);
}
if (playbook.actions[1].metadata?.executionStrategy?.preferred !== "api-first" || !playbook.actions[1].metadata?.apiContractRefs?.includes("leave-api")) {
  throw new Error(`submit action should prefer learned API contract with browser fallback: ${JSON.stringify(playbook.actions[1])}`);
}
if (systemProfile.systemName !== "Demo OA" || systemProfile.files.pageMap !== "page-map.json") {
  throw new Error(`generated system profile should index the learned archive: ${JSON.stringify(systemProfile)}`);
}
if (systemProfile.files.scanArchive !== "web-system-scan.json" || systemProfile.learningCoverage?.pageCount !== 3) {
  throw new Error(`generated system profile should include scan coverage: ${JSON.stringify(systemProfile)}`);
}
if (systemProfile.learningCoverage?.formContractCount !== 1) {
  throw new Error(`generated system profile should count learned form contracts: ${JSON.stringify(systemProfile)}`);
}
if (systemProfile.learningCoverage?.interactivePageCount !== 1) {
  throw new Error(`generated system profile should count interactive readonly discoveries: ${JSON.stringify(systemProfile)}`);
}
if (systemProfile.learningCoverage?.apiContractCount !== 1 || systemProfile.learningCoverage?.learningMode !== "read-only") {
  throw new Error(`generated system profile should preserve API contract coverage and learning mode: ${JSON.stringify(systemProfile)}`);
}
if (!pageMap.pages.some((page) => page.actions.includes("web.query-approval"))) {
  throw new Error(`page map should connect pages to actions: ${JSON.stringify(pageMap)}`);
}
if (!pageMap.pages.some((page) => page.source === "scan" && page.fingerprint === "approvals-fp")) {
  throw new Error(`page map should include scanned pages and fingerprints: ${JSON.stringify(pageMap)}`);
}
if (!pageMap.pages.some((page) => page.source === "interactive-readonly" && page.sourceInteraction?.label === "More approvals")) {
  throw new Error(`page map should preserve interactive readonly discoveries: ${JSON.stringify(pageMap)}`);
}
const scannedApprovalPage = pageMap.pages.find((page) => page.source === "scan" && page.id === "approvals");
if (!scannedApprovalPage?.formContracts?.some((form) => form.id === "leave-form" && form.fields.some((field) => field.label === "Leave type" && field.options.length === 2))) {
  throw new Error(`page map should preserve learned form field contracts: ${JSON.stringify(pageMap)}`);
}
if (!scannedApprovalPage?.formContracts?.some((form) => form.apiContract?.endpoint === "https://oa.example.com/leave/submit" && form.apiContract?.method === "POST")) {
  throw new Error(`page map should preserve learned API contracts: ${JSON.stringify(pageMap)}`);
}
if (!domainModel.objects.length || !domainModel.vocabulary.some((item) => item.action === "web.submit-leave")) {
  throw new Error(`domain model should include business objects and action vocabulary: ${JSON.stringify(domainModel)}`);
}
if (!domainModel.objects.some((object) => object.source === "scan" && object.fields.some((field) => field.name === "Reason"))) {
  throw new Error(`domain model should include scanned business fields: ${JSON.stringify(domainModel)}`);
}
if (!riskPolicy.forbiddenDuringLearning.includes("approve") || !riskPolicy.actionPolicies.some((policy) => policy.action === "web.submit-leave" && policy.requiresUserReview)) {
  throw new Error(`risk policy should encode learning-time red lines and confirmations: ${JSON.stringify(riskPolicy)}`);
}
if (!riskPolicy.learnedFormPolicies.some((policy) => policy.formId === "leave-form" && policy.learningPolicy.canSubmitDuringLearning === false && policy.learningPolicy.submitRequiresConfirmation)) {
  throw new Error(`risk policy should preserve learned form submit guardrails: ${JSON.stringify(riskPolicy)}`);
}
if (riskPolicy.allowMutatingLearning !== false || riskPolicy.learningMode !== "read-only") {
  throw new Error(`production/default learning must not allow mutating learning: ${JSON.stringify(riskPolicy)}`);
}
const examples = examplesJsonl.trim().split("\n").map((line) => JSON.parse(line));
if (!examples.some((example) => example.utterance === "查审批状态" && example.action === "web.query-approval")) {
  throw new Error(`examples should map natural language to actions: ${examplesJsonl}`);
}
if (changeLog.entries[0]?.type !== "initial-draft") {
  throw new Error(`change log should record initial learning draft: ${JSON.stringify(changeLog)}`);
}
if (scanArchive.coverage.pageCount !== 3 || scanArchive.actionCandidates.length !== 2) {
  throw new Error(`scan archive should be copied into the generated skill: ${JSON.stringify(scanArchive)}`);
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
    operations: [
      { type: "goto", path: "/leave/new", risk: "read" },
      { type: "fill", label: "Reason", value: "annual leave", risk: "prepare" },
      { type: "select", label: "Leave type", optionLabel: "Annual leave", risk: "prepare" },
      { type: "check", label: "I confirm", risk: "prepare" },
      { type: "waitForText", text: "Submit", risk: "read" },
    ],
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
if (!reviewPayload.operations.some((op) => op.type === "select" && op.optionLabel === "Annual leave")) {
  throw new Error(`submit review payload should preserve validated form controls: ${result.stdout}`);
}

const apiSubmitPlanPath = path.join(tmp, "api-submit-plan.json");
fs.writeFileSync(
  apiSubmitPlanPath,
  JSON.stringify({
    action: "web.submit-leave",
    operations: [
      {
        type: "apiRequest",
        contractId: "leave-api",
        method: "POST",
        risk: "submit",
        contentType: "form",
        body: { leaveType: "annual", startDate: "2026-06-17", reason: "annual leave" },
      },
    ],
  }),
);
result = spawnSync(process.execPath, [draftExecutor, "--playbook", path.join(draftDir, "web-system-playbook.json"), "--action", "web.submit-leave", "--plan", apiSubmitPlanPath, "--dry-run"], {
  cwd: draftDir,
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error(`api submit dry-run should validate and require review: ${result.stderr || result.stdout}`);
}
const apiReviewPayload = JSON.parse(result.stdout);
if (!apiReviewPayload.reviewRequired || apiReviewPayload.operations[0].url !== "https://oa.example.com/leave/submit") {
  throw new Error(`api submit should resolve contract URL and keep confirmation gate: ${result.stdout}`);
}

const apiCredentialPlanPath = path.join(tmp, "api-credential-plan.json");
fs.writeFileSync(
  apiCredentialPlanPath,
  JSON.stringify({
    action: "web.submit-leave",
    operations: [
      {
        type: "apiRequest",
        contractId: "leave-api",
        method: "POST",
        risk: "submit",
        headers: { Authorization: "Bearer should-not-be-here" },
        body: { reason: "annual leave" },
      },
    ],
  }),
);
result = spawnSync(process.execPath, [draftExecutor, "--playbook", path.join(draftDir, "web-system-playbook.json"), "--action", "web.submit-leave", "--plan", apiCredentialPlanPath, "--dry-run"], {
  cwd: draftDir,
  encoding: "utf8",
});
if (result.status === 0 || !result.stderr.includes("must not include credential header")) {
  throw new Error("apiRequest should reject credential-bearing model plans");
}

const invalidSubmitPlanPath = path.join(tmp, "invalid-submit-plan.json");
fs.writeFileSync(
  invalidSubmitPlanPath,
  JSON.stringify({
    action: "web.submit-leave",
    operations: [{ type: "select", label: "Leave type", risk: "prepare" }],
  }),
);
result = spawnSync(process.execPath, [draftExecutor, "--playbook", path.join(draftDir, "web-system-playbook.json"), "--action", "web.submit-leave", "--plan", invalidSubmitPlanPath, "--dry-run"], {
  cwd: draftDir,
  encoding: "utf8",
});
if (result.status === 0 || !result.stderr.includes("select requires value, optionLabel, or index")) {
  throw new Error("submit action should validate operation shape before asking for confirmation");
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
    [
      scanner,
      "--base-url",
      "https://oa.example.com/home",
      "--allowed-domain",
      "oa.example.com",
      "--learning-mode",
      "test-lab",
      "--test-environment",
      "qa",
      "--allow-mutating-learning",
      "--dry-run",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`scanner should allow explicit test-lab learning: ${result.stderr || result.stdout}`);
  }
  const testLabPlan = JSON.parse(result.stdout);
  if (testLabPlan.learningMode !== "test-lab" || testLabPlan.testEnvironment !== "qa" || !testLabPlan.allowMutatingLearning) {
    throw new Error(`unexpected test-lab dry-run output: ${result.stdout}`);
  }

  result = spawnSync(
    python,
    [scanner, "--base-url", "https://oa.example.com/home", "--allowed-domain", "oa.example.com", "--learning-mode", "test-lab", "--dry-run"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status === 0 || !result.stderr.includes("TEST_LAB_CONFIRMATION_REQUIRED")) {
    throw new Error("test-lab learning should require explicit environment and mutating acknowledgement");
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
