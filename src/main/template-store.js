"use strict";

/**
 * Persisted quick command templates for one-click CLI execution.
 * Stored in userData/templates.json.
 */

const fs = require("node:fs");
const path = require("node:path");
const { templatesConfigPath } = require("./config");

const BUILT_IN = [
  {
    id: "code-review",
    title: "代码巡检",
    prompt: "请对当前项目进行全面的代码审查，找出潜在问题并给出改进建议。",
    builtIn: true,
  },
  {
    id: "fix-bug",
    title: "Bug 修复",
    prompt: "请分析以下问题并提供修复方案：",
    builtIn: true,
  },
  {
    id: "refactor",
    title: "代码重构",
    prompt: "请对以下代码进行重构，提升可读性和性能：",
    builtIn: true,
  },
  {
    id: "generate-comments",
    title: "生成注释",
    prompt: "请为以下代码添加清晰的中文注释：",
    builtIn: true,
  },
  {
    id: "generate-tests",
    title: "生成测试用例",
    prompt: "请为以下代码生成完整的测试用例：",
    builtIn: true,
  },
  {
    id: "architecture-doc",
    title: "整理架构文档",
    prompt: "请分析当前项目的整体架构并整理一份架构文档。",
    builtIn: true,
  },
  {
    id: "explain-code",
    title: "代码解释",
    prompt: "请详细解释以下代码的实现逻辑：",
    builtIn: true,
  },
  {
    id: "optimize-perf",
    title: "性能优化",
    prompt: "请分析以下代码的性能瓶颈并提出优化方案：",
    builtIn: true,
  },
];

class TemplateStore {
  constructor() {
    this.custom = [];
  }

  load() {
    try {
      const raw = fs.readFileSync(templatesConfigPath(), "utf8");
      this.custom = JSON.parse(raw);
    } catch {
      this.custom = [];
    }
  }

  save() {
    const dir = path.dirname(templatesConfigPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(templatesConfigPath(), JSON.stringify(this.custom, null, 2));
  }

  listAll() {
    return [...BUILT_IN, ...this.custom.map((t) => ({ ...t, builtIn: false }))];
  }

  add(title, prompt) {
    const template = {
      id: `custom-${Date.now()}`,
      title: title.slice(0, 50),
      prompt,
    };
    this.custom.push(template);
    this.save();
    return template;
  }

  remove(id) {
    this.custom = this.custom.filter((t) => t.id !== id);
    this.save();
  }
}

module.exports = TemplateStore;
