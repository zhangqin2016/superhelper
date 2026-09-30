import { getLocale } from "./i18n.mjs";

/**
 * Operator-facing messages from admin write actions.
 *
 * They were 28 English string literals inside actions.js, in a console that
 * ships in three languages: a Chinese operator saved a config rule and was
 * answered in English. Keeping them here makes the set enumerable — a gate can
 * check that every key is translated, which it cannot do for a literal.
 *
 * Arabic inherits English exactly as the rest of the admin dictionary does
 * today; that is the console's existing state, not a new gap.
 */
const MESSAGES = {
  licenseInvalidExpiry: {
    zh: "到期日期不正确。",
    en: "Invalid expiration date.",
  },
  licenseCreated: {
    zh: "授权已创建。请立刻复制，明文密钥只显示这一次。",
    en: "License created. Copy it now; the plain key is shown only once.",
  },
  licenseFailed: { zh: "创建授权失败。", en: "Failed to create license." },
  releaseCreated: { zh: "发布记录 {id} 已创建。", en: "Release {id} created." },
  releaseFailed: { zh: "创建发布记录失败。", en: "Failed to create release." },
  skillUploaded: { zh: "技能包 {id} 已上传。", en: "Skill package {id} uploaded." },
  skillFailed: { zh: "上传技能包失败。", en: "Failed to upload skill package." },
  appUploaded: { zh: "工作区应用 {id} 已上传。", en: "Workspace app {id} uploaded." },
  appFailed: { zh: "上传工作区应用失败。", en: "Failed to upload workspace app." },
  configNotObject: { zh: "配置必须是一个 JSON 对象。", en: "Config must be a JSON object." },
  configProfileSaved: { zh: "下发规则 {id} 已保存。", en: "Config profile {id} saved." },
  configProfileFailed: { zh: "保存下发规则失败。", en: "Failed to save config profile." },
  providerSaved: { zh: "模型供应商 {id} 已保存。", en: "Provider {id} saved." },
  providerFailed: { zh: "保存模型供应商失败。", en: "Failed to save provider." },
  groupSaved: { zh: "设备组 {id} 已保存。", en: "Group {id} saved." },
  groupFailed: { zh: "保存设备组失败。", en: "Failed to save group." },
  membershipUpdated: { zh: "归属已更新。", en: "Membership updated." },
  membershipFailed: { zh: "更新归属失败。", en: "Failed to update membership." },
  agentDefinitionRequired: { zh: "需要填写智能体定义 JSON。", en: "Definition JSON is required." },
  agentSaved: { zh: "智能体 {id} 已{action}。", en: "Agent package {id} {action}." },
  agentFailed: { zh: "保存智能体失败。", en: "Failed to save agent package." },
  wishUpdated: { zh: "愿望已更新。", en: "Wish updated." },
  wishFailed: { zh: "更新愿望失败。", en: "Failed to update wish." },
  wishMerged: { zh: "愿望已合并。", en: "Wish merged." },
  wishMergeFailed: { zh: "合并愿望失败。", en: "Failed to merge wish." },
  loginMissingCredentials: { zh: "请填写邮箱和密码。", en: "Email and password are required." },
  loginRejected: { zh: "登录失败，请检查邮箱和密码。", en: "Login failed. Check the email and password." },
  loginNoSession: { zh: "登录成功，但服务端没有返回管理会话。", en: "Login succeeded but no admin session was returned." },
  // Enterprise governance (web/app/admin/enterprise/actions.js). These carry
  // Arabic too: the enterprise pages are translated end to end.
  enterpriseNameRequired: { zh: "请填写企业名称（1–120 个字）。", en: "Enter the organization's name (1–120 characters).", ar: "أدخل اسم المؤسسة (من 1 إلى 120 حرفًا)." },
  enterpriseOwnerPhoneRequired: { zh: "请填写所有者的手机号，或改为“平台签发一个新账号”。", en: "Enter the owner's phone number, or choose “Issue a new account”.", ar: "أدخل رقم هاتف المالك، أو اختر «إصدار حساب جديد»." },
  enterpriseCreatedIssued: { zh: "企业「{name}」已创建。所有者的初始密码在下方，只显示这一次。", en: "“{name}” is created. The owner's initial password is below — it is shown only this once.", ar: "تم إنشاء «{name}». كلمة مرور المالك الأولية أدناه — تظهر هذه المرة فقط." },
  enterpriseFreezeReasonRequired: { zh: "冻结前请填写原因，它会记入变更历史。", en: "Enter a reason before freezing — it goes into the history.", ar: "أدخل سببًا قبل التجميد — سيُسجَّل في السجل." },
  enterpriseFrozen: { zh: "已冻结。全体成员现在无法使用企业额度池。", en: "Frozen. Members can no longer use the organization's pool.", ar: "تم التجميد. لم يعد بإمكان الأعضاء استخدام رصيد المؤسسة." },
  enterpriseUnfrozen: { zh: "已解除平台冻结。", en: "The platform freeze is lifted.", ar: "رُفع تجميد المنصة." },
  enterpriseRenamed: { zh: "企业名称已改为「{name}」。", en: "Renamed to “{name}”.", ar: "تمت إعادة التسمية إلى «{name}»." },
  enterpriseBudgetSaved: { zh: "成员默认每周额度已设为 {units}。", en: "The default weekly budget is now {units}.", ar: "أصبحت الميزانية الأسبوعية الافتراضية {units}." },
  enterpriseBudgetCleared: { zh: "成员默认每周额度已改为不限。", en: "The default weekly budget is now unlimited.", ar: "أصبحت الميزانية الأسبوعية الافتراضية غير محدودة." },
  enterpriseGrantInvalidUnits: { zh: "数量必须是 1 到 1,000,000,000 之间的整数。", en: "The amount must be a whole number from 1 to 1,000,000,000.", ar: "يجب أن تكون الكمية عددًا صحيحًا من 1 إلى 1,000,000,000." },
  enterpriseGrantInvalidDays: { zh: "有效期必须是 1 到 3650 天之间的整数。", en: "The validity must be a whole number of days from 1 to 3650.", ar: "يجب أن تكون الصلاحية عددًا صحيحًا من الأيام بين 1 و3650." },
  enterpriseGranted: { zh: "已调拨 {amount}，{days} 天后到期。", en: "Granted {amount}, expiring in {days} days.", ar: "تم منح {amount}، وتنتهي بعد {days} يومًا." },
  enterpriseGrantIdempotent: { zh: "这次提交和上一次是同一笔，没有重复调拨（{amount}）。", en: "This was the same submission as before — nothing was granted twice ({amount}).", ar: "كان هذا الإرسال نفسه السابق — لم يُمنح شيء مرتين ({amount})." },
  enterpriseReduceInvalidUnits: { zh: "扣回数量必须是大于 0 的整数。", en: "The amount to take back must be a whole number above 0.", ar: "يجب أن تكون الكمية المستعادة عددًا صحيحًا أكبر من 0." },
  enterpriseReduceReasonRequired: { zh: "请填写原因，它会记入变更历史。", en: "Enter a reason — it goes into the history.", ar: "أدخل سببًا — سيُسجَّل في السجل." },
  enterpriseReduced: { zh: "已扣回 {units}。", en: "Took back {units}.", ar: "تمت استعادة {units}." },
  enterpriseRevoked: { zh: "已撤销，收回剩余 {units}。", en: "Revoked; {units} taken back.", ar: "أُلغيت؛ واستُعيد {units}." },
  enterpriseOwnerPasswordReissued: { zh: "已重新签发所有者初始密码，旧的初始密码已失效。请现在复制并交给所有者。", en: "A new initial password is issued and the old one no longer works. Copy it now and hand it to the owner.", ar: "صدرت كلمة مرور أولية جديدة ولم تعد القديمة تعمل. انسخها الآن وسلّمها للمالك." },
  // Billing products and plans (web/app/admin/billing/actions.js), all three languages.
  billingProductIdRequired: { zh: "请填写商品 ID（至少 2 个字符）。", en: "Enter a product ID (at least 2 characters).", ar: "أدخل معرّف المنتج (حرفان على الأقل)." },
  billingProductNameRequired: { zh: "请填写商品名称。", en: "Enter the product's name.", ar: "أدخل اسم المنتج." },
  billingPriceInvalid: { zh: "价格格式不对：请按元填写，最多两位小数，例如 49 或 9.90。", en: "The price is not valid: enter yuan with up to two decimals, e.g. 49 or 9.90.", ar: "السعر غير صالح: أدخله باليوان بمنزلتين عشريتين على الأكثر، مثل 49 أو 9.90." },
  billingPlanTierRequired: { zh: "订阅方案必须选择档位：Pro 或 Max。", en: "A plan needs a tier: Pro or Max.", ar: "تحتاج الخطة إلى مستوى: Pro أو Max." },
  billingPlanPeriodRequired: { zh: "订阅方案必须选择付费周期：月付或年付。", en: "A plan needs a billing period: monthly or yearly.", ar: "تحتاج الخطة إلى فترة دفع: شهرية أو سنوية." },
  billingPlanDaysInvalid: { zh: "每期天数必须是 1 到 3650 之间的整数。", en: "Days per period must be a whole number from 1 to 3650.", ar: "يجب أن تكون أيام الفترة عدداً صحيحاً من 1 إلى 3650." },
  billingPlanUnitsInvalid: { zh: "每周发放数量必须是 0 到 1,000,000,000 之间的整数（0 表示不发放）。", en: "The weekly amount must be a whole number from 0 to 1,000,000,000 (0 means none).", ar: "يجب أن تكون الكمية الأسبوعية عدداً صحيحاً من 0 إلى 1,000,000,000 (0 يعني لا شيء)." },
  billingProductInvalid: { zh: "服务端没有接受这些字段：{fields}。请检查后再保存。", en: "The server did not accept these fields: {fields}. Check them and save again.", ar: "لم يقبل الخادم هذه الحقول: {fields}. راجعها واحفظ مجدداً." },
  billingProductFailed: { zh: "保存商品失败，请稍后重试。", en: "Could not save the product. Try again in a moment.", ar: "تعذّر حفظ المنتج. حاول بعد قليل." },
  billingProductSaved: { zh: "商品 {id} 已保存。", en: "Product {id} saved.", ar: "تم حفظ المنتج {id}." },
  byokRestrictionOn: { zh: "已开启：自配置模型仅限 Pro / Max 订阅用户与企业成员。", en: "On: own model keys are limited to Pro / Max subscribers and organization members.", ar: "مفعّل: المفاتيح الخاصة لمشتركي Pro / Max وأعضاء المؤسسات فقط." },
  byokRestrictionOff: { zh: "已关闭：所有用户都可以使用自配置模型。", en: "Off: every user may use their own model keys.", ar: "متوقف: يمكن لكل المستخدمين استخدام مفاتيحهم الخاصة." },
  byokRestrictionFailed: { zh: "没有保存成功，设置保持原样。请稍后重试。", en: "Not saved; the setting is unchanged. Try again in a moment.", ar: "لم يُحفظ؛ بقي الإعداد كما هو. حاول بعد قليل." },
};

export const ADMIN_MESSAGE_KEYS = Object.keys(MESSAGES);

export function formatAdminMessage(key, locale = "en", params = {}) {
  const entry = MESSAGES[key];
  if (!entry) return key;
  const text = entry[locale] || entry.en;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
}

/** The operator's own language, resolved from their cookie. */
export async function adminMessage(key, params = {}) {
  const locale = await getLocale();
  return formatAdminMessage(key, locale, params);
}

export { MESSAGES as ADMIN_MESSAGES };
