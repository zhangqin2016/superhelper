"use strict";

const { engineNotice } = require("../../shared/engine-notices.mjs");

/**
 * Durable, in-conversation record of an agent binding change.
 *
 * Before 2026-09-15 activating an agent produced only a toast and a chip: the
 * conversation itself never showed where an agent took over, what it brought
 * (role, skills, knowledge, autonomy) or that it was later removed. This
 * commits one platform message per binding version, mirrored as a committed
 * message event so the open renderer shows it immediately. Never replaces or
 * masquerades as an assistant answer. Fail-open.
 *
 * Renderer contract: message.role === "assistant", message.meta.agentBinding =
 *   { kind: "activated" | "deactivated" | "replaced_by_role", agentId, name,
 *     icon, bindingVersion, dimensions[], degraded[{dimension, reason}],
 *     skills[], knowledgePacks[], autonomy, model, roleName, keepsEngine }
 * delivered via engine.notice (source "agent_binding", notice.code
 * "agentBindingChanged", committedMessage).
 */

const crypto = require("node:crypto");

const KINDS = new Set(["activated", "deactivated", "replaced_by_role"]);

const COPY = {
  "zh-CN": {
    activated: (n) => `已切换到智能体「${n}」`,
    deactivated: (n) => `已移除智能体「${n}」，恢复为之前的设置`,
    replaced_by_role: (n, role) => `已改选角色「${role}」，智能体「${n}」随之停用`,
    brings: "本对话从下一条消息开始按它工作，包含：",
    role: "角色", skills: "技能", knowledge: "知识库", autonomy: "执行模式", model: "模型", tools: "工具",
    degraded: "未生效", keeps: "当前对话的上下文会继续保留。",
    autonomyLabels: { plan: "仅规划", ask: "确认后执行", full: "全自主", inherit: "沿用当前设置" },
  },
  en: {
    activated: (n) => `Switched to agent "${n}"`,
    deactivated: (n) => `Agent "${n}" removed; previous settings restored`,
    replaced_by_role: (n, role) => `Role "${role}" selected; agent "${n}" deactivated`,
    brings: "From the next message this conversation works as this agent, which brings:",
    role: "Role", skills: "Skills", knowledge: "Knowledge", autonomy: "Mode", model: "Model", tools: "Tools",
    degraded: "not applied", keeps: "The conversation keeps its context.",
    autonomyLabels: { plan: "plan only", ask: "confirm before acting", full: "autonomous", inherit: "inherited" },
  },
  ar: {
    activated: (n) => `تم التبديل إلى الوكيل «${n}»`,
    deactivated: (n) => `تمت إزالة الوكيل «${n}» واستعادة الإعدادات السابقة`,
    replaced_by_role: (n, role) => `تم اختيار الدور «${role}»؛ تم إيقاف الوكيل «${n}»`,
    brings: "من الرسالة التالية تعمل هذه المحادثة بهذا الوكيل، ويتضمن:",
    role: "الدور", skills: "المهارات", knowledge: "المعرفة", autonomy: "الوضع", model: "النموذج", tools: "الأدوات",
    degraded: "غير مفعّل", keeps: "تحتفظ المحادثة بسياقها.",
    autonomyLabels: { plan: "تخطيط فقط", ask: "تأكيد قبل التنفيذ", full: "مستقل", inherit: "موروث" },
  },
};

function clip(value, limit = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function summarizeBinding(definition = {}, receipt = {}) {
  const skills = [...new Set([...(definition.skills?.required || []), ...(definition.skills?.enabled || [])])].map(String);
  return {
    dimensions: Array.isArray(receipt.dimensions) ? receipt.dimensions.slice() : [],
    degraded: Array.isArray(receipt.degraded) ? receipt.degraded.map((d) => ({ dimension: String(d.dimension || ""), reason: String(d.reason || "") })) : [],
    skills,
    knowledgePacks: (definition.knowledge?.packs || []).map(String),
    autonomy: String(definition.autonomy?.permissionModeId || "inherit"),
    model: definition.model?.presetId ? String(definition.model.presetId) : null,
    tools: [...(definition.tools?.mcpAllow || []), ...(definition.tools?.connectors || [])].map(String),
  };
}

function renderContent(copy, kind, agent, summary, roleName) {
  const lines = [kind === "replaced_by_role" ? copy.replaced_by_role(agent.name, roleName || "") : copy[kind](agent.name)];
  if (kind === "activated") {
    lines.push("", copy.brings);
    const degraded = new Set(summary.degraded.map((d) => d.dimension));
    const mark = (dimension) => (degraded.has(dimension) ? `（${copy.degraded}）` : "");
    if (summary.dimensions.includes("role")) lines.push(`- ${copy.role}：${clip(roleName || agent.name)}${mark("role")}`);
    if (summary.skills.length) lines.push(`- ${copy.skills}：${summary.skills.map((s) => clip(s, 40)).join("、")}${mark("skills")}`);
    if (summary.knowledgePacks.length) lines.push(`- ${copy.knowledge}：${summary.knowledgePacks.join("、")}${mark("knowledge")}`);
    if (summary.autonomy && summary.autonomy !== "inherit") lines.push(`- ${copy.autonomy}：${copy.autonomyLabels[summary.autonomy] || summary.autonomy}${mark("autonomy")}`);
    if (summary.model) lines.push(`- ${copy.model}：${summary.model}${mark("model")}`);
    if (summary.tools.length) lines.push(`- ${copy.tools}：${summary.tools.join("、")}${mark("tools")}`);
    lines.push("", copy.keeps);
  }
  return lines.join("\n");
}

/**
 * @param {object} ctx { sessionManager, eventBus }
 * @param {string} sessionId
 * @param {{ kind:string, agent:{id:string,name:string,icon?:string}, definition?:object, receipt?:object,
 *   bindingVersion:number, roleName?:string, locale?:string }} input
 */
function commitAgentBindingNotice(ctx, sessionId, input = {}) {
  try {
    if (process.env.LILY_AGENT_BINDING_NOTICE === "0") return { ok: true, skipped: "disabled" };
    const { kind, agent, bindingVersion } = input;
    // An explicit allowlist: COPY also holds label keys ("brings", "role", …),
    // and any of those passed the old lookup and then threw inside renderContent.
    if (!sessionId || !agent?.name || !KINDS.has(kind) || !Number.isInteger(bindingVersion)) return { ok: true, skipped: "not_applicable" };
    const manager = ctx?.sessionManager;
    if (typeof manager?.findMessage !== "function" || typeof manager?.pushMessageTo !== "function") return { ok: false, skipped: "manager_unavailable" };
    const locale = COPY[input.locale] ? input.locale : (COPY[String(input.locale || "").slice(0, 2)] ? String(input.locale).slice(0, 2) : "zh-CN");
    const copy = COPY[locale];
    const summary = summarizeBinding(input.definition || {}, input.receipt || {});
    const digest = crypto.createHash("sha256").update(`${sessionId}|${bindingVersion}|${kind}`).digest("hex");
    const id = `msg_agent_binding_${digest}`;
    let message = manager.findMessage(sessionId, id);
    if (!message) {
      manager.pushMessageTo(sessionId, "assistant", renderContent(copy, kind, agent, summary, input.roleName), null, {
        id,
        turnId: `turn_agent_binding_${digest}`,
        meta: {
          agentBinding: {
            kind, agentId: String(agent.id || ""), name: String(agent.name), icon: String(agent.icon || ""), bindingVersion,
            ...summary, roleName: String(input.roleName || ""), keepsEngine: true,
          },
        },
      });
      message = manager.findMessage(sessionId, id);
      if (!message) return { ok: false, skipped: "not_persisted" };
    }
    if (typeof ctx?.eventBus?.emit === "function") {
      ctx.eventBus.emit(sessionId, {
        type: "engine.notice", turnId: null, source: "agent_binding",
        payload: { notice: engineNotice("agentBindingChanged"), committedMessage: message },
      });
    }
    return { ok: true, message };
  } catch {
    return { ok: false, skipped: "error" };
  }
}

module.exports = { commitAgentBindingNotice, summarizeBinding };
