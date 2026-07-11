#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { skillContentRevision, skillDirectoryFiles, registryRevision } = require("../src/main/skill-registry-revision.js");

function parseArgs(argv) {
  const args = { root: PROJECT_ROOT, check: false, touch: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.root = path.resolve(argv[++index]);
    else if (arg === "--check") args.check = true;
    else if (arg === "--touch") args.touch = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function stampedRegistry(root, registry) {
  const next = JSON.parse(JSON.stringify(registry));
  for (const skill of next.skills || []) {
    const skillDir = path.join(root, "resources", "skills-catalog", skill.id);
    const skillPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Registered skill is missing SKILL.md: ${skill.id}`);
    }
    const manifestPath = path.join(skillDir, "skill.manifest.json");
    const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
    skill.contentRevision = skillContentRevision(skill, {
      skillMarkdown: fs.readFileSync(skillPath, "utf8"),
      manifest,
      files: skillDirectoryFiles(skillDir),
    });
  }
  next.registryRevision = registryRevision(next);
  return next;
}

const args = parseArgs(process.argv);
const registryPath = path.join(args.root, "resources", "skills-registry", "registry.json");
const current = readJson(registryPath);
const next = stampedRegistry(args.root, current);

if (args.check) {
  const mismatchedSkills = next.skills
    .filter((skill, index) => skill.contentRevision !== current.skills?.[index]?.contentRevision)
    .map((skill) => skill.id);
  if (mismatchedSkills.length || next.registryRevision !== current.registryRevision) {
    console.error(`Skill registry revisions are stale: ${mismatchedSkills.join(", ") || "registry metadata"}`);
    process.exit(1);
  }
  console.log(`skill-registry-revision: ok (${next.skills.length} skills)`);
  process.exit(0);
}

if (args.touch) next.updatedAt = new Date().toISOString();
fs.writeFileSync(registryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
console.log(`Stamped ${next.skills.length} skill revisions in ${registryPath}`);
