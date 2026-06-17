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
    "  node scripts/create_web_system_skill.cjs --spec web-system-spec.json [--out <dir>] [--dry-run]",
    "",
    "The spec must contain id, name/systemName, baseUrl, allowedDomains[], and actions[].",
    "If --out is omitted, the draft is written to Lily's learned-skills inbox.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { spec: null, out: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--spec") {
      args.spec = argv[++i];
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

  return `---\nname: ${spec.id}\ndescription: Use when the user asks Lily to operate ${spec.systemName} for the learned actions in this workspace. Requires the existing logged-in browser/session and keeps all write/destructive actions behind confirmation.\n---\n\n# ${spec.name}\n\n${spec.summary}\n\n## Boundaries\n\n- Base URL: ${spec.baseUrl}\n- Allowed domains: ${spec.allowedDomains.map((d) => `\`${d}\``).join(", ")}\n- Never ask for or store passwords, cookies, tokens, or one-time codes.\n- If the session is logged out, ask the user to log in interactively.\n- Do not leave the allowed domains.\n\n## Learned Actions\n\n| Action | Risk | Confirmation | Example triggers |\n|---|---|---|---|\n${actionRows}\n\n## Execution Rules\n\n- For \`read\` actions, return concise source-backed results from the page.\n- For \`prepare\` actions, fill only safe draft fields and stop before submit.\n- For \`submit\` actions, show the final values and ask for user confirmation before submitting.\n- For \`destructive\` actions, require explicit confirmation naming the exact action and target.\n- If labels/selectors no longer match, re-run read-only discovery for the action and explain what changed.\n\n## Runtime Plan Contract\n\nWhen executing an action, create an \`action-plan.json\` with this shape and run the local executor:\n\n\`\`\`bash\nnode scripts/execute_web_playbook.cjs \\\n  --playbook web-system-playbook.json \\\n  --action web.<action-id> \\\n  --plan action-plan.json \\\n  --dry-run\n\`\`\`\n\nOnly run without \`--dry-run\` after the plan validates. For non-read actions, add \`--confirmed\` only after the user has reviewed the exact fields or target.\n\nAllowed operation types are \`goto\`, \`click\`, \`fill\`, \`press\`, \`wait\`, \`extract\`, and \`screenshot\`. Every \`goto\` URL is checked against the allowed domains. A read action may only contain read-risk operations.\n\n## Action Details\n\n${actionDetails}\n`;
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
    category: "dev",
    categoryLabel: "网页自动化",
    publisher: "Workspace",
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

function main() {
  const args = parseArgs(process.argv);
  const spec = validateSpec(readJson(args.spec));
  const playbook = buildPlaybook(spec);
  const root = path.resolve(args.out || defaultInboxDir());
  const draftDir = path.join(root, spec.id);
  const result = {
    ok: true,
    id: spec.id,
    outDir: draftDir,
    dryRun: args.dryRun,
    actions: spec.actions.length,
    allowedDomains: spec.allowedDomains,
  };

  if (!args.dryRun) {
    fs.mkdirSync(draftDir, { recursive: true });
    fs.mkdirSync(path.join(draftDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(draftDir, "SKILL.md"), buildSkillMd(spec), "utf8");
    fs.writeFileSync(path.join(draftDir, "skill.manifest.json"), JSON.stringify(buildManifest(spec), null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(draftDir, "web-system-playbook.json"), JSON.stringify(playbook, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(draftDir, "web-system-spec.json"), JSON.stringify(spec, null, 2) + "\n", "utf8");
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
