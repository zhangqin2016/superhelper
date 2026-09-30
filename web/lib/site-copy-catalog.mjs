// Copy for the public catalog-style pages (/apps, /skills, /changelog,
// /contact), in zh / en / ar with the same keys.
//
// It layers over the older `t.catalog` / `t.contactForm` strings in i18n.mjs
// (owned elsewhere): the pages merge these on top, so a key here wins. Why it
// exists (2026-09-30): the apps headline broke mid-word ("工作场 / 景"), raw
// type ids ("connector", "workspace") showed on the Chinese site, and the
// contact page spoke to operators ("review it in the admin console").

const zh = {
  apps: {
    eyebrow: "Lily 应用",
    title: "拿来就用，完整的工作场景。",
    description: "每个应用把工作区、技能和模板组合在一起，装好就能开始做事。",
    count: "{n} 个应用",
    types: { workspace: "工作区", connector: "连接器", template: "模板", dashboard: "看板", tool: "工具", agent: "智能体" },
    plans: { free: "免费", personal: "个人版", pro: "专业版", team: "团队版", enterprise: "企业版" },
    typeLabel: "类型",
    publisherLabel: "发布方",
    howTitle: "怎么开始用",
    howSteps: ["下载并登录 Lily。", "在 Lily 的市场中安装这个应用，或直接告诉 Lily 帮你安装。", "用平常说话的方式描述任务。"],
  },
  skills: {
    eyebrow: "Lily 技能",
    title: "需要时出现，不需要时保持安静。",
    description: "技能是 Lily 处理特定任务的方法。你只需要描述目标，Lily 会自动选用合适的技能。",
    searchLabel: "搜索技能",
    searchPlaceholder: "搜索技能名称或用途",
    filterLabel: "按类别筛选",
    all: "全部",
    count: "{n} 个技能",
    noResults: "没有找到匹配的技能。",
    clear: "清除筛选",
    ctaTitle: "这些技能都已内置在 Lily 中",
    ctaBody: "不需要单独安装或开启。描述你的任务，Lily 会自动选用。",
    categories: { office: "办公文档", coding: "编程开发", research: "研究", media: "媒体创意", design: "设计交互", quality: "质量评测" },
  },
  changelog: {
    eyebrow: "更新日志",
    title: "Lily 的每一次改进。",
    description: "新版本会自动推送到你的电脑。这里按时间记录每个版本带来了什么。",
    latest: "最新",
    required: "必要更新",
    showAll: "展开全部 {n} 条",
    older: "查看更早的 {n} 个版本",
    noNotes: "稳定性与体验改进。",
    notesLanguage: "",
    platforms: { "darwin-arm64": "macOS · Apple 芯片", "darwin-x64": "macOS · Intel", "win32-x64": "Windows" },
    emptyTitle: "还没有发布记录",
    emptyBody: "新版本发布后会出现在这里。",
    errorTitle: "更新日志暂时无法加载",
    errorBody: "请稍后刷新。Lily 会照常在应用内检查更新。",
  },
  contact: {
    eyebrow: "联系我们",
    title: "有问题，或想让团队用上 Lily？",
    description: "使用问题、企业开通、合作意向都可以在这里留言。我们会尽快通过邮件回复你。",
    topicLabel: "咨询类型",
    topics: { general: "产品使用咨询", enterprise: "企业开通与采购", support: "问题反馈", partnership: "合作" },
    asideTitle: "写清楚这些，回复会更快",
    asideItems: [
      ["你想完成什么", "描述具体的工作或遇到的问题，比用了哪个功能更有用。"],
      ["团队规模", "企业开通时，告诉我们大概有多少人会使用，以及用 Mac 还是 Windows。"],
      ["怎么联系你", "留下常用邮箱；方便的话再留一个电话或微信。"],
    ],
    emailTitle: "也可以直接发邮件",
    helpTitle: "先看看帮助中心",
    helpBody: "安装、登录、企业额度等常见问题都有说明。",
    helpCta: "打开帮助中心",
    form: {
      company: "公司 / 团队（选填）",
      phone: "电话 / 微信（选填）",
      subject: "主题（选填）",
      success: "已收到，我们会尽快通过邮件回复你。",
    },
  },
};

const en = {
  apps: {
    eyebrow: "Lily Apps",
    title: "Complete workflows, ready to use.",
    description: "Each app combines a workspace, skills and templates, so you can start working as soon as it is installed.",
    count: "{n} apps",
    types: { workspace: "Workspace", connector: "Connector", template: "Template", dashboard: "Dashboard", tool: "Tool", agent: "Agent" },
    plans: { free: "Free", personal: "Personal", pro: "Pro", team: "Team", enterprise: "Enterprise" },
    typeLabel: "Type",
    publisherLabel: "Publisher",
    howTitle: "How to start",
    howSteps: ["Download Lily and sign in.", "Install this app from the marketplace in Lily, or ask Lily to install it for you.", "Describe your task in plain language."],
  },
  skills: {
    eyebrow: "Lily Skills",
    title: "Present when needed, quiet when not.",
    description: "Skills are focused ways Lily handles specific work. Describe the outcome and Lily picks the right skills.",
    searchLabel: "Search skills",
    searchPlaceholder: "Search by name or purpose",
    filterLabel: "Filter by category",
    all: "All",
    count: "{n} skills",
    noResults: "No skills match.",
    clear: "Clear filters",
    ctaTitle: "Every skill here is built into Lily",
    ctaBody: "Nothing to install or switch on. Describe your task and Lily uses them.",
    categories: { office: "Office documents", coding: "Development", research: "Research", media: "Media & creative", design: "Design & UI", quality: "Quality review" },
  },
  changelog: {
    eyebrow: "Changelog",
    title: "Every improvement to Lily.",
    description: "New versions reach your computer automatically. This is what each version brought, newest first.",
    latest: "Latest",
    required: "Required update",
    showAll: "Show all {n}",
    older: "Show {n} earlier versions",
    noNotes: "Stability and experience improvements.",
    notesLanguage: "Release notes are published in Chinese.",
    platforms: { "darwin-arm64": "macOS · Apple silicon", "darwin-x64": "macOS · Intel", "win32-x64": "Windows" },
    emptyTitle: "No releases yet",
    emptyBody: "New versions will appear here once they are published.",
    errorTitle: "The changelog could not be loaded",
    errorBody: "Try again shortly. Lily still checks for updates inside the app.",
  },
  contact: {
    eyebrow: "Contact",
    title: "A question, or bringing Lily to your team?",
    description: "Product questions, organization setup and partnerships all start here. We reply by email as soon as we can.",
    topicLabel: "Topic",
    topics: { general: "Using Lily", enterprise: "Organizations and purchasing", support: "Report a problem", partnership: "Partnership" },
    asideTitle: "Include these for a faster reply",
    asideItems: [
      ["What you want to get done", "The work or the problem you hit is more useful than which feature you used."],
      ["Team size", "For organizations, roughly how many people will use Lily, and on Mac or Windows."],
      ["How to reach you", "An email you check; a phone number too if you like."],
    ],
    emailTitle: "Or email us directly",
    helpTitle: "Check the help center first",
    helpBody: "Installing, signing in, organization budgets and other common questions are covered.",
    helpCta: "Open the help center",
    form: {
      company: "Company / team (optional)",
      phone: "Phone (optional)",
      subject: "Subject (optional)",
      success: "Received. We will reply by email as soon as we can.",
    },
  },
};

const ar = {
  apps: {
    eyebrow: "تطبيقات Lily",
    title: "مسارات عمل كاملة، جاهزة للاستخدام.",
    description: "يجمع كل تطبيق مساحة عمل ومهارات وقوالب، فتبدأ العمل فور تثبيته.",
    count: "{n} تطبيقات",
    types: { workspace: "مساحة عمل", connector: "موصل", template: "قالب", dashboard: "لوحة", tool: "أداة", agent: "وكيل" },
    plans: { free: "مجاني", personal: "شخصي", pro: "احترافي", team: "فريق", enterprise: "مؤسسات" },
    typeLabel: "النوع",
    publisherLabel: "الناشر",
    howTitle: "كيف تبدأ",
    howSteps: ["نزّل Lily وسجّل الدخول.", "ثبّت هذا التطبيق من المتجر داخل Lily، أو اطلب من Lily تثبيته.", "صف مهمتك بلغتك المعتادة."],
  },
  skills: {
    eyebrow: "مهارات Lily",
    title: "تظهر عند الحاجة، وتهدأ عند عدمها.",
    description: "المهارات طرق مركّزة تعالج بها Lily أعمالاً محددة. صف النتيجة وستختار Lily المهارات المناسبة.",
    searchLabel: "ابحث في المهارات",
    searchPlaceholder: "ابحث بالاسم أو الغرض",
    filterLabel: "التصفية حسب الفئة",
    all: "الكل",
    count: "{n} مهارة",
    noResults: "لا توجد مهارات مطابقة.",
    clear: "مسح التصفية",
    ctaTitle: "كل هذه المهارات مدمجة في Lily",
    ctaBody: "لا شيء لتثبيته أو تفعيله. صف مهمتك وستستخدمها Lily.",
    categories: { office: "مستندات المكتب", coding: "التطوير", research: "البحث", media: "الوسائط والإبداع", design: "التصميم والواجهات", quality: "مراجعة الجودة" },
  },
  changelog: {
    eyebrow: "سجل التحديثات",
    title: "كل تحسين في Lily.",
    description: "تصل الإصدارات الجديدة إلى حاسوبك تلقائياً. هنا ما قدّمه كل إصدار، الأحدث أولاً.",
    latest: "الأحدث",
    required: "تحديث إلزامي",
    showAll: "عرض الكل ({n})",
    older: "عرض {n} إصدارات أقدم",
    noNotes: "تحسينات في الثبات والتجربة.",
    notesLanguage: "تُنشر ملاحظات الإصدار باللغة الصينية.",
    platforms: { "darwin-arm64": "macOS · شريحة Apple", "darwin-x64": "macOS · Intel", "win32-x64": "Windows" },
    emptyTitle: "لا توجد إصدارات بعد",
    emptyBody: "ستظهر الإصدارات الجديدة هنا بعد نشرها.",
    errorTitle: "تعذر تحميل سجل التحديثات",
    errorBody: "حاول بعد قليل. تواصل Lily التحقق من التحديثات داخل التطبيق.",
  },
  contact: {
    eyebrow: "تواصل معنا",
    title: "لديك سؤال، أو تريد Lily لفريقك؟",
    description: "أسئلة الاستخدام وإعداد المؤسسات والشراكات تبدأ من هنا. نرد عبر البريد في أقرب وقت.",
    topicLabel: "الموضوع",
    topics: { general: "استخدام Lily", enterprise: "المؤسسات والشراء", support: "الإبلاغ عن مشكلة", partnership: "شراكة" },
    asideTitle: "اذكر هذه الأمور لرد أسرع",
    asideItems: [
      ["ما الذي تريد إنجازه", "وصف العمل أو المشكلة أنفع من ذكر الميزة التي استخدمتها."],
      ["حجم الفريق", "للمؤسسات: كم شخصاً تقريباً سيستخدم Lily، وعلى Mac أم Windows."],
      ["كيف نصل إليك", "بريد تتابعه، ورقم هاتف إن رغبت."],
    ],
    emailTitle: "أو راسلنا مباشرة",
    helpTitle: "راجع مركز المساعدة أولاً",
    helpBody: "يشرح التثبيت وتسجيل الدخول وميزانيات المؤسسات وأسئلة شائعة أخرى.",
    helpCta: "افتح مركز المساعدة",
    form: {
      company: "الشركة / الفريق (اختياري)",
      phone: "الهاتف (اختياري)",
      subject: "الموضوع (اختياري)",
      success: "تم الاستلام. سنرد عبر البريد في أقرب وقت.",
    },
  },
};

export const catalogCopy = { zh, en, ar };

export function catalogCopyFor(locale) {
  return catalogCopy[locale] || catalogCopy.zh;
}

/** "{n} 个应用" → "4 个应用". */
export function formatCount(template, n) {
  return String(template || "").replace("{n}", String(n));
}

/**
 * Releases arrive one row per platform build. The changelog shows one entry
 * per version: newest first, platforms merged, notes split into highlights at
 * line breaks or full-width / ASCII semicolons (how release notes are written).
 */
export function groupReleases(releases = []) {
  const byVersion = new Map();
  for (const release of Array.isArray(releases) ? releases : []) {
    const version = String(release?.version || "").trim();
    if (!version) continue;
    const entry = byVersion.get(version) || { version, platforms: [], notes: "", force: false, createdAt: "" };
    const platform = String(release.platform || "").trim();
    if (platform && !entry.platforms.includes(platform)) entry.platforms.push(platform);
    const notes = String(release.notes || "").trim();
    if (notes.length > entry.notes.length) entry.notes = notes;
    entry.force = entry.force || Boolean(release.force);
    const created = String(release.createdAt || "");
    if (created && (!entry.createdAt || created > entry.createdAt)) entry.createdAt = created;
    byVersion.set(version, entry);
  }
  const order = ["darwin-arm64", "darwin-x64", "win32-x64"];
  return [...byVersion.values()]
    .map((entry) => ({
      ...entry,
      platforms: entry.platforms.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)),
      highlights: entry.notes.split(/\r?\n|；|;/).map((line) => line.replace(/^[\s\-*•·]+/, "").trim()).filter(Boolean),
    }))
    .sort((a, b) => compareVersions(b.version, a.version) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/).map((part) => Number.parseInt(part, 10));
  const pb = String(b).split(/[.\-+]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const x = Number.isFinite(pa[index]) ? pa[index] : 0;
    const y = Number.isFinite(pb[index]) ? pb[index] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}
