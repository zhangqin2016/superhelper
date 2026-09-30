// Public download page: copy (zh / en / ar, same keys) and the pure functions
// that shape release data and detect the visitor's computer.
//
// Release data comes from the same public endpoint the page always used,
// GET /api/releases/latest?platform=…&version=0.0.0 (what an up-to-date offer
// would hand a fresh install), plus GET /api/releases for the publish date of
// that same version. Either may be missing; every field degrades on its own.

export const DOWNLOAD_PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64"];

const LOCALE_TAG = { zh: "zh-CN", en: "en-US", ar: "ar-u-nu-latn" };

function tagFor(locale) {
  return LOCALE_TAG[locale] || LOCALE_TAG.zh;
}

/** 191234567 → "182.4 MB" (binary megabytes, as the old page showed). */
export function formatBytes(bytes, locale = "zh") {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  const mb = n / 1024 / 1024;
  if (mb >= 1024) return `${new Intl.NumberFormat(tagFor(locale), { maximumFractionDigits: 2 }).format(mb / 1024)} GB`;
  return `${new Intl.NumberFormat(tagFor(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(mb)} MB`;
}

/** An ISO date → "2026年9月28日" / "September 28, 2026"; formatted on the server so hydration never differs. */
export function formatReleaseDate(value, locale = "zh") {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(tagFor(locale), { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Shanghai" }).format(date);
}

export function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

/** A readable fingerprint: the first and last characters, never the full hex in the layout. */
export function shortSha(value) {
  const sha = String(value || "").toLowerCase();
  if (!sha) return "";
  return sha.length > 20 ? `${sha.slice(0, 10)}…${sha.slice(-6)}` : sha;
}

export function fileExtension(url) {
  try {
    const { pathname } = new URL(url);
    const match = /\.(dmg|zip|exe|msi|pkg)$/i.exec(decodeURIComponent(pathname));
    return match ? `.${match[1].toLowerCase()}` : "";
  } catch {
    return "";
  }
}

function safeUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

/**
 * One platform's card data, every string already localized.
 * `latest` is /api/releases/latest's body (or null), `list` /api/releases' rows.
 */
export function releaseView(platform, latest, list = [], locale = "zh") {
  const item = latest && typeof latest === "object" ? latest : {};
  const url = safeUrl(item.url);
  const version = String(item.version || "");
  const row = (Array.isArray(list) ? list : []).find((entry) => entry && entry.platform === platform && String(entry.version || "") === version);
  const sha = isSha256(item.sha256) ? String(item.sha256).toLowerCase() : "";
  return {
    platform,
    available: Boolean(url),
    url,
    version: url ? version : "",
    size: url ? formatBytes(item.sizeBytes, locale) : "",
    released: url && row ? formatReleaseDate(row.createdAt, locale) : "",
    sha: url ? sha : "",
    shaShort: url ? shortSha(sha) : "",
    ext: url ? fileExtension(url) : "",
  };
}

/**
 * What computer is this? Inputs are what a browser can tell us; the result is
 * a platform id we ship (or null) and whether the guess is certain.
 *   uaPlatform    navigator.userAgentData.platform ("macOS", "Windows", …)
 *   architecture  userAgentData high-entropy "architecture" ("arm", "x86")
 *   userAgent     navigator.userAgent
 *   gpuRenderer   WebGL UNMASKED_RENDERER, when readable
 *   maxTouchPoints navigator.maxTouchPoints (an iPad reports "Macintosh")
 *   mobile        userAgentData.mobile
 */
export function detectPlatform({ uaPlatform = "", architecture = "", userAgent = "", gpuRenderer = "", maxTouchPoints = 0, mobile = false } = {}) {
  const ua = String(userAgent || "");
  const platform = String(uaPlatform || "").toLowerCase();
  const arch = String(architecture || "").toLowerCase();
  const gpu = String(gpuRenderer || "");

  if (mobile || /android|iphone|ipod|ipad|mobile/i.test(ua) || platform === "android" || platform === "ios") {
    return { kind: "mobile", platform: null, certain: true };
  }
  const isMac = platform === "macos" || /macintosh|mac os x/i.test(ua);
  if (isMac && Number(maxTouchPoints) > 1) return { kind: "mobile", platform: null, certain: true };
  if (isMac) {
    if (arch === "arm") return { kind: "mac", platform: "darwin-arm64", certain: true };
    if (arch === "x86") return { kind: "mac", platform: "darwin-x64", certain: true };
    if (/apple m\d/i.test(gpu)) return { kind: "mac", platform: "darwin-arm64", certain: true };
    if (/intel|amd|radeon|nvidia/i.test(gpu)) return { kind: "mac", platform: "darwin-x64", certain: true };
    // Safari reports every Mac as "Intel Mac OS X" and masks the GPU; Macs sold
    // since 2020 are Apple silicon, so default to it and show how to check.
    return { kind: "mac", platform: "darwin-arm64", certain: false };
  }
  // We ship x64 for Windows; Windows on Arm runs it through emulation.
  if (platform === "windows" || /windows nt|win64|win32/i.test(ua)) return { kind: "windows", platform: "win32-x64", certain: true };
  if (platform === "linux" || platform === "chrome os" || platform === "chromeos" || /linux|cros/i.test(ua)) return { kind: "other", platform: null, certain: true };
  return { kind: "unknown", platform: null, certain: false };
}

/** Recommended first, the rest after, in the page's fixed order. */
export function orderForRecommendation(items, platform) {
  const list = Array.isArray(items) ? items : [];
  const featured = platform ? list.find((item) => item.platform === platform) || null : null;
  return { featured, others: featured ? list.filter((item) => item !== featured) : list };
}

// Terminal commands are code, identical in every language.
export const VERIFY_COMMANDS = {
  mac: "shasum -a 256 ",
  windows: "Get-FileHash -Algorithm SHA256 ",
};

export const downloadCopy = {
  zh: {
    meta: { title: "下载", description: "下载 Lily 智能工作台桌面客户端，支持 macOS（Apple 芯片、Intel 芯片）与 Windows 64 位。" },
    head: {
      eyebrow: "下载",
      title: "下载 Lily 智能工作台",
      lead: "桌面客户端自带文档处理环境，装好就能读写 Office 与 PDF 文件。新版本会在后台自动更新。",
    },
    platforms: {
      "darwin-arm64": { name: "macOS · Apple 芯片", detail: "M 系列芯片的 Mac" },
      "darwin-x64": { name: "macOS · Intel 芯片", detail: "Intel 处理器的 Mac" },
      "win32-x64": { name: "Windows · 64 位", detail: "Windows 10 与 11" },
    },
    pick: {
      recommended: "为你推荐",
      neutralTitle: "选择适合你电脑的版本",
      neutralDesc: "下面列出了所有版本，选择与你电脑一致的一项即可。",
      others: "其他版本",
      all: "所有版本",
      archHint: "不确定是哪种芯片？点屏幕左上角苹果菜单 → 关于本机，看“芯片”一栏：显示 Apple M 系列选 Apple 芯片，显示 Intel 选 Intel 芯片。",
      mobile: "Lily 是桌面应用。请在 Mac 或 Windows 电脑上打开本页下载。",
      other: "Lily 目前支持 macOS 和 Windows 电脑。",
    },
    labels: {
      version: "版本",
      size: "大小",
      released: "发布时间",
      installer: "安装包",
      sha: "SHA256 校验值",
      showFull: "完整校验值",
      copy: "复制",
      copied: "已复制",
      copyFailed: "请手动复制",
      download: "下载",
      unavailable: "暂未提供",
      unavailableNote: "这个平台的安装包正在准备中，请稍后再来，或联系我们。",
      noneTitle: "暂时读不到版本信息",
      noneDesc: "下载服务暂时没有响应，请稍后刷新。着急使用可以联系我们。",
      contact: "联系我们",
      verifyTitle: "校验下载的文件",
      verifyMac: "macOS 终端",
      verifyWindows: "Windows PowerShell",
      verifyNote: "在命令后接上下载的文件路径，输出应与上面的校验值一致。",
    },
    requirements: {
      title: "系统要求",
      items: [
        ["macOS", "macOS 12 或更高版本，Apple 芯片或 Intel 芯片"],
        ["Windows", "Windows 10 或 11，64 位"],
        ["内置环境", "安装包自带 Python 与 LibreOffice 文档环境，无需另装"],
        ["按需下载", "专业 PDF 解析、OCR 等较大的引擎，需要时再一键下载"],
        ["网络", "登录、使用云端模型和自动更新时需要联网"],
      ],
    },
    after: {
      title: "安装之后",
      steps: [
        ["打开 Lily", "Mac 上把 Lily 拖进“应用程序”文件夹后打开；Windows 上运行安装程序，完成后从开始菜单打开。"],
        ["登录或开始免费试用", "用手机号登录。新账户注册即送体验额度，不用先付费。"],
        ["创建第一个工作区", "选一个项目文件夹，把文件、截图和表格放进来，直接告诉 Lily 你要完成什么。"],
      ],
    },
    more: {
      changelog: "更新日志",
      changelogDesc: "每个版本改了什么",
      help: "帮助文档",
      helpDesc: "安装、登录与常见问题",
    },
  },
  en: {
    meta: { title: "Download", description: "Download the Lily Workbench desktop app for macOS (Apple silicon, Intel) and 64-bit Windows." },
    head: {
      eyebrow: "Download",
      title: "Download Lily Workbench",
      lead: "The desktop app ships with its own document runtime, so it reads and writes Office and PDF files right after install. New versions update in the background.",
    },
    platforms: {
      "darwin-arm64": { name: "macOS · Apple silicon", detail: "Macs with M-series chips" },
      "darwin-x64": { name: "macOS · Intel", detail: "Macs with Intel processors" },
      "win32-x64": { name: "Windows · 64-bit", detail: "Windows 10 and 11" },
    },
    pick: {
      recommended: "Recommended for you",
      neutralTitle: "Choose the version for your computer",
      neutralDesc: "Every version is listed below; pick the one that matches your computer.",
      others: "Other versions",
      all: "All versions",
      archHint: "Not sure which chip? Open the Apple menu → About This Mac and look at Chip: Apple M-series means Apple silicon, Intel means Intel.",
      mobile: "Lily is a desktop app. Open this page on a Mac or Windows computer to download it.",
      other: "Lily currently supports macOS and Windows computers.",
    },
    labels: {
      version: "Version",
      size: "Size",
      released: "Released",
      installer: "Installer",
      sha: "SHA256 checksum",
      showFull: "Full checksum",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy it manually",
      download: "Download",
      unavailable: "Not available yet",
      unavailableNote: "The installer for this platform is being prepared. Check back soon, or contact us.",
      noneTitle: "Version information could not be loaded",
      noneDesc: "The download service did not respond. Refresh in a moment, or contact us if you need it now.",
      contact: "Contact us",
      verifyTitle: "Verify your download",
      verifyMac: "macOS Terminal",
      verifyWindows: "Windows PowerShell",
      verifyNote: "Add the downloaded file's path after the command; the output should match the checksum above.",
    },
    requirements: {
      title: "System requirements",
      items: [
        ["macOS", "macOS 12 or later, Apple silicon or Intel"],
        ["Windows", "Windows 10 or 11, 64-bit"],
        ["Included", "Python and LibreOffice document runtime bundled, nothing else to install"],
        ["On demand", "Larger engines such as pro PDF parsing and OCR download in one click when needed"],
        ["Network", "Needed to sign in, use cloud models and update"],
      ],
    },
    after: {
      title: "After installing",
      steps: [
        ["Open Lily", "On a Mac, drag Lily into Applications and open it; on Windows, run the installer and open Lily from the Start menu."],
        ["Sign in or start the free trial", "Sign in with your phone number. New accounts get trial credit, no payment up front."],
        ["Create your first workspace", "Pick a project folder, put your files, screenshots and spreadsheets in it, and tell Lily what you want done."],
      ],
    },
    more: {
      changelog: "Changelog",
      changelogDesc: "What changed in each version",
      help: "Help",
      helpDesc: "Installing, signing in, and common questions",
    },
  },
  ar: {
    meta: { title: "تنزيل", description: "نزّل تطبيق Lily Workbench لسطح المكتب لنظام macOS (Apple silicon وIntel) وWindows 64 بت." },
    head: {
      eyebrow: "تنزيل",
      title: "تنزيل Lily Workbench",
      lead: "يأتي التطبيق مع بيئة المستندات الخاصة به، فيقرأ ملفات Office وPDF ويكتبها فور التثبيت. تُحدَّث الإصدارات الجديدة في الخلفية.",
    },
    platforms: {
      "darwin-arm64": { name: "macOS · Apple silicon", detail: "أجهزة Mac بشرائح M" },
      "darwin-x64": { name: "macOS · Intel", detail: "أجهزة Mac بمعالجات Intel" },
      "win32-x64": { name: "Windows · 64 بت", detail: "Windows 10 و11" },
    },
    pick: {
      recommended: "موصى به لك",
      neutralTitle: "اختر الإصدار المناسب لجهازك",
      neutralDesc: "جميع الإصدارات مدرجة أدناه؛ اختر ما يطابق جهازك.",
      others: "إصدارات أخرى",
      all: "جميع الإصدارات",
      archHint: "لست متأكداً من نوع الشريحة؟ افتح قائمة Apple ← حول هذا الـMac وانظر إلى «الشريحة»: Apple M تعني Apple silicon، وIntel تعني Intel.",
      mobile: "Lily تطبيق لسطح المكتب. افتح هذه الصفحة على جهاز Mac أو Windows لتنزيله.",
      other: "يدعم Lily حالياً أجهزة macOS وWindows.",
    },
    labels: {
      version: "الإصدار",
      size: "الحجم",
      released: "تاريخ النشر",
      installer: "ملف التثبيت",
      sha: "بصمة SHA256",
      showFull: "البصمة الكاملة",
      copy: "نسخ",
      copied: "تم النسخ",
      copyFailed: "انسخها يدوياً",
      download: "تنزيل",
      unavailable: "غير متاح بعد",
      unavailableNote: "نجهّز ملف التثبيت لهذه المنصة. عد قريباً أو تواصل معنا.",
      noneTitle: "تعذّر تحميل معلومات الإصدار",
      noneDesc: "لم تستجب خدمة التنزيل. أعد التحميل بعد قليل، أو تواصل معنا إن كنت تحتاجه الآن.",
      contact: "تواصل معنا",
      verifyTitle: "تحقق من الملف المنزَّل",
      verifyMac: "Terminal على macOS",
      verifyWindows: "PowerShell على Windows",
      verifyNote: "أضف مسار الملف المنزَّل بعد الأمر؛ يجب أن تطابق النتيجة البصمة أعلاه.",
    },
    requirements: {
      title: "متطلبات النظام",
      items: [
        ["macOS", "macOS 12 أو أحدث، Apple silicon أو Intel"],
        ["Windows", "Windows 10 أو 11، 64 بت"],
        ["مضمَّن", "بيئة مستندات Python وLibreOffice مضمّنة، لا حاجة لتثبيت شيء آخر"],
        ["عند الحاجة", "المحركات الأكبر مثل تحليل PDF المتقدم وOCR تُنزَّل بنقرة عند الحاجة"],
        ["الشبكة", "مطلوبة لتسجيل الدخول واستخدام النماذج السحابية والتحديث"],
      ],
    },
    after: {
      title: "بعد التثبيت",
      steps: [
        ["افتح Lily", "على Mac اسحب Lily إلى مجلد التطبيقات ثم افتحه؛ وعلى Windows شغّل ملف التثبيت ثم افتح Lily من قائمة ابدأ."],
        ["سجّل الدخول أو ابدأ التجربة المجانية", "سجّل الدخول برقم هاتفك. تحصل الحسابات الجديدة على رصيد تجريبي دون دفع مسبق."],
        ["أنشئ أول مساحة عمل", "اختر مجلد مشروع، وضع فيه ملفاتك ولقطات الشاشة والجداول، ثم أخبر Lily بما تريد إنجازه."],
      ],
    },
    more: {
      changelog: "سجل التحديثات",
      changelogDesc: "ما الذي تغيّر في كل إصدار",
      help: "المساعدة",
      helpDesc: "التثبيت وتسجيل الدخول والأسئلة الشائعة",
    },
  },
};

export function downloadCopyFor(locale) {
  return downloadCopy[locale] || downloadCopy.zh;
}
