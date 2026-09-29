/**
 * What an enterprise server code means to the person who hit it — in both the
 * enterprise console and the platform admin console.
 *
 * Both consoles used to show the raw code ("ORG_OWNER_IMMUTABLE",
 * "OWNER_NOT_REGISTERED", even a Postgres "23505"). Keeping every code in one
 * enumerable table lets a gate prove that each code the server can return has
 * a message in all three languages (scripts/test-enterprise-messages.mjs scans
 * the server source for them).
 *
 * Each message says what happened and, where there is one, what to do next.
 */

const MESSAGES = {
  // session / account
  USER_LOGIN_REQUIRED: { zh: "登录已过期，请重新登录。", en: "Your session has expired. Please sign in again.", ar: "انتهت صلاحية الجلسة. يرجى تسجيل الدخول مجددًا." },
  USER_DISABLED: { zh: "该账号已被停用。", en: "This account is disabled.", ar: "هذا الحساب معطّل." },
  PASSWORD_CHANGE_REQUIRED: { zh: "请先修改初始密码再继续。", en: "Change your initial password before continuing.", ar: "غيّر كلمة المرور الأولية قبل المتابعة." },
  INVALID_CREDENTIALS: { zh: "账号或密码不正确。", en: "Wrong login name or password.", ar: "اسم الدخول أو كلمة المرور غير صحيحة." },
  PASSWORD_LOCKED: { zh: "密码错误次数过多，请 15 分钟后再试。", en: "Too many wrong passwords. Try again in 15 minutes.", ar: "محاولات خاطئة كثيرة. حاول مجددًا بعد 15 دقيقة." },
  PASSWORD_TOO_SHORT: { zh: "密码太短。", en: "The password is too short.", ar: "كلمة المرور قصيرة جدًا." },
  PASSWORD_TOO_LONG: { zh: "密码太长。", en: "The password is too long.", ar: "كلمة المرور طويلة جدًا." },
  PASSWORD_TOO_SIMPLE: { zh: "密码太简单，请混合字母和数字。", en: "The password is too simple — mix letters and digits.", ar: "كلمة المرور بسيطة جدًا — امزج الحروف والأرقام." },

  // organization state
  ORG_NOT_FOUND: { zh: "找不到这个企业。", en: "This organization was not found.", ar: "لم يتم العثور على هذه المؤسسة." },
  ORG_DISABLED: { zh: "企业已暂停使用，企业所有者可以恢复。", en: "The organization is paused. Its owner can resume it.", ar: "المؤسسة موقوفة مؤقتًا. يمكن لمالكها استئنافها." },
  ORG_SUSPENDED: { zh: "企业已被平台冻结，请联系平台客服。", en: "The organization is frozen by the platform. Contact platform support.", ar: "جمّدت المنصة هذه المؤسسة. تواصل مع دعم المنصة." },
  ORG_CREATE_PLATFORM_ONLY: { zh: "企业由平台开通，请联系平台销售或客服。", en: "Organizations are opened by the platform. Contact sales or support.", ar: "تفتح المنصة المؤسسات. تواصل مع المبيعات أو الدعم." },
  ORG_NO_OWNER: { zh: "企业还没有可用的所有者，无法调拨额度。", en: "The organization has no active owner, so quota cannot be granted.", ar: "لا يوجد مالك نشط للمؤسسة، لذا لا يمكن منح الحصة." },

  // who may do what
  ORG_MEMBER_REQUIRED: { zh: "你不是这个企业的成员。", en: "You are not a member of this organization.", ar: "لست عضوًا في هذه المؤسسة." },
  ORG_MEMBER_DISABLED: { zh: "你在这个企业的成员身份已被停用。", en: "Your membership in this organization is disabled.", ar: "عضويتك في هذه المؤسسة معطّلة." },
  ORG_FORBIDDEN: { zh: "你的角色不能执行这个操作。", en: "Your role cannot do this.", ar: "دورك لا يسمح بهذا الإجراء." },
  ORG_ROLE_INVALID: { zh: "角色不正确。", en: "Invalid role.", ar: "دور غير صالح." },
  ORG_OWNER_IMMUTABLE: { zh: "只有所有者才能调整所有者。", en: "Only an owner can change an owner.", ar: "المالك وحده يمكنه تعديل مالك." },
  ORG_PROMOTE_FORBIDDEN: { zh: "只有所有者才能把成员设为所有者。", en: "Only an owner can make someone an owner.", ar: "المالك وحده يمكنه تعيين مالك." },
  ORG_ADMIN_PEER_FORBIDDEN: { zh: "管理员之间不能互相停用、移除或重置密码，请由所有者操作。", en: "Admins cannot disable, remove or reset each other — ask the owner.", ar: "لا يمكن للمشرفين تعطيل بعضهم أو إزالتهم أو إعادة تعيين كلمات مرورهم — اطلب ذلك من المالك." },
  ORG_SELF_REMOVE_FORBIDDEN: { zh: "不能在成员列表里移除自己，请使用“退出企业”。", en: "You cannot remove yourself here — use “Leave organization”.", ar: "لا يمكنك إزالة نفسك هنا — استخدم «مغادرة المؤسسة»." },
  ORG_LAST_OWNER: { zh: "企业至少要保留一位所有者，请先转让所有权。", en: "An organization needs at least one owner — transfer ownership first.", ar: "تحتاج المؤسسة إلى مالك واحد على الأقل — انقل الملكية أولًا." },
  ORG_ISSUED_ACCOUNT_CANNOT_LEAVE: { zh: "企业签发的账号不能自行退出，请联系企业管理员。", en: "An account the organization issued cannot leave on its own — ask an admin.", ar: "لا يمكن لحساب أصدرته المؤسسة المغادرة بنفسه — اطلب ذلك من مشرف." },

  // members and invitations
  MEMBER_NOT_FOUND: { zh: "找不到这个成员，可能已被移除。", en: "This member was not found — they may have been removed.", ar: "لم يتم العثور على هذا العضو — ربما أُزيل." },
  MEMBER_ALREADY_EXISTS: { zh: "此人已经是企业成员。", en: "This person is already a member.", ar: "هذا الشخص عضو بالفعل." },
  MEMBER_TARGET_REQUIRED: { zh: "请填写手机号或用户 ID。", en: "Enter a phone number or user ID.", ar: "أدخل رقم هاتف أو معرّف مستخدم." },
  USER_NOT_FOUND: { zh: "找不到这个用户 ID，请检查是否输错。", en: "No user has this ID — check for a typo.", ar: "لا يوجد مستخدم بهذا المعرّف — تحقّق من الكتابة." },
  INVALID_PHONE: { zh: "手机号格式不正确，请填写 11 位中国大陆手机号。", en: "Invalid phone number — enter an 11-digit mainland China mobile number.", ar: "رقم هاتف غير صالح — أدخل رقمًا صينيًا من 11 خانة." },
  INVITE_ROLE_UNSUPPORTED: { zh: "邀请和签发的账号不能直接成为所有者。", en: "Invited or issued accounts cannot be made owner directly.", ar: "لا يمكن جعل الحسابات المدعوّة أو المُصدَرة مالكة مباشرة." },
  INVITATION_NOT_FOUND: { zh: "这条邀请已不存在（可能已被接受、撤回或过期）。", en: "This invitation no longer exists (accepted, revoked or expired).", ar: "هذه الدعوة لم تعد موجودة (قُبلت أو أُلغيت أو انتهت)." },

  // issued accounts
  ACCOUNTS_REQUIRED: { zh: "请至少填写一个账号，或填写前缀和数量。", en: "Enter at least one account, or a prefix and a count.", ar: "أدخل حسابًا واحدًا على الأقل، أو بادئة وعددًا." },
  INVALID_LOGIN_NAME: { zh: "登录名只能用字母、数字、点、下划线和短横线，3–40 位。", en: "Login names use letters, digits, dot, underscore and dash (3–40).", ar: "تستخدم أسماء الدخول الحروف والأرقام والنقطة والشرطة (3–40)." },
  INVALID_LOGIN_PREFIX: { zh: "前缀只能用字母、数字、点、下划线和短横线。", en: "The prefix may use letters, digits, dot, underscore and dash.", ar: "قد تحتوي البادئة على حروف وأرقام ونقطة وشرطة." },
  LOGIN_NAME_TAKEN: { zh: "这个登录名已被占用，请换一个。", en: "This login name is taken — choose another.", ar: "اسم الدخول مستخدم — اختر اسمًا آخر." },
  LOGIN_NAME_UNAVAILABLE: { zh: "暂时无法生成可用的登录名，请手动填写。", en: "Could not generate a free login name — enter one yourself.", ar: "تعذّر إنشاء اسم دخول متاح — أدخل اسمًا بنفسك." },
  ACCOUNT_NOT_FOUND: { zh: "这不是本企业签发的账号，无法重置密码。", en: "This is not an account this organization issued, so its password cannot be reset.", ar: "هذا ليس حسابًا أصدرته المؤسسة، لذا لا يمكن إعادة تعيين كلمة مروره." },

  // budgets, pool and grants
  WEEKLY_BUDGET_INVALID: { zh: "每周额度必须是不小于 0 的整数，留空表示不限。", en: "The weekly budget must be a whole number ≥ 0; leave it empty for no limit.", ar: "يجب أن تكون الميزانية الأسبوعية عددًا صحيحًا ≥ 0؛ اتركها فارغة لعدم التقييد." },
  ORG_MEMBER_WEEKLY_LIMIT: { zh: "本周额度已用完，将在重置时间后恢复。", en: "This week's budget is used up; it resets at the time shown.", ar: "نفدت ميزانية هذا الأسبوع؛ ستُعاد في الوقت المعروض." },
  ORG_MEMBER_QUOTA_EXCEEDED: { zh: "单次请求超过了你的单次上限。", en: "This request is larger than your per-request cap.", ar: "هذا الطلب أكبر من الحد المسموح لكل طلب." },
  ORG_POOL_INSUFFICIENT: { zh: "企业额度池余额不足，请联系企业管理员或平台充值。", en: "The organization's quota pool is empty — ask an admin or the platform to top it up.", ar: "رصيد حصة المؤسسة غير كافٍ — اطلب من مشرف أو من المنصة إضافة رصيد." },
  OWNER_NOT_REGISTERED: { zh: "这个手机号还没有注册，请改用“签发企业账号”作为所有者。", en: "This phone is not registered — issue an owner account instead.", ar: "هذا الرقم غير مسجّل — أصدِر حساب مالك بدلًا من ذلك." },
  OWNER_INITIAL_PASSWORD_UNAVAILABLE: { zh: "所有者已激活或不是平台签发的账号，平台不能再重置其密码。", en: "The owner has already activated the account (or it was not issued by the platform), so the platform can no longer reset it.", ar: "فعّل المالك الحساب بالفعل (أو لم تُصدره المنصة)، لذا لا يمكن للمنصة إعادة تعيينه." },
  GRANT_NOT_FOUND: { zh: "找不到这笔额度。", en: "This grant was not found.", ar: "لم يتم العثور على هذه المنحة." },
  GRANT_NOT_ACTIVE: { zh: "这笔额度已撤销，不能再调整。", en: "This grant is revoked and cannot be changed.", ar: "هذه المنحة ملغاة ولا يمكن تعديلها." },
  GRANT_NOTHING_LEFT: { zh: "这笔额度已经用完，没有可扣回的部分。", en: "Nothing is left in this grant to take back.", ar: "لم يتبقَّ شيء في هذه المنحة لاستعادته." },

  // generic
  VALIDATION_ERROR: { zh: "填写的内容有误，请检查后重试。", en: "Some fields are invalid — check and try again.", ar: "بعض الحقول غير صالحة — تحقّق وحاول مجددًا." },
  RATE_LIMITED: { zh: "操作太频繁，请稍后再试。", en: "Too many requests — try again shortly.", ar: "طلبات كثيرة — حاول بعد قليل." },
  INTERNAL_ERROR: { zh: "服务暂时出错，请稍后重试；如果反复出现请联系客服。", en: "Something went wrong on our side — try again; contact support if it keeps happening.", ar: "حدث خطأ من جهتنا — حاول مجددًا؛ تواصل مع الدعم إن تكرر." },
};

const FALLBACK = { zh: "操作没有完成（{code}），请稍后重试。", en: "The action did not complete ({code}). Try again.", ar: "لم يكتمل الإجراء ({code}). حاول مجددًا." };

export const ENTERPRISE_MESSAGE_CODES = Object.freeze(Object.keys(MESSAGES));

/** Pull the server code out of whatever a fetch helper threw ("CODE", "CODE: detail", Error). */
export function enterpriseErrorCode(value) {
  const text = String(value?.message ?? value ?? "").trim();
  const match = text.match(/^([A-Z][A-Z0-9_]{2,})(?::|$)/);
  return match ? match[1] : "";
}

/** The sentence to show for a server code (or a thrown error) in `locale`. */
export function enterpriseMessage(codeOrError, locale = "zh") {
  const code = MESSAGES[codeOrError] ? codeOrError : enterpriseErrorCode(codeOrError);
  const lang = ["zh", "en", "ar"].includes(locale) ? locale : "zh";
  const entry = MESSAGES[code];
  if (entry) return entry[lang] || entry.en;
  return (FALLBACK[lang] || FALLBACK.en).replace("{code}", code || "?");
}
