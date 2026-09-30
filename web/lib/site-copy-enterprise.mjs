/**
 * Enterprise page copy (zh / en / ar), same keys in every locale.
 *
 * Describes exactly what shipped on 2026-09-30 (server/src/services/enterprise*.js,
 * the /account/enterprise console): platform-opened organizations, owner/admin/
 * member roles, members by phone (pending seat, 30-day expiry) or issued
 * accounts (one-time password, forced change), a platform-funded pool, weekly
 * member budgets + optional per-request cap, identity decides who pays (never
 * mixed), usage by member and model, change history, owner pause + platform
 * freeze, ownership transfer, restoring removed issued accounts.
 * Vocabulary follows web/lib/enterprise-console-i18n.mjs.
 */

const zh = {
  hero: {
    eyebrow: "Lily 企业版",
    title: "整个团队一起用，每一笔都算得清。",
    description: "企业由平台为你开通。成员从企业额度池里用，每人有自己的每周额度；管理员看得见用量，也看得见每一次变更。",
    primaryCta: "联系销售",
    secondaryCta: "已有企业账号？登录",
    note: "企业额度由平台充值调拨。开通前，先和我们聊聊团队规模与用量。",
    mockLabel: "企业账户后台示意：企业状态与两道开关、额度池余额、成员及其每周额度",
  },
  features: {
    eyebrow: "企业版包含什么",
    title: "给团队用的，都已经准备好。",
    items: [
      ["由平台开通", "联系销售确认后，平台为你创建企业并签发所有者账号。企业内分所有者、管理员、成员三种角色。"],
      ["手机号添加成员", "输入手机号即可添加。未注册的号码会保留待加入席位，对方首次登录时自动加入，30 天内有效。"],
      ["批量签发企业账号", "为没有个人账号的员工批量签发登录名和一次性密码，首次登录时必须修改密码。"],
      ["企业额度池", "由平台为企业充值。全体成员的企业用量都从这里扣，余额一目了然。"],
      ["每人每周额度", "像每周用量上限：从第一次使用开始计算，7 天后重置。可单独设置，也可沿用企业默认值。"],
      ["用量看得清", "按成员、按模型查看企业用量，知道额度花在了哪里。"],
      ["每一步都有记录", "添加成员、调整额度、签发账号、暂停企业，谁在什么时候改了什么，都在变更历史里。"],
      ["两道开关，交接无忧", "所有者可以暂停自己的企业，平台也可以冻结；所有权可以转让，移除的签发账号可以恢复。"],
    ],
  },
  billing: {
    eyebrow: "计费方式",
    title: "选哪个身份，就由谁付费。",
    description: "成员在桌面端「设置 → 账号」里选择身份。企业身份只扣企业额度池，个人身份只扣自己的余额，两者从不混扣。",
    steps: [
      ["平台充值额度池", "企业额度由平台调拨，暂不支持自助付款。"],
      ["成员选择身份", "在桌面端随时切换企业身份或个人身份。"],
      ["按身份扣费", "企业身份计入本人的每周额度，从企业池扣费；个人身份只动个人余额。"],
    ],
    weekTitle: "每周额度怎么算",
    weekBody: "每周额度从成员本周第一次扣费开始计时，7 天后重置，闲置的一周不会留下“已用”。没有单独设置时沿用企业默认值；设为 0 表示本周不能再用企业额度。需要时，还可以给成员加一个单次请求上限。",
    weekMarks: ["第一次使用", "7 天窗口", "重置"],
  },
  console: {
    eyebrow: "企业后台",
    title: "管理员要做的事，都在一处。",
    description: "所有者和管理员在网页上的企业账户里管理成员、每周额度、额度池、用量和变更历史。",
  },
  faq: {
    eyebrow: "常见问题",
    title: "开通之前，你可能想知道。",
    items: [
      ["企业怎么开通？", "企业由平台开通，不能自助创建。联系销售说明团队情况，确认后我们为你创建企业并签发所有者账号。"],
      ["员工还没注册 Lily，怎么加进来？", "两种方式：用手机号添加，未注册的号码会保留待加入席位，对方首次用这个手机号登录时自动加入，30 天内有效；或者批量签发企业账号，登录名加一次性密码，首次登录必须改密。"],
      ["员工的个人余额会被企业扣掉吗？", "不会。成员在桌面端选择的身份决定由谁付费：企业身份只扣企业额度池，个人身份只扣个人余额，两者从不混扣。"],
      ["每周额度用完了会怎样？", "本周不能再用企业额度，从第一次扣费起满 7 天后重置。管理员可以随时调整这位成员的每周额度；成员也可以切换到个人身份，用自己的余额继续。"],
      ["暂停和冻结有什么区别？", "暂停是企业所有者自己的开关，所有者可以随时恢复；冻结由平台操作，只有平台能解除。任一开关关闭，成员都不能使用企业额度，个人身份不受影响。"],
      ["负责人换人、员工离职怎么办？", "所有者可以把所有权转让给其他成员；离职员工移出企业即可。移除的企业签发账号，之后仍可以恢复。"],
    ],
  },
  finalCta: {
    title: "聊聊你的团队，我们来开通。",
    description: "告诉我们团队规模和使用场景，我们为你开通企业，并为额度池充值。",
    primary: "联系销售",
    secondary: "已有企业账号？登录",
  },
  mocks: {
    org: {
      windowTitle: "企业账户",
      orgName: "星河科技",
      role: "所有者",
      nav: ["概览", "成员", "用量", "操作记录", "额度池", "设置"],
      statusLabel: "企业状态",
      status: "正常",
      switches: [["企业自己的开关", "打开"], ["平台开关", "打开"]],
      poolLabel: "企业额度池",
      poolValue: "482,000",
      poolUnit: "可用积分",
      poolExtra: "另有 200 张图片 · 30 段视频",
      membersLabel: "成员",
      weekLabel: "本周额度（积分）",
      defaultNote: "企业默认每周额度：20,000 积分",
      members: [
        ["陈一鸣", "所有者", "7,200 / 30,000", 24, "个人设置"],
        ["林晓", "管理员", "18,600 / 30,000", 62, "个人设置"],
        ["王可", "成员", "18,000 / 20,000", 90, "企业默认"],
        ["赵宁", "成员", "本周尚未开始", 0, "企业默认"],
      ],
    },
    identity: {
      title: "付费身份",
      path: "设置 → 账号",
      options: [["企业身份", "星河科技 · 只扣企业额度池"], ["个人身份", "只扣你自己的余额"]],
      week: "本周已用 7,200 / 30,000 积分",
      note: "两者不会混用",
    },
    add: {
      title: "添加成员",
      tabs: ["手机号", "签发账号"],
      phoneLabel: "手机号",
      phone: "138 **** 2046",
      pending: "待加入",
      pendingNote: "首次登录自动加入 · 30 天内有效",
      issuedTitle: "本次签发 3 个账号",
      issued: [["xinghe.wang", "一次性密码"], ["xinghe.zhao", "一次性密码"], ["xinghe.sun", "一次性密码"]],
      issuedNote: "首次登录必须修改密码",
    },
    history: {
      title: "操作记录",
      rows: [
        ["林晓", "把王可的每周额度改为 20,000 积分", "今天 10:24"],
        ["陈一鸣", "签发 3 个员工账号", "昨天 17:02"],
        ["平台", "为额度池调拨 500,000 积分", "9 月 26 日"],
        ["陈一鸣", "添加成员 138****2046", "9 月 25 日"],
        ["林晓", "恢复已移除的签发账号 xinghe.li", "9 月 24 日"],
        ["陈一鸣", "把企业默认每周额度设为 20,000 积分", "9 月 23 日"],
      ],
    },
  },
};

const en = {
  hero: {
    eyebrow: "Lily for teams",
    title: "Your whole team on Lily, with every charge accounted for.",
    description: "Organizations are opened by the platform. Members draw on the organization's pool, each within a weekly budget; admins see the usage and every change.",
    primaryCta: "Contact sales",
    secondaryCta: "Have an organization account? Sign in",
    note: "The organization pool is funded by the platform. Tell us about your team size and usage first.",
    mockLabel: "Illustration of the organization console: status with its two switches, pool balance, and members with their weekly budgets",
  },
  features: {
    eyebrow: "What's included",
    title: "Everything a team needs is already there.",
    items: [
      ["Opened by the platform", "After a conversation with sales, the platform creates your organization and issues the owner account. Roles: owner, admin and member."],
      ["Add members by phone", "Enter a phone number. An unregistered number keeps a pending seat that joins on first sign-in, valid for 30 days."],
      ["Issue company accounts in bulk", "For staff without a personal account: a login name and a one-time password each, changed on first sign-in."],
      ["An organization pool", "Funded by the platform. All organization usage is drawn from it, with the balance always in view."],
      ["A weekly budget per member", "Like a weekly usage limit: the window starts at first use and resets after 7 days. Set per member, or use the organization default."],
      ["Usage you can read", "Organization usage by member and by model, so you know where the quota goes."],
      ["Every step on record", "Members added, budgets changed, accounts issued, the organization paused — who changed what, and when."],
      ["Two switches, clean handovers", "The owner can pause the organization and the platform can freeze it; ownership can be transferred, and removed issued accounts restored."],
    ],
  },
  billing: {
    eyebrow: "How billing works",
    title: "The identity you choose decides who pays.",
    description: "Members pick an identity in the desktop app under Settings → Account. The organization identity draws only on the pool; the personal identity only on their own balance. The two never mix.",
    steps: [
      ["The platform funds the pool", "Quota is granted by the platform; self-service payment isn't available yet."],
      ["Members pick an identity", "Switch between the organization and personal identity at any time in the desktop app."],
      ["Charged by identity", "Organization use counts toward the member's weekly budget and draws on the pool; personal use touches only the personal balance."],
    ],
    weekTitle: "How the weekly budget works",
    weekBody: "A member's weekly window starts at their first charge and resets 7 days later, so an idle week leaves nothing \"used\" behind. Without a member setting, the organization default applies; 0 means no more organization quota this week. An optional per-request cap can be added too.",
    weekMarks: ["First use", "7-day window", "Reset"],
  },
  console: {
    eyebrow: "The console",
    title: "Everything an admin does, in one place.",
    description: "Owners and admins manage members, weekly budgets, the pool, usage and the change history in the organization account on the web.",
  },
  faq: {
    eyebrow: "FAQ",
    title: "Before you start, you may want to know.",
    items: [
      ["How is an organization opened?", "Organizations are opened by the platform, not self-created. Tell sales about your team; once agreed, we create the organization and issue the owner account."],
      ["How do I add staff who aren't on Lily yet?", "Two ways: add them by phone — an unregistered number keeps a pending seat that joins the first time they sign in with it, valid for 30 days — or issue company accounts in bulk, each with a login name and a one-time password that must be changed on first sign-in."],
      ["Can the organization charge a member's personal balance?", "No. The identity a member picks in the desktop app decides who pays: the organization identity draws only on the pool, the personal identity only on the personal balance. Never mixed."],
      ["What happens when a weekly budget runs out?", "No more organization quota that week; the window resets 7 days after its first charge. Admins can change that member's budget any time, and the member can switch to the personal identity and continue on their own balance."],
      ["What's the difference between pause and freeze?", "Pause is the owner's own switch, and the owner can resume at any time. Freeze is set by the platform and only the platform can lift it. With either switch off, members can't use organization quota; the personal identity is unaffected."],
      ["What if the owner changes or someone leaves?", "The owner can transfer ownership to another member; someone leaving is simply removed. A removed issued account can be restored later."],
    ],
  },
  finalCta: {
    title: "Tell us about your team. We'll open the organization.",
    description: "Share your team size and use cases, and we'll open the organization and fund its pool.",
    primary: "Contact sales",
    secondary: "Have an organization account? Sign in",
  },
  mocks: {
    org: {
      windowTitle: "Organization account",
      orgName: "Meridian Studio",
      role: "Owner",
      nav: ["Overview", "Members", "Usage", "History", "Pool", "Settings"],
      statusLabel: "Status",
      status: "Active",
      switches: [["Owner switch", "On"], ["Platform switch", "On"]],
      poolLabel: "Organization pool",
      poolValue: "482,000",
      poolUnit: "Credits available",
      poolExtra: "Plus 200 images · 30 videos",
      membersLabel: "Members",
      weekLabel: "This week (credits)",
      defaultNote: "Organization default: 20,000 credits a week",
      members: [
        ["Maya Chen", "Owner", "7,200 / 30,000", 24, "own setting"],
        ["Leo Lin", "Admin", "18,600 / 30,000", 62, "own setting"],
        ["Kai Wang", "Member", "18,000 / 20,000", 90, "org default"],
        ["Nora Zhao", "Member", "Not started", 0, "org default"],
      ],
    },
    identity: {
      title: "Paying identity",
      path: "Settings → Account",
      options: [["Organization", "Meridian Studio · pool only"], ["Personal", "Your own balance only"]],
      week: "This week 7,200 / 30,000 credits",
      note: "The two never mix",
    },
    add: {
      title: "Add members",
      tabs: ["Phone", "Issue accounts"],
      phoneLabel: "Phone",
      phone: "+86 138 **** 2046",
      pending: "Pending",
      pendingNote: "Joins on first sign-in · valid 30 days",
      issuedTitle: "3 accounts issued",
      issued: [["meridian.wang", "One-time password"], ["meridian.zhao", "One-time password"], ["meridian.sun", "One-time password"]],
      issuedNote: "Password change required on first sign-in",
    },
    history: {
      title: "History",
      rows: [
        ["Leo Lin", "Set Kai Wang's weekly budget to 20,000 credits", "Today 10:24"],
        ["Maya Chen", "Issued 3 employee accounts", "Yesterday 17:02"],
        ["Platform", "Granted 500,000 credits to the pool", "Sep 26"],
        ["Maya Chen", "Added member +86 138****2046", "Sep 25"],
        ["Leo Lin", "Restored removed issued account meridian.li", "Sep 24"],
        ["Maya Chen", "Set the organization default to 20,000 credits a week", "Sep 23"],
      ],
    },
  },
};

const ar = {
  hero: {
    eyebrow: "Lily للمؤسسات",
    title: "فريقك كله على Lily، وكل خصم محسوب.",
    description: "تفتح المنصة المؤسسات. يستخدم الأعضاء رصيد المؤسسة، ولكلٍّ منهم ميزانية أسبوعية؛ ويرى المشرفون الاستخدام وكل تغيير.",
    primaryCta: "تواصل مع المبيعات",
    secondaryCta: "لديك حساب مؤسسة؟ سجّل الدخول",
    note: "تشحن المنصة رصيد المؤسسة. حدّثنا أولًا عن حجم فريقك واستخدامه.",
    mockLabel: "رسم توضيحي لوحدة تحكم المؤسسة: الحالة ومفتاحاها، ورصيد المؤسسة، والأعضاء مع ميزانياتهم الأسبوعية",
  },
  features: {
    eyebrow: "ما الذي تتضمنه",
    title: "كل ما يحتاجه الفريق جاهز بالفعل.",
    items: [
      ["تفتحها المنصة", "بعد التواصل مع المبيعات تنشئ المنصة مؤسستك وتُصدر حساب المالك. الأدوار: مالك ومشرف وعضو."],
      ["إضافة الأعضاء برقم الهاتف", "أدخل رقم الهاتف. الرقم غير المسجّل يحتفظ بمقعد معلّق ينضم عند أول تسجيل دخول، صالح 30 يومًا."],
      ["إصدار حسابات الشركة دفعة واحدة", "للموظفين بلا حساب شخصي: اسم دخول وكلمة مرور لمرة واحدة لكلٍّ منهم، تُغيَّر عند أول دخول."],
      ["رصيد المؤسسة", "تشحنه المنصة، ويُخصم منه كل استخدام المؤسسة، والرصيد ظاهر دائمًا."],
      ["ميزانية أسبوعية لكل عضو", "مثل حدّ أسبوعي للاستخدام: تبدأ الفترة عند أول استخدام وتتجدد بعد 7 أيام. تُضبط لكل عضو أو تتبع الإعداد الافتراضي للمؤسسة."],
      ["استخدام واضح", "استخدام المؤسسة حسب العضو وحسب النموذج، لتعرف أين تذهب الحصة."],
      ["كل خطوة مسجّلة", "إضافة الأعضاء وتعديل الميزانيات وإصدار الحسابات وإيقاف المؤسسة: من غيّر ماذا ومتى."],
      ["مفتاحان وتسليم سلس", "يستطيع المالك إيقاف مؤسسته وتستطيع المنصة تجميدها؛ ويمكن نقل الملكية واستعادة الحسابات الصادرة المحذوفة."],
    ],
  },
  billing: {
    eyebrow: "طريقة الفوترة",
    title: "الهوية التي تختارها تحدد من يدفع.",
    description: "يختار العضو هويته في تطبيق سطح المكتب من الإعدادات ← الحساب. هوية المؤسسة تخصم من رصيد المؤسسة فقط، والهوية الشخصية من رصيده فقط. لا يختلط الاثنان أبدًا.",
    steps: [
      ["المنصة تشحن الرصيد", "تمنح المنصة الحصة؛ الدفع الذاتي غير متاح بعد."],
      ["العضو يختار هويته", "بدّل بين هوية المؤسسة والهوية الشخصية في أي وقت من تطبيق سطح المكتب."],
      ["الخصم حسب الهوية", "استخدام المؤسسة يُحتسب من الميزانية الأسبوعية للعضو ويُخصم من رصيد المؤسسة؛ والاستخدام الشخصي يمسّ الرصيد الشخصي فقط."],
    ],
    weekTitle: "كيف تعمل الميزانية الأسبوعية",
    weekBody: "تبدأ فترة العضو الأسبوعية عند أول خصم وتتجدد بعد 7 أيام، فلا يترك الأسبوع الخامل استخدامًا محسوبًا. إن لم يُضبط للعضو إعداد خاص فالإعداد الافتراضي للمؤسسة هو المعتمد، والقيمة 0 تعني عدم استخدام حصة المؤسسة هذا الأسبوع. ويمكن أيضًا إضافة حدّ اختياري لكل طلب.",
    weekMarks: ["أول استخدام", "فترة 7 أيام", "التجديد"],
  },
  console: {
    eyebrow: "وحدة التحكم",
    title: "كل ما يفعله المشرف، في مكان واحد.",
    description: "يدير المالكون والمشرفون الأعضاء والميزانيات الأسبوعية والرصيد والاستخدام وسجل التغييرات من حساب المؤسسة على الويب.",
  },
  faq: {
    eyebrow: "الأسئلة الشائعة",
    title: "قبل أن تبدأ، قد ترغب في معرفة ما يلي.",
    items: [
      ["كيف تُفتح المؤسسة؟", "تفتح المنصة المؤسسات ولا يمكن إنشاؤها ذاتيًا. حدّث المبيعات عن فريقك، وبعد الاتفاق ننشئ المؤسسة ونُصدر حساب المالك."],
      ["كيف أضيف موظفين ليسوا على Lily بعد؟", "بطريقتين: أضفهم برقم الهاتف، فيحتفظ الرقم غير المسجّل بمقعد معلّق ينضم عند أول دخول به، صالح 30 يومًا؛ أو أصدر حسابات الشركة دفعة واحدة، لكلٍّ منها اسم دخول وكلمة مرور لمرة واحدة يجب تغييرها عند أول دخول."],
      ["هل يمكن للمؤسسة الخصم من الرصيد الشخصي للعضو؟", "لا. الهوية التي يختارها العضو في تطبيق سطح المكتب تحدد من يدفع: هوية المؤسسة تخصم من رصيد المؤسسة فقط، والهوية الشخصية من الرصيد الشخصي فقط. لا يختلطان أبدًا."],
      ["ماذا يحدث عند نفاد الميزانية الأسبوعية؟", "لا مزيد من حصة المؤسسة ذلك الأسبوع، وتتجدد الفترة بعد 7 أيام من أول خصم. يستطيع المشرف تعديل ميزانية العضو في أي وقت، ويستطيع العضو التبديل إلى هويته الشخصية والمتابعة من رصيده."],
      ["ما الفرق بين الإيقاف والتجميد؟", "الإيقاف مفتاح المالك نفسه ويمكنه الاستئناف متى شاء. التجميد تضعه المنصة ولا ترفعه إلا المنصة. إذا أُغلق أيٌّ من المفتاحين لا يستطيع الأعضاء استخدام حصة المؤسسة، ولا تتأثر الهوية الشخصية."],
      ["ماذا لو تغيّر المالك أو غادر أحد الموظفين؟", "يستطيع المالك نقل الملكية إلى عضو آخر، ومن يغادر يُزال فحسب. ويمكن لاحقًا استعادة الحساب الصادر المحذوف."],
    ],
  },
  finalCta: {
    title: "حدّثنا عن فريقك، ونفتح لك المؤسسة.",
    description: "أخبرنا بحجم فريقك وحالات الاستخدام، فنفتح المؤسسة ونشحن رصيدها.",
    primary: "تواصل مع المبيعات",
    secondary: "لديك حساب مؤسسة؟ سجّل الدخول",
  },
  mocks: {
    org: {
      windowTitle: "حساب المؤسسة",
      orgName: "مختبرات الشمال",
      role: "المالك",
      nav: ["نظرة عامة", "الأعضاء", "الاستخدام", "السجل", "الرصيد", "الإعدادات"],
      statusLabel: "الحالة",
      status: "نشطة",
      switches: [["مفتاح المالك", "مفتوح"], ["مفتاح المنصة", "مفتوح"]],
      poolLabel: "رصيد المؤسسة",
      poolValue: "482,000",
      poolUnit: "نقاط متاحة",
      poolExtra: "إضافة إلى 200 صورة · 30 مقطع فيديو",
      membersLabel: "الأعضاء",
      weekLabel: "هذا الأسبوع (نقاط)",
      defaultNote: "الافتراضي للمؤسسة: 20,000 نقاط أسبوعيًا",
      members: [
        ["ليلى حداد", "المالك", "7,200 / 30,000", 24, "إعداد خاص"],
        ["عمر ناصر", "مشرف", "18,600 / 30,000", 62, "إعداد خاص"],
        ["سارة يوسف", "عضو", "18,000 / 20,000", 90, "افتراضي المؤسسة"],
        ["كريم سالم", "عضو", "لم تبدأ بعد", 0, "افتراضي المؤسسة"],
      ],
    },
    identity: {
      title: "هوية الدفع",
      path: "الإعدادات ← الحساب",
      options: [["هوية المؤسسة", "مختبرات الشمال · رصيد المؤسسة فقط"], ["الهوية الشخصية", "رصيدك أنت فقط"]],
      week: "هذا الأسبوع 7,200 / 30,000 نقاط",
      note: "لا يختلط الاثنان",
    },
    add: {
      title: "إضافة أعضاء",
      tabs: ["رقم الهاتف", "إصدار حسابات"],
      phoneLabel: "رقم الهاتف",
      phone: "+971 50 *** 2046",
      pending: "معلّق",
      pendingNote: "ينضم عند أول دخول · صالح 30 يومًا",
      issuedTitle: "أُصدرت 3 حسابات",
      issued: [["north.haddad", "كلمة مرور لمرة واحدة"], ["north.nasser", "كلمة مرور لمرة واحدة"], ["north.salem", "كلمة مرور لمرة واحدة"]],
      issuedNote: "يلزم تغيير كلمة المرور عند أول دخول",
    },
    history: {
      title: "السجل",
      rows: [
        ["عمر ناصر", "ضبط ميزانية سارة يوسف الأسبوعية على 20,000 نقاط", "اليوم 10:24"],
        ["ليلى حداد", "أصدرت 3 حسابات موظفين", "أمس 17:02"],
        ["المنصة", "منحت 500,000 نقاط للرصيد", "26 سبتمبر"],
        ["ليلى حداد", "أضافت عضوًا ‎+971 50 *** 2046", "25 سبتمبر"],
        ["عمر ناصر", "استعاد الحساب الصادر المحذوف north.youssef", "24 سبتمبر"],
        ["ليلى حداد", "ضبطت الافتراضي للمؤسسة على 20,000 نقاط أسبوعيًا", "23 سبتمبر"],
      ],
    },
  },
};

export const enterpriseCopy = { zh, en, ar };

export function enterpriseContentFor(locale = "zh") {
  return enterpriseCopy[locale] || enterpriseCopy.zh;
}
