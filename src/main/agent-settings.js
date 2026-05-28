"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT, agentConfigDir } = require("./config");
const { ensureRuntimeNodeShim, resolveRuntimeNodePath } = require("./runtime-node");

const BUNDLED_SKILLS = [
  {
    id: "claude-vision",
    relativePath: "resources/skills/claude-vision",
    placeholders(skillDir) {
      return { "{{VISION_SCRIPT}}": path.join(skillDir, "vision.js") };
    },
  },
  {
    id: "websearch",
    relativePath: "resources/skills/websearch",
    placeholders(skillDir) {
      return { "{{WEBSEARCH_SCRIPT}}": path.join(skillDir, "scripts", "websearch.cjs") };
    },
  },
  {
    id: "webfetch",
    relativePath: "resources/skills/webfetch",
    placeholders(skillDir) {
      return { "{{WEBFETCH_SCRIPT}}": path.join(skillDir, "scripts", "webfetch.cjs") };
    },
  },
];

function bundledResourceCandidates(relativePath) {
  return [
    path.join(process.resourcesPath, relativePath),
    path.join(PROJECT_ROOT, relativePath),
  ].find((p) => fs.existsSync(p));
}

function readBundledFile(relativePath) {
  const found = bundledResourceCandidates(relativePath);
  if (!found) return null;
  return fs.readFileSync(found, "utf8");
}

function copyDirRecursive(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    } else {
      fs.copyFileSync(src, dst);
      if (process.platform !== "win32" && (entry.name.endsWith(".js") || entry.name.endsWith(".cjs"))) {
        fs.chmodSync(dst, 0o755);
      }
    }
  }
}

function applyPlaceholders(content, replacements) {
  let out = content;
  for (const [from, to] of Object.entries(replacements)) {
    out = out.replaceAll(from, to);
  }
  return out;
}

function installBundledSkill(configDir, spec, nodeBin) {
  const skillSource = bundledResourceCandidates(spec.relativePath);
  const skillTarget = path.join(configDir, "skills", spec.id);
  if (!skillSource) {
    return { id: spec.id, installed: false, paths: {} };
  }

  if (fs.existsSync(skillTarget)) {
    fs.rmSync(skillTarget, { recursive: true, force: true });
  }
  copyDirRecursive(skillSource, skillTarget);

  const replacements = {
    ...spec.placeholders(skillTarget),
    "{{NODE_BIN}}": nodeBin,
  };
  const skillMdPath = path.join(skillTarget, "SKILL.md");
  if (fs.existsSync(skillMdPath)) {
    const skillMd = applyPlaceholders(fs.readFileSync(skillMdPath, "utf8"), replacements);
    fs.writeFileSync(skillMdPath, skillMd, "utf8");
  }

  const paths = {};
  for (const [key, value] of Object.entries(replacements)) {
    paths[key.replace(/[{}]/g, "")] = value;
  }
  return { id: spec.id, installed: true, paths };
}

function buildClaudeMd(installed) {
  ensureRuntimeNodeShim();
  const nodeBin = resolveRuntimeNodePath();
  const byId = Object.fromEntries(installed.map((item) => [item.id, item]));

  const visionScript = byId["claude-vision"]?.paths?.VISION_SCRIPT;
  const websearchScript = byId["websearch"]?.paths?.WEBSEARCH_SCRIPT;
  const webfetchScript = byId["webfetch"]?.paths?.WEBFETCH_SCRIPT;

  const sections = ["# 智能工作台全局说明", ""];

  if (visionScript) {
    sections.push(
      "## 识图能力（必读）",
      "",
      "底层模型不具备原生识图能力。Read 工具无法读取图片内容。",
      "遇到图片时，不要用 Read，改用：",
      "",
      "```",
      `"${nodeBin}" "${visionScript}" "<图片绝对路径>" "用中文描述这张图片的内容"`,
      "```",
      "",
      "网络图片：",
      "",
      "```",
      `"${nodeBin}" "${visionScript}" --url "<图片链接>" "用中文描述这张图片的内容"`,
      "```",
      "",
      "对每张图片依次执行，拿到所有文字描述后再回复。",
      "",
    );
  }

  if (websearchScript || webfetchScript) {
    sections.push(
      "## 联网能力（必读）",
      "",
      "内置 WebSearch / WebFetch 在本应用中不可用，不要调用这两个工具。",
      "需要查资料、新闻、实时信息时，用 DuckDuckGo 搜索（无需 API Key）。",
      "",
    );

    if (websearchScript) {
      sections.push(
        "搜索示例：",
        "",
        "```",
        `echo '{"query":"搜索关键词"}' | "${nodeBin}" "${websearchScript}"`,
        "```",
        "",
      );
    }

    if (webfetchScript) {
      sections.push(
        "打开链接并读取正文：",
        "",
        "```",
        `echo '{"url":"https://example.com","prompt":"用户想了解的问题"}' | "${nodeBin}" "${webfetchScript}"`,
        "```",
        "",
        "常见流程：先搜索找到链接，再 webfetch 读具体页面，最后用中文总结并附上来源。",
        "",
      );
    }
  }

  return sections.join("\n").trim() + "\n";
}

function loadSettingsEnv() {
  const settingsPath = path.join(agentConfigDir(), "settings.json");
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return raw?.env && typeof raw.env === "object" ? { ...raw.env } : {};
  } catch {
    return {};
  }
}

function getDefaultDisallowedTools(installedSkills) {
  const ids = new Set(installedSkills.filter((s) => s.installed).map((s) => s.id));
  const blocked = [];
  if (ids.has("websearch")) blocked.push("WebSearch");
  if (ids.has("webfetch")) blocked.push("WebFetch");
  return blocked;
}

function installAgentDefaults() {
  const configDir = agentConfigDir();
  fs.mkdirSync(configDir, { recursive: true });

  const bundledSettings = readBundledFile("resources/agent-defaults/settings.json");
  if (bundledSettings) {
    fs.writeFileSync(path.join(configDir, "settings.json"), bundledSettings, "utf8");
  }

  const installed = BUNDLED_SKILLS.map((spec) =>
    installBundledSkill(configDir, spec, resolveRuntimeNodePath()),
  );
  fs.writeFileSync(path.join(configDir, "CLAUDE.md"), buildClaudeMd(installed), "utf8");

  const vision = installed.find((s) => s.id === "claude-vision");
  const websearch = installed.find((s) => s.id === "websearch");
  const webfetch = installed.find((s) => s.id === "webfetch");

  return {
    settingsInstalled: Boolean(bundledSettings),
    skills: installed,
    runtimeNode: resolveRuntimeNodePath(),
    visionScript: vision?.paths?.VISION_SCRIPT || null,
    websearchScript: websearch?.paths?.WEBSEARCH_SCRIPT || null,
    webfetchScript: webfetch?.paths?.WEBFETCH_SCRIPT || null,
    disallowedTools: getDefaultDisallowedTools(installed),
  };
}

module.exports = {
  loadSettingsEnv,
  installAgentDefaults,
  getDefaultDisallowedTools,
};
