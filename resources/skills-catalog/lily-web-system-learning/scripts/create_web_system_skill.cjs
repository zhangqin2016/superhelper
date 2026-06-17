#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const RISK_LEVELS = new Set(["read", "prepare", "submit", "destructive"]);
const CONFIRMATION_LEVELS = new Set(["none", "review", "explicit"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/create_web_system_skill.cjs --spec web-system-spec.json [--scan web-system-scan.json] [--out <dir>] [--dry-run]",
    "",
    "The spec must contain id, name/systemName, baseUrl, allowedDomains[], and actions[].",
    "If --out is omitted, the draft is written to Lily's learned-skills inbox.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { spec: null, scan: null, out: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--spec") {
      args.spec = argv[++i];
    } else if (arg === "--scan") {
      args.scan = argv[++i];
    } else if (arg === "--out") {
      args.out = argv[++i];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.spec) throw new Error("Missing --spec");
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function normalizeHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function isHostAllowed(host, allowedDomains) {
  return allowedDomains.includes(host) || allowedDomains.some((domain) => host.endsWith(`.${domain}`));
}

function escapeMarkdown(value) {
  return String(value || "").replace(/\|/g, "\\|").trim();
}

function sanitizeList(list, field) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  return list.map((item) => String(item || "").trim()).filter(Boolean);
}

function validateSpec(input) {
  const spec = { ...input };
  spec.id = String(spec.id || "").trim().toLowerCase();
  if (!ID_RE.test(spec.id)) {
    throw new Error("id must be lowercase letters/digits/hyphens and start with a letter");
  }

  spec.name = String(spec.name || spec.systemName || "").trim();
  spec.systemName = String(spec.systemName || spec.name || "").trim();
  if (!spec.name || !spec.systemName) throw new Error("name/systemName is required");

  spec.baseUrl = String(spec.baseUrl || "").trim();
  if (!/^https?:\/\//i.test(spec.baseUrl)) throw new Error("baseUrl must start with http:// or https://");

  spec.allowedDomains = sanitizeList(spec.allowedDomains, "allowedDomains").map(normalizeHost);
  const baseHost = normalizeHost(spec.baseUrl);
  if (!isHostAllowed(baseHost, spec.allowedDomains)) {
    throw new Error(`allowedDomains must include baseUrl host or parent domain: ${baseHost}`);
  }

  spec.summary = String(spec.summary || `${spec.systemName} web system automation.`).trim();
  if (!Array.isArray(spec.actions) || spec.actions.length === 0) {
    throw new Error("actions must be a non-empty array");
  }

  const seen = new Set();
  spec.actions = spec.actions.map((action, index) => {
    const item = { ...action };
    item.id = String(item.id || "").trim().toLowerCase();
    if (!ID_RE.test(item.id)) throw new Error(`actions[${index}].id is invalid`);
    if (seen.has(item.id)) throw new Error(`duplicate action id: ${item.id}`);
    seen.add(item.id);

    item.name = String(item.name || "").trim();
    if (!item.name) throw new Error(`actions[${index}].name is required`);

    item.risk = String(item.risk || "read").trim();
    if (!RISK_LEVELS.has(item.risk)) throw new Error(`actions[${index}].risk is invalid`);

    item.confirmation = String(item.confirmation || (item.risk === "read" ? "none" : "review")).trim();
    if (!CONFIRMATION_LEVELS.has(item.confirmation)) {
      throw new Error(`actions[${index}].confirmation is invalid`);
    }
    if (item.risk !== "read" && item.confirmation === "none") {
      throw new Error(`actions[${index}] non-read actions require review or explicit confirmation`);
    }
    if (item.risk === "destructive" && item.confirmation !== "explicit") {
      throw new Error(`actions[${index}] destructive actions require explicit confirmation`);
    }

    item.entry = String(item.entry || "").trim();
    item.intentExamples = Array.isArray(item.intentExamples)
      ? item.intentExamples.map((v) => String(v || "").trim()).filter(Boolean)
      : [];
    item.steps = sanitizeList(item.steps, `actions[${index}].steps`);
    item.selectors = Array.isArray(item.selectors) ? item.selectors.filter(Boolean) : [];
    return item;
  });

  return spec;
}

function normalizeScan(input, spec) {
  if (!input) return null;
  if (input.ok !== true || input.schemaVersion !== 1) {
    throw new Error("scan must be a successful schemaVersion 1 scan payload");
  }
  const allowedDomains = new Set(spec.allowedDomains);
  const scanDomains = Array.isArray(input.allowedDomains) ? input.allowedDomains.map(normalizeHost).filter(Boolean) : [];
  for (const domain of scanDomains) {
    if (!allowedDomains.has(domain) && ![...allowedDomains].some((allowed) => domain.endsWith(`.${allowed}`) || allowed.endsWith(`.${domain}`))) {
      throw new Error(`scan allowed domain is outside spec allowedDomains: ${domain}`);
    }
  }
  const pages = Array.isArray(input.pages) ? input.pages.filter((page) => page && !page.error) : [];
  return {
    schemaVersion: 1,
    mode: input.mode || "read-only-scan",
    learningMode: input.learningMode || input.coverage?.learningMode || "read-only",
    testEnvironment: input.testEnvironment || input.coverage?.testEnvironment || "",
    allowMutatingLearning: Boolean(input.allowMutatingLearning || input.coverage?.allowMutatingLearning),
    baseUrl: input.baseUrl || spec.baseUrl,
    allowedDomains: scanDomains,
    coverage: input.coverage || {},
    siteMap: input.siteMap || { nodes: [], edges: [] },
    pages,
    actionCandidates: Array.isArray(input.actionCandidates) ? input.actionCandidates : [],
    businessObjects: Array.isArray(input.businessObjects) ? input.businessObjects : [],
    apiContracts: Array.isArray(input.apiContracts) ? input.apiContracts : [],
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
  };
}

function defaultInboxDir() {
  if (process.env.LILY_LEARNED_SKILLS_INBOX) return process.env.LILY_LEARNED_SKILLS_INBOX;
  const userData = process.env.LILY_USER_DATA_DIR;
  if (userData) return path.join(userData, "learned-skills-inbox");
  return path.join(os.tmpdir(), "lily-learned-skills-inbox");
}

function buildSkillMd(spec) {
  const actionRows = spec.actions
    .map((action) => {
      const examples = action.intentExamples.length ? action.intentExamples.join(" / ") : action.name;
      return `| ${escapeMarkdown(action.name)} | ${escapeMarkdown(action.risk)} | ${escapeMarkdown(action.confirmation)} | ${escapeMarkdown(examples)} |`;
    })
    .join("\n");

  const actionDetails = spec.actions
    .map((action) => {
      const steps = action.steps.map((step, idx) => `${idx + 1}. ${step}`).join("\n");
      return [
        `### ${action.name}`,
        "",
        `- id: \`${action.id}\``,
        `- risk: \`${action.risk}\``,
        `- confirmation: \`${action.confirmation}\``,
        action.entry ? `- entry: ${action.entry}` : "",
        "",
        "Steps:",
        "",
        steps,
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");

  const runtimePlanRules = [
    "Allowed operation types are `goto`, `click`, `fill`, `select`, `check`, `uncheck`, `upload`, `press`, `wait`, `waitForUrl`, `waitForText`, `waitForResponse`, `assertText`, `extract`, and `screenshot`.",
    "Prefer robust locator fields in this order: `testId`, `role/name`, `label`, `placeholder`, `text`, then `selector`.",
    "For `select`, use `label` to find the control and `optionLabel` or `value` to choose the option.",
    "Every `goto` and response wait is checked against the allowed domains. A read action may only contain read-risk operations.",
    "If execution returns `LOCATOR_NOT_FOUND`, `ASSERT_TEXT_FAILED`, or `WEB_ACTION_FAILED`, treat the skill as stale: explain the failed operation and re-run learning for this workspace before retrying high-risk actions.",
  ].join("\n\n");

  return `---\nname: ${spec.id}\ndescription: Use when the user asks Lily to operate ${spec.systemName} for the learned actions in this workspace. Requires the existing logged-in browser/session and keeps all write/destructive actions behind confirmation.\n---\n\n# ${spec.name}\n\n${spec.summary}\n\n## Boundaries\n\n- Base URL: ${spec.baseUrl}\n- Allowed domains: ${spec.allowedDomains.map((d) => `\`${d}\``).join(", ")}\n- Never ask for or store passwords, cookies, tokens, or one-time codes.\n- If the session is logged out, ask the user to log in interactively.\n- Do not leave the allowed domains.\n\n## Learned Actions\n\n| Action | Risk | Confirmation | Example triggers |\n|---|---|---|---|\n${actionRows}\n\n## Execution Rules\n\n- For \`read\` actions, return concise source-backed results from the page.\n- For \`prepare\` actions, fill only safe draft fields and stop before submit.\n- For \`submit\` actions, show the final values and ask for user confirmation before submitting.\n- For \`destructive\` actions, require explicit confirmation naming the exact action and target.\n- If labels/selectors no longer match, re-run read-only discovery for the action and explain what changed.\n\n## Runtime Plan Contract\n\nWhen executing an action, create an \`action-plan.json\` with this shape and run the local executor:\n\n\`\`\`bash\nnode scripts/execute_web_playbook.cjs \\\n  --playbook web-system-playbook.json \\\n  --action web.<action-id> \\\n  --plan action-plan.json \\\n  --dry-run\n\`\`\`\n\nOnly run without \`--dry-run\` after the plan validates. For non-read actions, add \`--confirmed\` only after the user has reviewed the exact fields or target.\n\n${runtimePlanRules}\n\n## Action Details\n\n${actionDetails}\n`;
}

function buildManifest(spec) {
  return {
    schemaVersion: 1,
    id: spec.id,
    name: spec.name,
    description: `${spec.systemName} workspace web automation skill generated from a reviewed page/action map.`,
    version: "1.0.0",
    minAppVersion: "0.1.48",
    runtime: "none",
    category: "workspace",
    categoryLabel: "工作区技能",
    publisher: "Workspace",
    origin: "workspace",
    workspaceOnly: true,
    generatedBy: "lily-web-system-learning",
    capabilityLayer: "workflow",
    riskLevel: spec.actions.some((a) => a.risk === "destructive" || a.risk === "submit") ? "high" : "medium",
    permissions: {
      network: true,
      filesystem: "workspace",
      subprocess: "workspace",
    },
  };
}

function buildPlaybook(spec) {
  return {
    schemaVersion: 1,
    id: spec.id,
    name: spec.name,
    description: spec.summary,
    baseUrl: spec.baseUrl,
    allowedDomains: spec.allowedDomains,
    connector: {
      schemaVersion: 1,
      id: `${spec.id}-web`,
      name: `${spec.systemName} Web`,
      kind: "web",
      description: `Browser connector for ${spec.systemName}.`,
      capabilities: ["web.open", "web.extract", "web.prepare", "web.submit"],
      auth: {
        type: "browser-session",
        secretRefs: [],
        scopes: [],
        notes: "User signs in interactively. Credentials, cookies, and tokens are never stored in this playbook.",
      },
      allowRemoteConfig: false,
      metadata: {
        generatedBy: "lily-web-system-learning",
      },
    },
    actions: spec.actions.map((action) => ({
      action: `web.${action.id}`,
      title: action.name,
      connectorKind: "web",
      risk: action.risk,
      confirmation: action.confirmation,
      intentExamples: action.intentExamples,
      steps: action.steps,
      selectors: action.selectors,
      paramsSchema: {},
      resultSchema: {},
      metadata: {
        entry: action.entry || "",
        legacyActionId: action.id,
      },
    })),
    createdAt: new Date().toISOString(),
  };
}

function actionKeywords(action) {
  const source = [action.name, action.entry, ...action.intentExamples, ...action.steps].join(" ");
  return [...new Set(String(source).match(/[\p{Letter}\p{Number}_-]{2,}/gu) || [])].slice(0, 24);
}

function inferBusinessObjects(spec) {
  const objects = new Map();
  for (const action of spec.actions) {
    const entryParts = String(action.entry || "")
      .split(/[>/>｜|,，]/)
      .map((part) => part.trim())
      .filter(Boolean);
    const objectName = entryParts.at(-1) || action.name;
    const key = objectName.toLowerCase();
    const existing = objects.get(key) || {
      id: action.id,
      name: objectName,
      sourceActions: [],
      fields: [],
      riskNotes: [],
    };
    existing.sourceActions.push(`web.${action.id}`);
    existing.fields.push(
      ...action.steps
        .filter((step) => /(field|form|date|keyword|status|amount|reason|字段|表单|日期|关键词|状态|金额|原因)/i.test(step))
        .map((step) => ({ name: step.slice(0, 80), source: "action-step", confidence: "low" })),
    );
    if (action.risk !== "read") existing.riskNotes.push(`${action.name} is ${action.risk} and requires ${action.confirmation}`);
    objects.set(key, existing);
  }
  return [...objects.values()].map((object) => ({
    ...object,
    fields: object.fields.slice(0, 20),
    riskNotes: [...new Set(object.riskNotes)],
  }));
}

function buildSystemProfile(spec, scan) {
  return {
    schemaVersion: 1,
    id: spec.id,
    systemName: spec.systemName,
    displayName: spec.name,
    summary: spec.summary,
    baseUrl: spec.baseUrl,
    allowedDomains: spec.allowedDomains,
    learningState: "draft",
    generatedAt: new Date().toISOString(),
    credentialPolicy: {
      login: "interactive-browser-session",
      chatSecrets: false,
      storedSecrets: false,
      notes: "Users sign in through an interactive browser/profile. Passwords, cookies, tokens, and one-time codes must never be written to chat, logs, prompts, or generated files.",
    },
    supportedCapabilities: [...new Set(spec.actions.map((action) => action.risk))],
    actionCount: spec.actions.length,
    highRiskActionCount: spec.actions.filter((action) => action.risk === "submit" || action.risk === "destructive").length,
    learningCoverage: scan
      ? {
          mode: scan.mode,
          learningMode: scan.learningMode,
          testEnvironment: scan.testEnvironment,
          allowMutatingLearning: scan.allowMutatingLearning,
          pageCount: scan.coverage.pageCount ?? scan.pages.length,
          errorCount: scan.coverage.errorCount ?? 0,
          warningCount: scan.coverage.warningCount ?? scan.warnings.length,
          actionCandidateCount: scan.coverage.actionCandidateCount ?? scan.actionCandidates.length,
          businessObjectCount: scan.coverage.businessObjectCount ?? scan.businessObjects.length,
          formContractCount: scan.pages.reduce((sum, page) => sum + (Array.isArray(page.formContracts) ? page.formContracts.length : 0), 0),
          apiContractCount: scan.coverage.apiContractCount ?? scan.apiContracts.length,
          interactivePageCount: scan.pages.filter((page) => page.source === "interactive-readonly").length,
          fingerprint: scan.coverage.fingerprint || "",
          limitations: scan.coverage.limitations || [],
        }
      : null,
    files: {
      pageMap: "page-map.json",
      domainModel: "domain-model.json",
      actionPlaybook: "web-system-playbook.json",
      riskPolicy: "risk-policy.json",
      examples: "examples.jsonl",
      changeLog: "change-log.json",
      scanArchive: scan ? "web-system-scan.json" : "",
    },
  };
}

function buildPageMap(spec, scan) {
  const scannedPages = scan
    ? scan.pages.map((page) => ({
        id: page.id || `scan-${String(page.url || "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 48)}`,
        title: page.title || page.urlPattern || page.url,
        urlPattern: page.urlPattern || page.url || spec.baseUrl,
        role: page.forms?.length ? "form-or-workflow" : page.tables?.length ? "list-or-report" : "page",
        source: page.source || "scan",
        sourceInteraction: page.sourceInteraction || null,
        confidence: "medium",
        fingerprint: page.fingerprint || "",
        actions: [],
        anchors: {
          headings: (page.headings || []).map((heading) => heading.text).filter(Boolean).slice(0, 12),
          navItems: (page.navItems || []).map((item) => item.text).filter(Boolean).slice(0, 24),
          labels: [
            ...(page.buttons || []).map((button) => button.text),
            ...(page.inputs || []).map((input) => input.label || input.name),
            ...(page.formContracts || []).flatMap((form) => (form.fields || []).map((field) => field.label || field.name)),
            ...(page.tables || []).flatMap((table) => table.headers || []),
          ].filter(Boolean).slice(0, 60),
          selectors: [],
        },
        formContracts: (page.formContracts || []).map((form) => ({
          id: form.id || "",
          label: form.label || "form",
          action: form.action || "",
          method: form.method || "get",
          riskHint: form.riskHint || "read",
          fieldCount: form.fieldCount || 0,
          submitButtons: form.submitButtons || [],
          fields: (form.fields || []).map((field) => ({
            label: field.label || field.name || "",
            type: field.type || "",
            required: Boolean(field.required),
            readonly: Boolean(field.readonly),
            disabled: Boolean(field.disabled),
            options: (field.options || []).slice(0, 40),
          })).slice(0, 80),
          apiContract: form.apiContract || null,
          executionPolicy: form.executionPolicy || {
            learnOnly: true,
            fillDraftAllowed: true,
            canSubmitDuringLearning: false,
            submitRequiresConfirmation: true,
          },
        })).slice(0, 20),
        riskCandidates: (page.actionCandidates || []).map((candidate) => ({
          kind: candidate.kind,
          label: candidate.label,
          riskHint: candidate.riskHint,
        })).slice(0, 40),
      }))
    : [];

  return {
    schemaVersion: 1,
    systemId: spec.id,
    baseUrl: spec.baseUrl,
    allowedDomains: spec.allowedDomains,
    pages: [
      ...scannedPages,
      ...spec.actions.map((action) => ({
        id: action.id,
        title: action.entry || action.name,
        urlPattern: spec.baseUrl,
        role: action.risk === "read" ? "query" : action.risk,
        source: "action-spec",
        confidence: action.entry ? "medium" : "low",
        actions: [`web.${action.id}`],
        anchors: {
          entry: action.entry || "",
          labels: actionKeywords(action),
          selectors: action.selectors || [],
        },
      })),
    ],
    relationships: [
      ...(scan?.siteMap?.edges || []).map((edge) => ({
        from: edge.from,
        to: edge.to,
        via: edge.label || "link",
        risk: "read",
        source: "scan",
      })),
      ...spec.actions.map((action) => ({
        from: "base",
        to: action.id,
        via: action.entry || action.name,
        risk: action.risk,
        source: "action-spec",
      })),
    ],
  };
}

function buildDomainModel(spec, scan) {
  const scanObjects = scan
    ? scan.businessObjects.map((object) => ({
        id: object.id || String(object.name || "scan-object").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        name: object.name || "Scanned object",
        sourceActions: [],
        source: "scan",
        sourceUrl: object.sourceUrl || "",
        fields: Array.isArray(object.fields) ? object.fields.slice(0, 80) : [],
        riskNotes: [],
      }))
    : [];
  return {
    schemaVersion: 1,
    systemId: spec.id,
    objects: [...scanObjects, ...inferBusinessObjects(spec)],
    vocabulary: spec.actions.map((action) => ({
      action: `web.${action.id}`,
      phrases: [...new Set([action.name, ...action.intentExamples])],
      keywords: actionKeywords(action),
    })),
    unresolvedQuestions: [
      "字段含义、状态枚举、权限差异和业务对象关系需要在真实页面扫描后继续补全。",
      "如果页面包含低代码表格、Canvas 或图片按钮，需要补充视觉锚点。",
    ],
  };
}

function buildRiskPolicy(spec, scan) {
  const testLabEnabled = Boolean(scan && scan.learningMode === "test-lab" && scan.allowMutatingLearning);
  const learnedFormPolicies = scan
    ? scan.pages.flatMap((page) =>
        (page.formContracts || []).map((form) => ({
          pageUrl: page.url || "",
          pageTitle: page.title || "",
          formId: form.id || "",
          formLabel: form.label || "form",
          method: form.method || "get",
          riskHint: form.riskHint || "read",
          fieldCount: form.fieldCount || 0,
          submitButtons: form.submitButtons || [],
          apiContract: form.apiContract || null,
          learningPolicy: {
            canInspectFields: true,
            canFillDraft: true,
            canSubmitDuringLearning: Boolean(form.executionPolicy?.canSubmitDuringLearning || testLabEnabled),
            submitRequiresConfirmation: true,
            mode: scan.learningMode || "read-only",
            testEnvironment: scan.testEnvironment || "",
          },
        })),
      )
    : [];
  return {
    schemaVersion: 1,
    systemId: spec.id,
    defaultMode: testLabEnabled ? "test-lab-learning" : "read-only-learning",
    learningMode: scan?.learningMode || "read-only",
    testEnvironment: scan?.testEnvironment || "",
    allowMutatingLearning: testLabEnabled,
    allowedDomains: spec.allowedDomains,
    forbiddenDuringLearning: testLabEnabled
      ? ["permission-change", "credential-export", "outside-domain"]
      : [
          "submit",
          "approve",
          "reject",
          "delete",
          "pay",
          "upload",
          "notify",
          "permission-change",
        ],
    credentialRules: [
      "Never request passwords, cookies, tokens, OAuth codes, or one-time codes in chat.",
      "Never write credentials or login state to generated workspace files.",
      "If login is required, ask the user to complete it in an interactive browser.",
    ],
    actionPolicies: spec.actions.map((action) => ({
      action: `web.${action.id}`,
      risk: action.risk,
      confirmation: action.confirmation,
      canRunDuringLearning: action.risk === "read",
      requiresUserReview: action.confirmation !== "none",
    })),
    learnedFormPolicies,
  };
}

function buildExamplesJsonl(spec) {
  const rows = [];
  for (const action of spec.actions) {
    const examples = action.intentExamples.length ? action.intentExamples : [action.name];
    for (const phrase of examples) {
      rows.push({
        schemaVersion: 1,
        utterance: phrase,
        action: `web.${action.id}`,
        risk: action.risk,
        confirmation: action.confirmation,
      });
    }
  }
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function buildChangeLog(spec, scan) {
  return {
    schemaVersion: 1,
    systemId: spec.id,
    entries: [
      {
        at: new Date().toISOString(),
        type: "initial-draft",
        source: "web-system-spec.json",
        summary: scan
          ? `Generated learned skill from reviewed action spec and read-only scan (${scan.pages.length} pages, ${scan.actionCandidates.length} action candidates).`
          : "Generated system profile, page map, domain model, action playbook, risk policy, examples, and skill draft.",
      },
    ],
  };
}

function main() {
  const args = parseArgs(process.argv);
  const spec = validateSpec(readJson(args.spec));
  const scan = args.scan ? normalizeScan(readJson(args.scan), spec) : null;
  const playbook = buildPlaybook(spec);
  const root = path.resolve(args.out || defaultInboxDir());
  const draftDir = path.join(root, spec.id);
  const result = {
    ok: true,
    id: spec.id,
    outDir: draftDir,
    dryRun: args.dryRun,
    actions: spec.actions.length,
    scannedPages: scan ? scan.pages.length : 0,
    allowedDomains: spec.allowedDomains,
  };

  if (!args.dryRun) {
    fs.mkdirSync(draftDir, { recursive: true });
    fs.mkdirSync(path.join(draftDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(draftDir, "SKILL.md"), buildSkillMd(spec), "utf8");
    fs.writeFileSync(path.join(draftDir, "skill.manifest.json"), JSON.stringify(buildManifest(spec), null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(draftDir, "system-profile.json"), JSON.stringify(buildSystemProfile(spec, scan), null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(draftDir, "page-map.json"), JSON.stringify(buildPageMap(spec, scan), null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(draftDir, "domain-model.json"), JSON.stringify(buildDomainModel(spec, scan), null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(draftDir, "web-system-playbook.json"), JSON.stringify(playbook, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(draftDir, "risk-policy.json"), JSON.stringify(buildRiskPolicy(spec, scan), null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(draftDir, "examples.jsonl"), buildExamplesJsonl(spec), "utf8");
    fs.writeFileSync(path.join(draftDir, "change-log.json"), JSON.stringify(buildChangeLog(spec, scan), null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(draftDir, "web-system-spec.json"), JSON.stringify(spec, null, 2) + "\n", "utf8");
    if (scan) fs.writeFileSync(path.join(draftDir, "web-system-scan.json"), JSON.stringify(scan, null, 2) + "\n", "utf8");
    fs.copyFileSync(path.join(__dirname, "execute_web_playbook.cjs"), path.join(draftDir, "scripts/execute_web_playbook.cjs"));
  }

  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
}
