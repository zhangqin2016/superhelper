#!/usr/bin/env node
/**
 * Generate skill catalog i18n files from registry.json + bundled manifests.
 *
 * Usage: node scripts/generate-skill-i18n.mjs
 *
 * Outputs:
 *   src/renderer/i18n/locales/skills/en.json
 *   src/renderer/i18n/locales/skills/zh-CN.json  (from skill-localization/zh-CN.json)
 *   src/renderer/i18n/locales/skills/ar.json       (from skill-localization/ar.json)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(ROOT, "resources/skills-registry/registry.json");
const OUT_DIR = path.join(ROOT, "src/renderer/i18n/locales/skills");
const LOC_DIR = path.join(ROOT, "resources/skills-registry/skill-localization");
const BUNDLED = ["lily-vision", "websearch", "webfetch"];

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readBundledManifest(id) {
  const candidates = [
    path.join(ROOT, "resources/skills", id, "skill.manifest.json"),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return readJson(filePath);
    }
  }
  return null;
}

function collectCatalogSkills() {
  const registry = readJson(REGISTRY, { skills: [] });
  const map = new Map();

  for (const skill of registry.skills || []) {
    map.set(skill.id, {
      id: skill.id,
      name: skill.name,
      description: skill.description || "",
    });
  }

  for (const id of BUNDLED) {
    const manifest = readBundledManifest(id);
    if (!manifest) continue;
    map.set(id, {
      id,
      name: manifest.name,
      description: manifest.description || "",
    });
  }

  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function toSkillLocaleFile(skills, locale, overrides = {}) {
  const out = {};
  for (const skill of skills) {
    const o = overrides[skill.id];
    if (locale === "en") {
      out[skill.id] = { name: skill.name, description: skill.description };
    } else if (o?.name || o?.description) {
      out[skill.id] = {
        name: o.name || skill.name,
        description: o.description || skill.description,
      };
    } else {
      out[skill.id] = { name: skill.name, description: skill.description };
    }
  }
  return out;
}

function main() {
  const skills = collectCatalogSkills();
  const zhOverrides = readJson(path.join(LOC_DIR, "zh-CN.json"), {});
  const arOverrides = readJson(path.join(LOC_DIR, "ar.json"), {});

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(LOC_DIR, { recursive: true });

  const files = {
    "en.json": toSkillLocaleFile(skills, "en"),
    "zh-CN.json": toSkillLocaleFile(skills, "zh-CN", zhOverrides),
    "ar.json": toSkillLocaleFile(skills, "ar", arOverrides),
  };

  for (const [filename, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT_DIR, filename), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  const zhCount = Object.keys(zhOverrides).length;
  const arCount = Object.keys(arOverrides).length;
  console.log(`Wrote ${skills.length} skills to ${OUT_DIR}`);
  console.log(`Localization overrides: zh-CN=${zhCount}, ar=${arCount}`);
}

main();
