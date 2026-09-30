// Public pricing page: copy (zh / en / ar, same keys) and the pure functions
// that shape GET /api/billing/products for it.
//
// Honesty rules the page is built on:
// - Prices and amounts come only from the server's product list. With no
//   products (production today), the page says "top-ups opening soon" and
//   never invents a number.
// - The free signup grant is real (server config accountFree*), but no public
//   endpoint reports its size, so it is described without numbers.
// - Facts about billing (identity decides who pays, org pool, weekly member
//   budgets, refunds) mirror server/src/services/wallet.js and the terms.

export const PRODUCT_GROUP_ORDER = ["membership", "token", "image_generation", "video_generation", "other"];

const LOCALE_TAG = { zh: "zh-CN", en: "en-US", ar: "ar-u-nu-latn" };

export function localeTag(locale) {
  return LOCALE_TAG[locale] || LOCALE_TAG.zh;
}

function fill(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => (values[key] ?? `{${key}}`));
}

/** Integer cents → a localized price; whole amounts drop the ".00". */
export function formatPrice(cents, currency = "CNY", locale = "zh") {
  const value = Math.trunc(Number(cents) || 0);
  const code = /^[A-Z]{3}$/.test(String(currency || "")) ? currency : "CNY";
  const digits = value % 100 === 0 ? 0 : 2;
  try {
    return new Intl.NumberFormat(localeTag(locale), {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value / 100);
  } catch {
    return `${code} ${(value / 100).toFixed(digits)}`;
  }
}

/** 1000000 → "100万" / "1M" / "1 مليون"; small numbers stay exact. */
export function formatCount(n, locale = "zh") {
  const value = Math.max(0, Math.trunc(Number(n) || 0));
  const options = value >= 10000 ? { notation: "compact", maximumFractionDigits: 1 } : {};
  return new Intl.NumberFormat(localeTag(locale), options).format(value);
}

function groupKey(product) {
  return PRODUCT_GROUP_ORDER.includes(product.resourceType) && product.resourceType !== "other" ? product.resourceType : "other";
}

function isFeatured(product) {
  const meta = product?.metadata && typeof product.metadata === "object" ? product.metadata : {};
  return Boolean(meta.featured || meta.recommended || meta.highlight);
}

/** Products → [{ key, items }] in a fixed order, empty groups dropped. */
export function groupProducts(products) {
  const list = (Array.isArray(products) ? products : []).filter(
    (item) => item && typeof item === "object" && String(item.id || "") && String(item.name || "") && Number.isFinite(Number(item.priceCents)) && Number(item.priceCents) >= 0,
  );
  return PRODUCT_GROUP_ORDER
    .map((key) => ({ key, items: list.filter((item) => groupKey(item) === key) }))
    .filter((group) => group.items.length > 0);
}

/** At most one highlighted product: the first the operator marked. */
export function featuredProductId(products) {
  const hit = (Array.isArray(products) ? products : []).find(isFeatured);
  return hit ? String(hit.id) : "";
}

export function productUnitLabel(product, locale = "zh") {
  const units = copyFor(locale).units;
  const n = formatCount(product.unitAmount, locale);
  if (product.resourceType === "token") return fill(units.token, { n });
  if (product.resourceType === "image_generation") return fill(units.image, { n });
  if (product.resourceType === "video_generation") return fill(units.video, { n });
  if (product.resourceType === "membership") return units.membership;
  return Number(product.unitAmount) > 0 ? fill(units.generic, { n }) : "";
}

export function productValidityLabel(product, locale = "zh") {
  const packs = copyFor(locale).packs;
  const durationDays = Math.round(Number(product.durationSeconds || 0) / 86400);
  if (product.resourceType === "membership" && durationDays > 0) return fill(packs.membershipDays, { n: durationDays });
  const days = durationDays > 0 ? durationDays : Math.trunc(Number(product.grantExpiresDays || 0));
  return days > 0 ? fill(packs.validityDays, { n: days }) : "";
}

export function productView(product, locale = "zh", featuredId = "") {
  return {
    id: String(product.id),
    name: String(product.name),
    description: String(product.description || ""),
    price: formatPrice(product.priceCents, product.currency, locale),
    unit: productUnitLabel(product, locale),
    validity: productValidityLabel(product, locale),
    featured: Boolean(featuredId) && String(product.id) === featuredId,
  };
}

/**
 * The page's pricing state from a publicApiGet() result.
 *   products    — real products to show (purchasable says whether a real
 *                 payment method is live right now)
 *   empty       — the server answered with no active products
 *   region      — the server refused purchases for this region (403)
 *   unavailable — timeout, network error, or any other failure
 */
export function pricingState(result, locale = "zh") {
  if (!result || !result.ok) {
    const region = result?.status === 403 || result?.code === "REGION_FEATURE_DISABLED";
    return { status: region ? "region" : "unavailable", groups: [], purchasable: false };
  }
  const data = result.data || {};
  const products = Array.isArray(data.products) ? data.products : [];
  const groups = groupProducts(products);
  if (!groups.length) return { status: "empty", groups: [], purchasable: false };
  const featuredId = featuredProductId(groups.flatMap((group) => group.items));
  const providers = Array.isArray(data.paymentProviders) ? data.paymentProviders : [];
  return {
    status: "products",
    purchasable: providers.length > 0 || data.fakePaymentsEnabled === true,
    groups: groups.map((group) => ({ key: group.key, items: group.items.map((item) => productView(item, locale, featuredId)) })),
  };
}

export const pricingCopy = {
  zh: {
    meta: { title: "价格", description: "注册即送体验额度，之后按用量充值；企业由平台开通组织与额度池。" },
    head: {
      eyebrow: "价格",
      title: "先免费用起来，再按用量付费。",
      lead: "个人注册即送体验额度，用多少充多少；团队由平台开通企业组织，统一额度池，成员按周设预算。",
    },
    personal: {
      name: "个人",
      tag: "免费开始",
      price: "免费试用",
      priceNote: "注册即送体验额度",
      desc: "适合自己用 Lily 处理文档、资料和日常工作。",
      points: [
        "macOS 与 Windows 桌面客户端",
        "注册即送体验额度，无需先付费",
        "对话按用量计费，图片与视频按次计费",
        "账单、用量和余额随时可查",
      ],
      cta: "免费下载",
      secondary: "登录或注册",
    },
    enterprise: {
      name: "企业",
      tag: "联系销售",
      price: "按需开通",
      priceNote: "由平台开通组织并充值额度池",
      desc: "适合需要统一付费、控制用量和追溯变更的团队。",
      points: [
        "平台为企业开通组织，额度池由平台充值",
        "为每位成员设置每周预算",
        "管理后台：成员、额度与用量一目了然",
        "变更记录可追溯",
        "为员工直接签发企业账号",
      ],
      cta: "联系销售",
    },
    packs: {
      eyebrow: "充值",
      title: "充值与会员",
      lead: "价格以下单时为准。购买需要登录账户，到账后桌面客户端会自动刷新额度。",
      groups: { membership: "会员", token: "对话额度", image_generation: "图片生成", video_generation: "视频生成", other: "其他" },
      buy: "去购买",
      recommended: "推荐",
      validityDays: "有效期 {n} 天",
      membershipDays: "会员 {n} 天",
      paymentSoon: "在线支付即将开放，需要购买请联系我们。",
      emptyTitle: "充值即将开放",
      emptyDesc: "在线充值正在准备中。现在注册就能使用体验额度；需要更多额度或企业方案，请联系我们。",
      regionTitle: "当前地区暂未开放在线购买",
      regionDesc: "你仍然可以下载 Lily 并使用体验额度。需要购买额度或企业方案，请联系我们。",
      unavailableTitle: "暂时读不到价格",
      unavailableDesc: "价格服务暂时没有响应，请稍后刷新。需要报价可以直接联系我们。",
      contact: "联系我们",
    },
    units: { token: "{n} token 对话额度", image: "{n} 次图片生成", video: "{n} 次视频生成", generic: "{n} 个单位", membership: "会员权益" },
    compare: {
      eyebrow: "对比",
      title: "个人与企业",
      columns: ["", "个人", "企业"],
      rows: [
        ["桌面客户端", true, true],
        ["谁来付费", "个人余额，自助充值", "企业额度池，由平台充值"],
        ["用量控制", "以余额为限", "每位成员可设每周预算"],
        ["账单与用量明细", true, true],
        ["管理后台", false, true],
        ["变更记录", false, true],
        ["企业签发账号", false, true],
        ["开通方式", "下载后注册", "联系销售开通"],
      ],
      yes: "包含",
      no: "不包含",
    },
    faq: {
      eyebrow: "常见问题",
      title: "计费是怎么回事",
      items: [
        {
          q: "怎么计费？",
          a: "对话按 token 计量——token 是模型读写文字的用量单位，问得越长、答得越长，用得越多；图片和视频按生成次数计量；也可以开通会员。每一笔充值、消费和退款都记在“我的账户 → 账单”里。",
        },
        {
          q: "用个人身份还是企业身份，由谁付费？",
          a: "由你在客户端选择的身份决定，而且只扣一方：个人身份只扣个人余额；企业身份只扣企业额度池，并受你的每周预算限制，不会动用你的个人余额。",
        },
        {
          q: "额度用完了会怎样？",
          a: "使用平台模型的新请求会暂停，并提示你充值；企业成员会看到企业额度或本周预算已用完。已经完成的工作和电脑上的文件不受影响。你也可以在设置里接入自己的模型密钥，费用由该服务商结算。",
        },
        {
          q: "可以退款吗？",
          a: "价格、额度和有效期以购买页面和订单为准。除法律另有规定或页面另有说明外，已消耗的数字服务不支持退款；重复支付会自动原路退回。",
          link: { href: "/terms#payment", label: "查看服务条款中的退款说明" },
        },
      ],
    },
  },
  en: {
    meta: { title: "Pricing", description: "Free trial credit when you sign up, then pay for what you use. Organizations are opened by the platform with a shared quota pool." },
    head: {
      eyebrow: "Pricing",
      title: "Start free. Pay for what you use.",
      lead: "Sign up and get trial credit, then top up only as you need. Teams get an organization opened by the platform, one shared quota pool, and a weekly budget per member.",
    },
    personal: {
      name: "Personal",
      tag: "Start free",
      price: "Free trial",
      priceNote: "Trial credit when you sign up",
      desc: "For using Lily on your own documents, research and everyday work.",
      points: [
        "Desktop app for macOS and Windows",
        "Trial credit on signup, no payment up front",
        "Chat billed by usage; images and videos per generation",
        "Statement, usage and balance whenever you want",
      ],
      cta: "Download free",
      secondary: "Sign in or sign up",
    },
    enterprise: {
      name: "Enterprise",
      tag: "Contact sales",
      price: "Opened for you",
      priceNote: "Organization and quota pool funded by the platform",
      desc: "For teams that need one bill, usage limits, and a record of every change.",
      points: [
        "The platform opens your organization and funds its quota pool",
        "A weekly budget for every member",
        "Admin console for members, quota and usage",
        "A history of every change",
        "Company-issued accounts for employees",
      ],
      cta: "Contact sales",
    },
    packs: {
      eyebrow: "Top up",
      title: "Top-ups and membership",
      lead: "The price at checkout is final. Buying needs a signed-in account; the desktop app refreshes your balance once payment lands.",
      groups: { membership: "Membership", token: "Chat credit", image_generation: "Image generation", video_generation: "Video generation", other: "Other" },
      buy: "Buy",
      recommended: "Recommended",
      validityDays: "Valid for {n} days",
      membershipDays: "{n}-day membership",
      paymentSoon: "Online payment opens soon. Contact us to buy now.",
      emptyTitle: "Top-ups open soon",
      emptyDesc: "Online top-ups are being prepared. Sign up now to use your trial credit; for more credit or an enterprise plan, contact us.",
      regionTitle: "Online purchase is not available in your region yet",
      regionDesc: "You can still download Lily and use your trial credit. To buy credit or an enterprise plan, contact us.",
      unavailableTitle: "Prices could not be loaded",
      unavailableDesc: "The pricing service did not respond. Refresh in a moment, or contact us for a quote.",
      contact: "Contact us",
    },
    units: { token: "{n} tokens of chat", image: "{n} image generations", video: "{n} video generations", generic: "{n} units", membership: "Membership benefits" },
    compare: {
      eyebrow: "Compare",
      title: "Personal and Enterprise",
      columns: ["", "Personal", "Enterprise"],
      rows: [
        ["Desktop app", true, true],
        ["Who pays", "Your balance, self-serve top-ups", "The organization's pool, funded by the platform"],
        ["Usage control", "Up to your balance", "Weekly budget per member"],
        ["Statement and usage detail", true, true],
        ["Admin console", false, true],
        ["Change history", false, true],
        ["Company-issued accounts", false, true],
        ["How to start", "Download and sign up", "Contact sales"],
      ],
      yes: "Included",
      no: "Not included",
    },
    faq: {
      eyebrow: "FAQ",
      title: "How billing works",
      items: [
        {
          q: "How am I billed?",
          a: "Chat is metered in tokens, the unit a model reads and writes text in: longer questions and answers use more. Images and videos are counted per generation, and membership is available too. Every top-up, charge and refund is listed under Account → Statement.",
        },
        {
          q: "Personal or organization identity: who pays?",
          a: "The identity you choose in the app decides, and only one side is charged: the personal identity uses your personal balance only; an organization identity uses only the organization's pool, within your weekly budget, and never touches your personal balance.",
        },
        {
          q: "What happens when my balance runs out?",
          a: "New requests to platform models pause and ask you to top up; organization members see that the pool or this week's budget is used up. Finished work and files on your computer are untouched. You can also connect your own model key in Settings, billed by that provider.",
        },
        {
          q: "Can I get a refund?",
          a: "Prices, credit and validity follow the purchase page and your order. Unless the law or the page says otherwise, digital services already used are not refundable; a duplicate payment is refunded automatically.",
          link: { href: "/terms#payment", label: "Read the refund terms" },
        },
      ],
    },
  },
  ar: {
    meta: { title: "الأسعار", description: "رصيد تجريبي عند التسجيل، ثم ادفع مقابل ما تستخدمه. تفتح المنصة المؤسسات مع رصيد مشترك." },
    head: {
      eyebrow: "الأسعار",
      title: "ابدأ مجاناً، وادفع مقابل ما تستخدمه.",
      lead: "سجّل واحصل على رصيد تجريبي، ثم اشحن حسب حاجتك فقط. تحصل الفرق على مؤسسة تفتحها المنصة، مع رصيد مشترك وميزانية أسبوعية لكل عضو.",
    },
    personal: {
      name: "شخصي",
      tag: "ابدأ مجاناً",
      price: "تجربة مجانية",
      priceNote: "رصيد تجريبي عند التسجيل",
      desc: "لاستخدام Lily في مستنداتك وأبحاثك وعملك اليومي.",
      points: [
        "تطبيق سطح المكتب لنظامي macOS وWindows",
        "رصيد تجريبي عند التسجيل دون دفع مسبق",
        "المحادثة حسب الاستخدام، والصور والفيديو لكل عملية توليد",
        "كشف الحساب والاستخدام والرصيد متاحة دائماً",
      ],
      cta: "تنزيل مجاني",
      secondary: "تسجيل الدخول أو إنشاء حساب",
    },
    enterprise: {
      name: "المؤسسات",
      tag: "تواصل مع المبيعات",
      price: "تُفتح لك",
      priceNote: "المؤسسة ورصيدها المشترك تموّلهما المنصة",
      desc: "للفرق التي تحتاج فاتورة واحدة وحدوداً للاستخدام وسجلاً لكل تغيير.",
      points: [
        "تفتح المنصة مؤسستك وتموّل رصيدها المشترك",
        "ميزانية أسبوعية لكل عضو",
        "لوحة إدارة للأعضاء والرصيد والاستخدام",
        "سجل لكل تغيير",
        "حسابات تصدرها الشركة للموظفين",
      ],
      cta: "تواصل مع المبيعات",
    },
    packs: {
      eyebrow: "الشحن",
      title: "الشحن والعضوية",
      lead: "السعر عند الدفع هو المعتمد. يتطلب الشراء تسجيل الدخول، ويحدّث تطبيق سطح المكتب رصيدك فور وصول الدفعة.",
      groups: { membership: "العضوية", token: "رصيد المحادثة", image_generation: "توليد الصور", video_generation: "توليد الفيديو", other: "أخرى" },
      buy: "شراء",
      recommended: "موصى به",
      validityDays: "صالح لمدة {n} يوماً",
      membershipDays: "عضوية {n} يوماً",
      paymentSoon: "الدفع الإلكتروني متاح قريباً. تواصل معنا للشراء الآن.",
      emptyTitle: "الشحن متاح قريباً",
      emptyDesc: "نجهّز الشحن الإلكتروني الآن. سجّل لتستخدم رصيدك التجريبي؛ ولمزيد من الرصيد أو خطة للمؤسسات تواصل معنا.",
      regionTitle: "الشراء الإلكتروني غير متاح في منطقتك بعد",
      regionDesc: "يمكنك تنزيل Lily واستخدام رصيدك التجريبي. لشراء رصيد أو خطة للمؤسسات تواصل معنا.",
      unavailableTitle: "تعذّر تحميل الأسعار",
      unavailableDesc: "لم تستجب خدمة الأسعار. أعد التحميل بعد قليل، أو تواصل معنا للحصول على عرض سعر.",
      contact: "تواصل معنا",
    },
    units: { token: "{n} token للمحادثة", image: "{n} عملية توليد صور", video: "{n} عملية توليد فيديو", generic: "{n} وحدة", membership: "مزايا العضوية" },
    compare: {
      eyebrow: "مقارنة",
      title: "الشخصي والمؤسسات",
      columns: ["", "شخصي", "المؤسسات"],
      rows: [
        ["تطبيق سطح المكتب", true, true],
        ["من يدفع", "رصيدك الشخصي، شحن ذاتي", "رصيد المؤسسة المشترك، تموّله المنصة"],
        ["التحكم في الاستخدام", "في حدود رصيدك", "ميزانية أسبوعية لكل عضو"],
        ["تفاصيل الكشف والاستخدام", true, true],
        ["لوحة الإدارة", false, true],
        ["سجل التغييرات", false, true],
        ["حسابات تصدرها الشركة", false, true],
        ["طريقة البدء", "نزّل التطبيق وسجّل", "تواصل مع المبيعات"],
      ],
      yes: "مشمول",
      no: "غير مشمول",
    },
    faq: {
      eyebrow: "الأسئلة الشائعة",
      title: "كيف تعمل الفوترة",
      items: [
        {
          q: "كيف تتم الفوترة؟",
          a: "تُقاس المحادثة بوحدات token، وهي الوحدة التي يقرأ بها النموذج النص ويكتبه: كلما طال السؤال والجواب زاد الاستخدام. تُحسب الصور والفيديو لكل عملية توليد، وتتوفر العضوية أيضاً. كل شحن وخصم واسترداد مسجّل في الحساب ← كشف الحساب.",
        },
        {
          q: "هوية شخصية أم هوية المؤسسة: من يدفع؟",
          a: "الهوية التي تختارها في التطبيق هي التي تحدد، ويُخصم من جهة واحدة فقط: الهوية الشخصية تستخدم رصيدك الشخصي وحده؛ وهوية المؤسسة تستخدم رصيد المؤسسة وحده ضمن ميزانيتك الأسبوعية، ولا تمس رصيدك الشخصي.",
        },
        {
          q: "ماذا يحدث عند نفاد الرصيد؟",
          a: "تتوقف الطلبات الجديدة إلى نماذج المنصة وتطلب منك الشحن؛ ويرى أعضاء المؤسسة أن الرصيد المشترك أو ميزانية هذا الأسبوع قد نفدت. العمل المنجز والملفات على جهازك لا تتأثر. يمكنك أيضاً ربط مفتاح نموذجك الخاص من الإعدادات، ويحاسبك عليه مزوّده.",
        },
        {
          q: "هل يمكن استرداد المبلغ؟",
          a: "تخضع الأسعار والرصيد والصلاحية لصفحة الشراء وطلبك. ما لم ينص القانون أو الصفحة على خلاف ذلك، لا تُسترد الخدمات الرقمية المستهلكة؛ أما الدفع المكرر فيُسترد تلقائياً.",
          link: { href: "/terms#payment", label: "اقرأ شروط الاسترداد" },
        },
      ],
    },
  },
};

export function copyFor(locale) {
  return pricingCopy[locale] || pricingCopy.zh;
}
