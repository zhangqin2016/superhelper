import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { findSkillRoot } = await import(
  pathToFileURL(path.join(__dirname, "../src/main/skill-root.js")).href
);

function mkdtemp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function writeFile(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const root = mkdtemp("skill-root-test-");

try {
  const flat = path.join(root, "flat");
  writeFile(path.join(flat, "SKILL.md"), "---\nname: flat\n---\n");
  assertEqual(findSkillRoot(flat), flat, "flat layout");

  const wrapped = path.join(root, "wrapped");
  const inner = path.join(wrapped, "my-skill");
  writeFile(path.join(inner, "skill.manifest.json"), '{"schemaVersion":1,"id":"x"}');
  assertEqual(findSkillRoot(wrapped), inner, "single wrapper folder");

  const macosx = path.join(root, "macosx");
  fs.mkdirSync(path.join(macosx, "__MACOSX"), { recursive: true });
  const skillDir = path.join(macosx, "real-skill");
  writeFile(path.join(skillDir, "SKILL.md"), "body");
  assertEqual(findSkillRoot(macosx), skillDir, "ignore __MACOSX sibling");

  const deep = path.join(root, "deep");
  const mid = path.join(deep, "pkg");
  const leaf = path.join(mid, "skill");
  writeFile(path.join(leaf, "SKILL.md"), "deep");
  assertEqual(findSkillRoot(deep), leaf, "double nested folder");

  const empty = path.join(root, "empty");
  fs.mkdirSync(empty, { recursive: true });
  assertEqual(findSkillRoot(empty), null, "empty dir");

  console.log("skill-root: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
