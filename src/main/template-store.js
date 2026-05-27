"use strict";

/**
 * Persisted quick prompts for one-click chat input.
 * Stored in userData/templates.json.
 */

const fs = require("node:fs");
const path = require("node:path");
const { templatesConfigPath } = require("./config");

const BUILT_IN = [
  {
    id: "daily-help",
    title: "生活小帮手",
    prompt: "我想咨询一个日常生活问题，请用简单易懂的方式回答我：",
    builtIn: true,
  },
  {
    id: "write-email",
    title: "帮我写消息",
    prompt: "请帮我写一段礼貌、清晰的消息，用途是：",
    builtIn: true,
  },
  {
    id: "summarize",
    title: "帮我总结",
    prompt: "请用分点的方式，帮我总结下面这段内容的重点：",
    builtIn: true,
  },
  {
    id: "translate",
    title: "帮我翻译",
    prompt: "请把下面这段文字翻译成英文，语气自然一些：",
    builtIn: true,
  },
  {
    id: "polish-text",
    title: "帮我改改文字",
    prompt: "请帮我润色下面这段文字，让它更通顺、更好读：",
    builtIn: true,
  },
  {
    id: "travel-tips",
    title: "出行建议",
    prompt: "我计划出行，请根据我的情况给出实用建议：",
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
