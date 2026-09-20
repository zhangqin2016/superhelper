"use strict";

/**
 * Tells the model which permission mode the user chose.
 *
 * The mode was previously invisible to it: `permissionMode` drove tool
 * auto-approval and runtime identity only, and never reached the prompt. So a
 * user who explicitly selected 全自主 (full autonomy) still got turns that
 * ended by handing the decision back — "要我接着做前端还是先跑全量测试?" —
 * and, worse, ended that way while the model's own task list still had
 * unfinished items. Auto-approving its tools does not help if it stops to ask.
 *
 * Only "full" gets a directive. "ask" and "plan" already describe a session
 * where the user wants to be consulted, and the base rules cover those, so
 * they get nothing added and behave exactly as before.
 *
 * This rides the per-prompt guidance rather than the cached AGENT.md because
 * the mode is per session and can change mid-conversation, while the guide is
 * cached against the enabled-skill signature.
 */

const AUTONOMY_I18N = {
  "zh-CN": {
    title: "本轮自主级别（用户已选择“全自主”）",
    rules: [
      "**先确认输入边界**：全自主授权你决定执行方法，不授权你猜测用户指的是哪个文件。缺少必要附件、来源身份不明确时，询问用户或等待上传；不要把工作区中碰巧存在的旧文件当成附件。用户要求等待或停止某部分时，更新任务范围，不得为了完成旧清单继续执行或自行删除已有成果。",
      "**决定权在你**：本轮不要把选择权交回给用户。遇到可逆的岔路，自己选最合理的一条，用一句话写明你的假设和理由，然后继续做完。",
      "**不要以提问结束**：不要用“要我做 A 还是 B？”这类句子结束回复。设计粒度、执行顺序、先跑哪一步这类问题都属于可逆歧义，你自己定。",
      "**清单没做完就别停**：只要你自己列出的任务清单还有未完成项，就继续做，不要在中途停下来征询。",
      "**需要询问的例外**：必要输入缺失或身份不明、不问就可能造成不可逆损失（删数据、对外发布、花钱、动生产），或者答案错了整个产出必然作废。仅继续不依赖该输入且仍在用户范围内的工作，再用一个最关键的问题收尾。",
      "**把假设写清**：所有自己拍的决定集中列出来，说明改法，让用户事后能一眼推翻。这替代了事前提问。",
    ],
  },
  en: {
    title: "Autonomy level for this turn (the user selected full autonomy)",
    rules: [
      "**Respect input identity first**: full autonomy authorizes execution choices, not guessing which source the user meant. Ask or wait when a necessary attachment is missing or source identity is unresolved; an existing workspace file is not automatically an attachment. A user request to wait or stop revises scope: do not continue an obsolete checklist or delete existing outputs on that basis.",
      "**You decide**: do not hand the choice back this turn. At a reversible fork, pick the most reasonable branch, state your assumption and reason in one line, and carry on to completion.",
      "**Do not end on a question**: never close with \"should I do A or B?\". Design granularity, execution order, and which step to run first are all reversible ambiguity — settle them yourself.",
      "**Do not stop with your own list unfinished**: while the task list you wrote still has open items, keep going instead of pausing to consult.",
      "**When to ask**: a necessary input is missing or unidentified, not asking risks irreversible loss (deleting data, publishing outward, spending money, touching production), or a wrong answer voids the output. Continue only independent work still within the user's scope, then ask the single most critical question.",
      "**Make assumptions explicit**: list the calls you made and how to change them, so the user can overturn any of them afterwards. That replaces asking beforehand.",
    ],
  },
  ar: {
    title: "مستوى الاستقلالية لهذه الجولة (اختار المستخدم الاستقلال الكامل)",
    rules: [
      "**تحقق من هوية المدخلات أولاً**: الاستقلال الكامل يجيز اختيار طريقة التنفيذ، لا تخمين الملف المقصود. اطلب المرفق الضروري المفقود أو انتظر رفعه؛ لا تعتبر ملفاً قديماً في مساحة العمل مرفقاً تلقائياً. طلب المستخدم الانتظار أو التوقف يعدل نطاق العمل، ولا يجيز متابعة قائمة قديمة أو حذف المخرجات الموجودة.",
      "**القرار لك**: لا تُعِد الاختيار إلى المستخدم في هذه الجولة. عند تشعّب قابل للعكس، اختر الفرع الأنسب واذكر افتراضك وسببه في سطر واحد، ثم أكمل العمل.",
      "**لا تنتهِ بسؤال**: لا تُنهِ ردّك بعبارة مثل \"هل أفعل أ أم ب؟\". تفاصيل التصميم وترتيب التنفيذ وأي خطوة تبدأ بها كلها غموض قابل للعكس، فاحسمها بنفسك.",
      "**لا تتوقف وقائمتك غير مكتملة**: ما دامت قائمة المهام التي كتبتها تحتوي بنوداً مفتوحة، فتابع بدلاً من التوقف للاستشارة.",
      "**متى تسأل**: عند غياب مدخل ضروري أو عدم وضوح هويته، أو خطر خسارة لا رجعة فيها، أو احتمال إبطال النتيجة. تابع فقط العمل المستقل الذي لا يزال ضمن نطاق طلب المستخدم، ثم اطرح السؤال الأهم.",
      "**اذكر الافتراضات صراحةً**: اسرد القرارات التي اتخذتها وكيفية تغييرها ليتمكن المستخدم من نقضها لاحقاً. هذا بديل السؤال المسبق.",
    ],
  },
};

/** Locales fall back to English, never to Chinese, matching the guide. */
function resolveLocale(locale) {
  const tag = String(locale || "").trim();
  if (AUTONOMY_I18N[tag]) return tag;
  const base = tag.split(/[-_]/)[0];
  if (base === "zh") return "zh-CN";
  if (AUTONOMY_I18N[base]) return base;
  return "en";
}

/**
 * The guidance block for a permission mode, or "" when the mode needs none.
 * An unknown mode returns "" so a new mode cannot accidentally inherit
 * full-autonomy instructions.
 *
 * @param {string} mode "plan" | "ask" | "full"
 * @param {string} locale
 * @returns {string}
 */
function buildAutonomyGuidance(mode, locale) {
  if (String(mode || "").trim() !== "full") return "";
  const copy = AUTONOMY_I18N[resolveLocale(locale)];
  return [`## ${copy.title}`, "", ...copy.rules.map((rule) => `- ${rule}`)].join("\n");
}

module.exports = { buildAutonomyGuidance, AUTONOMY_I18N };
