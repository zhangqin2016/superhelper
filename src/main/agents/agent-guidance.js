"use strict";

/**
 * Agent guidance — the HOT-path delivery of an agent's capability intent.
 *
 * Rendered as one bounded section appended to the per-session AGENT.md (so it
 * rides `body.system` on every prompt and applies on the next message). It
 * carries what the host cannot enforce mechanically but the model should
 * know: the agent's mission, its knowledge guidance, which knowledge packs
 * and tools it should prefer. It never carries the role narrative (that is
 * the character context, a separate lower-authority suffix) and never
 * overrides platform rules — it sits after them, like learned conventions.
 */

const { knowledgePackLabel } = require("./knowledge-packs");

const MAX_SECTION_CHARS = 6000;

const COPY = Object.freeze({
  "zh-CN": {
    title: (name) => `当前智能体：${name}`,
    mission: "使命",
    guidance: "工作方法（智能体作者设定，须遵循）",
    packs: "已配置知识库（回答相关问题前先检索）",
    tools: "优先使用的工具与连接器",
    connectors: "已授权的连接器",
    skills: "本智能体依赖的技能",
    autonomy: (mode) => `自主度：${mode === "plan" ? "仅规划，不改动文件" : mode === "full" ? "全自主执行" : "执行前确认高风险操作"}`,
    truncated: "…（已截断）",
  },
  en: {
    title: (name) => `Active agent: ${name}`,
    mission: "Mission",
    guidance: "Working method (set by the agent author — follow it)",
    packs: "Configured knowledge packs (search before answering related questions)",
    tools: "Preferred tools and connectors",
    connectors: "Authorized connectors",
    skills: "Skills this agent relies on",
    autonomy: (mode) => `Autonomy: ${mode === "plan" ? "plan only, no file changes" : mode === "full" ? "fully autonomous" : "confirm risky actions before executing"}`,
    truncated: "… (truncated)",
  },
  ar: {
    title: (name) => `الوكيل النشط: ${name}`,
    mission: "المهمة",
    guidance: "طريقة العمل (حددها مؤلف الوكيل — اتبعها)",
    packs: "حزم المعرفة المُعدّة (ابحث فيها قبل الإجابة)",
    tools: "الأدوات والموصلات المفضلة",
    connectors: "الموصلات المصرح بها",
    skills: "المهارات التي يعتمد عليها هذا الوكيل",
    autonomy: (mode) => `الاستقلالية: ${mode === "plan" ? "تخطيط فقط" : mode === "full" ? "تنفيذ مستقل" : "تأكيد الإجراءات الحساسة"}`,
    truncated: "… (مقتطع)",
  },
});

function localeKey(locale) {
  const value = String(locale || "").toLowerCase();
  if (value.startsWith("zh")) return "zh-CN";
  if (value.startsWith("ar")) return "ar";
  return "en";
}

function clip(text, copy) {
  const value = String(text || "");
  if (value.length <= MAX_SECTION_CHARS) return value;
  return `${value.slice(0, MAX_SECTION_CHARS)}\n${copy.truncated}\n`;
}

/**
 * @param {object} definition normalized agent definition
 * @param {string} locale app locale
 * @returns {string} markdown section ("" when the definition adds nothing)
 */
function buildAgentGuidanceSection(definition, locale = "zh-CN") {
  if (!definition || typeof definition !== "object") return "";
  const copy = COPY[localeKey(locale)];
  const lines = [`\n## ${copy.title(definition.name)}\n`];
  if (definition.description) lines.push(`**${copy.mission}**：${definition.description}\n`);
  if (definition.knowledge?.guidance) lines.push(`### ${copy.guidance}\n${definition.knowledge.guidance}\n`);
  if (definition.knowledge?.packs?.length) {
    lines.push(`### ${copy.packs}\n${definition.knowledge.packs.map((id) => `- ${knowledgePackLabel(id, localeKey(locale))} (${id})`).join("\n")}\n`);
  }
  if (definition.tools?.mcpAllow?.length) {
    lines.push(`### ${copy.tools}\n${definition.tools.mcpAllow.map((name) => `- ${name}`).join("\n")}\n`);
  }
  if (definition.tools?.connectors?.length) {
    lines.push(`### ${copy.connectors}\n${definition.tools.connectors.map((name) => `- ${name}`).join("\n")}\n`);
  }
  if (definition.skills?.required?.length) {
    lines.push(`### ${copy.skills}\n${definition.skills.required.map((id) => `- ${id}`).join("\n")}\n`);
  }
  if (definition.autonomy?.permissionModeId && definition.autonomy.permissionModeId !== "inherit") {
    lines.push(`${copy.autonomy(definition.autonomy.permissionModeId)}\n`);
  }
  return clip(lines.join("\n"), copy);
}

module.exports = { buildAgentGuidanceSection, MAX_SECTION_CHARS };
