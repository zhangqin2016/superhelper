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
    "2. 不要让用户把密码、Cookie、Token、OAuth Code、CSRF 值或任何凭据头粘贴到聊天里；如需登录，运行 session 捕获流程，让用户在受控浏览器里自己完成登录，并复用打印出的 sessionPath。",
    "3. 遇到需要登录网站 token 的场景，不要问用户“如何获取 token”；改为重新捕获本地浏览器 session，或通过已登录浏览器流重新学习动态 token / API 合约。",
    "4. 默认只做只读学习：页面结构、菜单、表单字段、列表、详情页、查询条件和业务对象。",
    "5. 先运行扫描脚本的 dry-run，再在域名白名单内扫描；禁止提交表单、删除、审批、支付、上传或修改数据。",
    "6. 学习阶段要产出可复用的能力图谱/执行图谱：API 合约优先；需要浏览器的流程也必须在学习阶段捕获或编译，普通用户执行时禁止临场生成脚本、选择器或操作计划。",
    "7. 遇到 storageState/headless 不可复用、webdriver/UA/TLS/Client-Hints/SSO/二维码/设备绑定等特殊系统时，禁止尝试 stealth、反检测、改 webdriver、改 UA、换原生 Chrome 或临场写 Playwright/Python/JS 脚本绕过。最多一次捕获+一次扫描；仍失败就返回 `SPECIAL_BROWSER_CONTEXT_REQUIRED`，改用同一真人浏览器/profile 采集，或先生成部分草稿并记录缺口。",
    "8. 扫描完成后必须运行 `scripts/finalize_web_system_learning.cjs --scan <scan.json> --contracts <api-contracts.json> --system-id <id> --name <name>`；它会确定性生成 `web-system-spec.json` 并调用 `create_web_system_skill.cjs` 生成当前工作区的 learned skill。",
    "9. 扫描必须以前台 Bash/tool 命令执行并等待完成；禁止使用 `&`、`nohup`、`setsid`、`disown` 或另开后台进程。",
    "10. 只有真实工具还在运行时才可以说“扫描正在运行/等待完成”；如果没有前台工具在跑，必须先执行扫描或说明缺失条件。",
    "11. 不允许以“我将继续扫描/下一步采集/等待分析”作为最终答复。最终答复必须来自 finalizer 的结果：要么 `ok:true` 并说明技能草稿目录、页面/API/能力数量和覆盖缺口；要么给出明确错误和可恢复动作。",
    "12. 输出清晰的学习结果：已识别页面、可支持的自然语言操作、必须二次确认的高风险动作、还需要用户补充的信息。",
    "",
    "如果当前环境缺少 Playwright 或浏览器运行时，不要失败卡住；说明缺少的依赖，并先基于用户提供的页面信息生成可审核草稿。",
  ].filter(Boolean).join("\n");
}

async function ensureWebSystemLearningSkillForSession(ctx, sessionId) {
  const { sessionManager, projectManager, runnerPool } = ctx;
  const skillManager = require("./skill-manager");
  const session = sessionManager.findById(sessionId);
  if (!session) return { ok: false, error: "NO_SESSION" };

  let publicSkills = skillManager.listSkillsForSessionPublic(session);
  let target = publicSkills.skills.find((skill) => skill.id === WEB_SYSTEM_LEARNING_SKILL_ID);

  // This is a heavy, opt-in marketplace skill (defaultEligible:false), so it is
  // not pre-installed. When the user actually expresses learning intent, install
  // it on demand from the registry instead of dead-ending with "not available".
  // Keep it globally disabled afterward (honoring "don't enable by default") and
  // let the per-session selection below turn it on only for this chat.
  if (!target) {
    const installed = await skillManager.installFromRegistry(WEB_SYSTEM_LEARNING_SKILL_ID);
    if (!installed.ok) {
      return { ok: false, error: "SKILL_NOT_AVAILABLE", detail: installed.error || null };
    }
    skillManager.setSkillEnabled(WEB_SYSTEM_LEARNING_SKILL_ID, false);
    publicSkills = skillManager.listSkillsForSessionPublic(session);
    target = publicSkills.skills.find((skill) => skill.id === WEB_SYSTEM_LEARNING_SKILL_ID);
    if (!target) return { ok: false, error: "SKILL_NOT_AVAILABLE" };
  }

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
