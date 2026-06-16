"use strict";

const WEB_SYSTEM_LEARNING_SKILL_ID = "lily-web-system-learning";

const WEB_SYSTEM_WORDS =
  /(OA|ERP|CRM|后台|管理系统|网页系统|web\s*系统|业务系统|内部系统|门户|网站|Web\s*app|admin\s*(?:portal|system|panel)|dashboard|portal|web\s*system)/i;
const LEARNING_ACTION_WORDS =
  /(学习|熟悉|接入|自动化|自动操作|帮我操作|操作一下|以后.*操作|生成.*技能|创建.*技能|learn|study|automate|operate|control|connect|teach)/i;
const GENERIC_LEARNING_ONLY =
  /^(?:学习|学一下|帮我学习|learn|study)\s*(?:英语|英文|中文|数学|物理|历史|语法|单词|课程|考试|编程|代码)?$/i;

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function extractUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s)）"'<>]+/i);
  return match ? match[0] : "";
}

function looksLikeWebSystemLearningIntent(text, files = []) {
  if (Array.isArray(files) && files.length > 0) return false;
  const source = normalizeText(text);
  if (!source || source.length > 1500) return false;
  if (GENERIC_LEARNING_ONLY.test(source)) return false;
  if (extractUrl(source) && LEARNING_ACTION_WORDS.test(source)) return true;
  return WEB_SYSTEM_WORDS.test(source) && LEARNING_ACTION_WORDS.test(source);
}

function buildWebSystemLearningPrompt(userText) {
  const source = normalizeText(userText);
  const url = extractUrl(source);
  const urlLine = url ? `\n用户提到的入口地址：${url}\n` : "";
  return [
    "用户希望你学习一个 Web / OA / ERP / CRM / 后台系统，并为当前工作区生成可审核、可复用的操作技能。",
    "",
    "原始需求：",
    source,
    urlLine.trimEnd(),
    "",
    "请严格使用 `lily-web-system-learning` 技能流程处理：",
    "1. 先确认系统入口 URL、允许访问的域名范围、业务目标和只读/写入边界；信息不足时只问缺失项。",
    "2. 不要让用户把密码、Cookie、Token 粘贴到聊天里；如需登录，让用户在浏览器里自己完成登录。",
    "3. 默认只做只读学习：页面结构、菜单、表单字段、列表、详情页、查询条件和业务对象。",
    "4. 先运行扫描脚本的 dry-run，再在域名白名单内扫描；禁止提交表单、删除、审批、支付、上传或修改数据。",
    "5. 学习完成后生成 `web-system-spec.json`，再调用 `scripts/create_web_system_skill.cjs` 生成当前工作区的 learned skill 草稿。",
    "6. 输出清晰的学习结果：已识别页面、可支持的自然语言操作、必须二次确认的高风险动作、还需要用户补充的信息。",
    "",
    "如果当前环境缺少 Playwright 或浏览器运行时，不要失败卡住；说明缺少的依赖，并先基于用户提供的页面信息生成可审核草稿。",
  ].filter(Boolean).join("\n");
}

function ensureWebSystemLearningSkillForSession(ctx, sessionId) {
  const { sessionManager, projectManager, runnerPool } = ctx;
  const skillManager = require("./skill-manager");
  const session = sessionManager.findById(sessionId);
  if (!session) return { ok: false, error: "NO_SESSION" };

  const publicSkills = skillManager.listSkillsForSessionPublic(session);
  const target = publicSkills.skills.find((skill) => skill.id === WEB_SYSTEM_LEARNING_SKILL_ID);
  if (!target) return { ok: false, error: "SKILL_NOT_AVAILABLE" };
  if (target.sessionEnabled) return { ok: true, changed: false };

  const nextIds = [...new Set([...(publicSkills.effectiveIds || []), WEB_SYSTEM_LEARNING_SKILL_ID])];
  const normalized = skillManager.normalizeSessionSkillSelection(nextIds);
  if (!sessionManager.setEnabledSkillIds(sessionId, normalized)) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const updated = sessionManager.findById(sessionId);
  const project = projectManager.find(updated?.projectId);
  skillManager.writeSessionAgentGuide(sessionId, updated, project?.path || "");

  const runner = runnerPool.get(sessionId);
  if (runner?.isAlive?.() && !runner.isBusy?.()) {
    if (!runner.reloadSkills()) runnerPool.terminateSession(sessionId);
  }

  return { ok: true, changed: true, needsReloadBeforeNextTurn: Boolean(runner?.isBusy?.()) };
}

module.exports = {
  WEB_SYSTEM_LEARNING_SKILL_ID,
  looksLikeWebSystemLearningIntent,
  buildWebSystemLearningPrompt,
  ensureWebSystemLearningSkillForSession,
};
