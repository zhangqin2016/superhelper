// Public pricing page: copy (zh / en / ar, same keys) and the pure functions
// that shape GET /api/billing/products for it (and for /account/billing).
//
// Honesty rules the page is built on:
// - Anything that can be bought comes only from the server's product list. A
//   buy button exists only for a product the server returned, and only while a
//   real payment method is live.
// - Subscription plans (Pro / Max, resource type "plan") show the server's
//   price and weekly allowance when the product exists. When it does not, the
//   card shows the official quote sheet (QUOTE_SHEET) as a price reference,
//   labelled as such, with "opening soon" + contact instead of a buy button.
//   The weekly allowance is never invented: without a product it is described
//   without a number.
// - Enterprise seat tiers are sold by contract, so they always show the quote
//   sheet and a contact-sales link.
// - The free signup grant is real (server config accountFree*), but no public
//   endpoint reports its size, so it is described without numbers.
// - Facts about billing (identity decides who pays, org pool, weekly member
//   budgets, weekly plan allowance, renewals, refunds) mirror
//   server/src/services/wallet.js, payments/settlement.js and the terms.

export const PRODUCT_GROUP_ORDER = ["membership", "token", "image_generation", "video_generation", "other"];
export const PLAN_TIERS = ["pro", "max"];
export const PLAN_PERIODS = ["month", "year"];
export const ENTERPRISE_TIERS = ["standard", "premium"];

/**
 * The one name of the unit plans hand out and packs sell. The product counts
 * in its own credit currency (consumed at a per-model rate); change it here and
 * every page follows — copy says "{unit}" and copyFor() fills it in.
 */
export const CREDIT_UNIT = { zh: "积分", en: "credits", ar: "نقاط" };

/**
 * The official quote sheet (2026-09), in integer cents. A reference price
 * only: nothing is ever sold from these numbers — a sale needs the server's
 * product. Yearly is ten months' price.
 */
export const QUOTE_SHEET = Object.freeze({
  currency: "CNY",
  personal: Object.freeze({
    pro: Object.freeze({ month: 4900, year: 49000 }),
    max: Object.freeze({ month: 9900, year: 99000 }),
  }),
  enterprise: Object.freeze({
    standard: Object.freeze({ month: 5900, year: 59000 }),
    premium: Object.freeze({ month: 12900, year: 129000 }),
  }),
  enterpriseMinSeats: 2,
});

const LOCALE_TAG = { zh: "zh-CN", en: "en-US", ar: "ar-u-nu-latn" };

export function localeTag(locale) {
  return LOCALE_TAG[locale] || LOCALE_TAG.zh;
}

export function creditUnit(locale) {
  return CREDIT_UNIT[locale] || CREDIT_UNIT.zh;
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

/** Credits are counted exactly: 2200 → "2,200" (never "2.2K"). */
export function formatCredits(n, locale = "zh") {
  const value = Math.max(0, Math.trunc(Number(n) || 0));
  return new Intl.NumberFormat(localeTag(locale)).format(value);
}

/** "2,200 积分" / "2,200 credits". */
export function creditsLabel(n, locale = "zh") {
  return `${formatCredits(n, locale)} ${creditUnit(locale)}`;
}

/** An ISO time → a short local date and time; "" when it is not a date. */
export function formatDateTime(value, locale = "zh") {
  const date = new Date(value || "");
  if (!value || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function isValidProduct(item) {
  return Boolean(item && typeof item === "object" && String(item.id || "") && String(item.name || "") && Number.isFinite(Number(item.priceCents)) && Number(item.priceCents) >= 0);
}

export function isPlanProduct(product) {
  return String(product?.resourceType || "") === "plan";
}

function groupKey(product) {
  return PRODUCT_GROUP_ORDER.includes(product.resourceType) && product.resourceType !== "other" ? product.resourceType : "other";
}

function isFeatured(product) {
  const meta = product?.metadata && typeof product.metadata === "object" ? product.metadata : {};
  return Boolean(meta.featured || meta.recommended || meta.highlight);
}

/** Products → [{ key, items }] in a fixed order, empty groups dropped. Plans have their own section. */
export function groupProducts(products) {
  const list = (Array.isArray(products) ? products : []).filter((item) => isValidProduct(item) && !isPlanProduct(item));
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
  if (product.resourceType === "token") return fill(units.token, { n: formatCredits(product.unitAmount, locale) });
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

function livePayments(data) {
  const providers = Array.isArray(data?.paymentProviders) ? data.paymentProviders : [];
  return providers.length > 0 || data?.fakePaymentsEnabled === true;
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
  return {
    status: "products",
    purchasable: livePayments(data),
    groups: groups.map((group) => ({ key: group.key, items: group.items.map((item) => productView(item, locale, featuredId)) })),
  };
}

// ------------------------------------------------------------------- plans

/** "pro" | "max" | "" from metadata.plan (as the server's planTierOf reads it). */
export function planTierOf(product) {
  const tier = String(product?.metadata?.plan || "").trim().toLowerCase();
  return PLAN_TIERS.includes(tier) ? tier : "";
}

/**
 * "month" | "year" | "": metadata.period first; a product without one is
 * placed by its length (a month is 28–31 days, a year 360–372), anything
 * else is left out rather than guessed.
 */
export function planPeriodOf(product) {
  const period = String(product?.metadata?.period || "").trim().toLowerCase();
  if (PLAN_PERIODS.includes(period)) return period;
  const days = Number(product?.durationSeconds || 0) / 86400;
  if (days >= 360 && days <= 372) return "year";
  if (days >= 28 && days <= 31) return "month";
  return "";
}

/** Plan products → { pro: { month, year }, max: { month, year } }; the first product per slot wins (server order). */
export function groupPlanProducts(products) {
  const slots = Object.fromEntries(PLAN_TIERS.map((tier) => [tier, Object.fromEntries(PLAN_PERIODS.map((period) => [period, null]))]));
  for (const item of Array.isArray(products) ? products : []) {
    if (!isValidProduct(item) || !isPlanProduct(item)) continue;
    const tier = planTierOf(item);
    const period = planPeriodOf(item);
    if (!tier || !period || slots[tier][period]) continue;
    slots[tier][period] = item;
  }
  return slots;
}

/** How many months of the monthly price one year costs (10 on the quote sheet); 0 when it is not a saving. */
export function yearMonthsEquivalent(monthCents, yearCents) {
  const month = Number(monthCents);
  const year = Number(yearCents);
  if (!(month > 0) || !(year > 0)) return 0;
  const months = Math.round((year / month) * 10) / 10;
  return months > 0 && months < 12 ? months : 0;
}

/** Minimum enterprise order per month: the monthly seat price × the minimum seats. */
export function enterpriseMinimumCents(tier) {
  const price = QUOTE_SHEET.enterprise[tier];
  return price ? price.month * QUOTE_SHEET.enterpriseMinSeats : 0;
}

/** The weekly allowance line for a live plan product; "" when there is no product to read it from. */
export function planWeeklyLabel(product, locale = "zh") {
  if (!product) return "";
  const plans = copyFor(locale).plans;
  const units = Math.trunc(Number(product.unitAmount || 0));
  return units > 0 ? fill(plans.weekly, { n: formatCredits(units, locale) }) : plans.weeklyNone;
}

function planCell(product, tier, period, locale, payable) {
  if (product) {
    const units = Math.trunc(Number(product.unitAmount || 0));
    const days = Math.round(Number(product.durationSeconds || 0) / 86400);
    return {
      source: "product",
      id: String(product.id),
      name: String(product.name),
      description: String(product.description || ""),
      priceCents: Math.trunc(Number(product.priceCents)),
      price: formatPrice(product.priceCents, product.currency, locale),
      weeklyUnits: units,
      weekly: planWeeklyLabel(product, locale),
      days,
      buyable: Boolean(payable),
    };
  }
  const cents = QUOTE_SHEET.personal[tier][period];
  return { source: "quote", id: "", name: "", description: "", priceCents: cents, price: formatPrice(cents, QUOTE_SHEET.currency, locale), weeklyUnits: null, weekly: "", days: 0, buyable: false };
}

/**
 * Pro / Max for the pricing page from the same publicApiGet() result.
 *   status "live"  — at least one plan product exists; missing slots fall
 *                    back to the quote sheet, never to a buy button
 *   status "quote" — no plan product (or no answer): quote-sheet prices only
 * A cell is buyable only when it is a real product AND a payment method is live.
 */
export function plansState(result, locale = "zh") {
  const data = result?.ok ? result.data || {} : {};
  const slots = groupPlanProducts(result?.ok ? data.products : []);
  const live = PLAN_TIERS.some((tier) => PLAN_PERIODS.some((period) => slots[tier][period]));
  const payable = Boolean(result?.ok) && livePayments(data);
  const tiers = PLAN_TIERS.map((tier) => {
    const month = planCell(slots[tier].month, tier, "month", locale, payable);
    const year = planCell(slots[tier].year, tier, "year", locale, payable);
    return { tier, featured: tier === "max", month, year, yearMonths: yearMonthsEquivalent(month.priceCents, year.priceCents) };
  });
  return { status: live ? "live" : "quote", purchasable: live && payable, tiers };
}

/** The two enterprise seat tiers, always from the quote sheet (sold by contract). */
export function enterpriseTiers(locale = "zh") {
  return ENTERPRISE_TIERS.map((tier) => {
    const price = QUOTE_SHEET.enterprise[tier];
    return {
      tier,
      month: formatPrice(price.month, QUOTE_SHEET.currency, locale),
      year: formatPrice(price.year, QUOTE_SHEET.currency, locale),
      minimum: formatPrice(enterpriseMinimumCents(tier), QUOTE_SHEET.currency, locale),
      minSeats: QUOTE_SHEET.enterpriseMinSeats,
    };
  });
}

/**
 * Plan products for /account/billing, Pro before Max and month before year,
 * each with what the buyer needs to choose: period, length, weekly allowance.
 */
export function accountPlanProducts(products, locale = "zh") {
  const list = (Array.isArray(products) ? products : []).filter((item) => isValidProduct(item) && isPlanProduct(item) && planTierOf(item));
  const rank = (item) => PLAN_TIERS.indexOf(planTierOf(item)) * 10 + Math.max(0, PLAN_PERIODS.indexOf(planPeriodOf(item)));
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => ({
      id: String(item.id),
      name: String(item.name),
      description: String(item.description || ""),
      tier: planTierOf(item),
      period: planPeriodOf(item),
      price: formatPrice(item.priceCents, item.currency, locale),
      days: Math.round(Number(item.durationSeconds || 0) / 86400),
      weekly: planWeeklyLabel(item, locale),
    }));
}

/** The signed-in user's current plan (entitlements.plan) for display, or null. */
export function currentPlanView(plan, locale = "zh") {
  if (!plan || typeof plan !== "object") return null;
  const tier = String(plan.tier || "");
  if (!tier) return null;
  const account = copyFor(locale).account;
  const hasWeek = Number(plan.weeklyUnits || 0) > 0 && plan.weekRemaining !== undefined && plan.weekRemaining !== null;
  return {
    tier,
    name: account.tiers[tier] || tier,
    expiresAt: formatDateTime(plan.expiresAt, locale),
    weekly: Number(plan.weeklyUnits || 0) > 0 ? creditsLabel(plan.weeklyUnits, locale) : "",
    weekRemaining: hasWeek ? creditsLabel(plan.weekRemaining, locale) : "",
    weekResetsAt: hasWeek ? formatDateTime(plan.weekResetsAt, locale) : "",
  };
}

// Copy. "{unit}" is the credit unit (CREDIT_UNIT), filled in by copyFor();
// "{n}", "{price}", "{date}" are filled where the number is known.
export const pricingCopy = {
  zh: {
    meta: { title: "价格", description: "注册即送体验额度；个人订阅 Lily Pro 或 Lily Max，按月或按年付费；企业按席位订阅。" },
    head: {
      eyebrow: "价格",
      title: "先免费用起来，需要更多就订阅。",
      lead: "个人注册即送体验额度。自带模型选 Pro，开箱即用选 Max；团队按席位订阅企业版，统一管理成员与用量。",
    },
    personal: {
      name: "免费试用",
      tag: "免费开始",
      price: "免费试用",
      priceNote: "注册即送体验额度",
      desc: "先试试 Lily 能不能帮你处理文档、资料和日常工作。",
      points: [
        "macOS 与 Windows 桌面客户端",
        "注册即送体验额度，无需先付费",
        "随时升级到 Pro 或 Max",
        "账单、用量和余额随时可查",
      ],
      cta: "免费下载",
      secondary: "登录或注册",
    },
    plans: {
      eyebrow: "个人订阅",
      title: "选一个适合你的方案",
      lead: "按月或按年付费，年付更省。同一方案再次购买，有效期接着顺延。",
      periodLegend: "付费周期",
      month: "月付",
      year: "年付",
      yearHint: "相当于 {n} 个月的价格",
      perMonth: "/账号/月",
      perYear: "/账号/年",
      recommended: "推荐",
      buy: "立即订阅",
      soon: "即将开放",
      soonNote: "在线订阅即将开放，现在可以联系我们开通。",
      paymentSoon: "在线支付即将开放，需要订阅请联系我们。",
      quoteLabel: "官方报价",
      contact: "联系我们",
      weekly: "每周 {n} {unit}",
      weeklyNone: "不含官方{unit}，使用自己的模型接口",
      periodDays: "每期 {n} 天",
      tiers: {
        pro: {
          name: "Lily Pro",
          tag: "自备模型",
          desc: "已经有自己的模型接口，想用上 Lily 的全部个人功能。",
          points: ["自备模型接口（自接 API Key）", "个人版基础功能全部支持"],
          excludes: ["官方内置智能体"],
        },
        max: {
          name: "Lily Max",
          tag: "开箱即用",
          desc: "不想配置模型，打开就能用官方模型完成工作。",
          points: ["开箱即用：官方模型，也可自接", "含官方内置智能体", "{unit}按周发放、每周重置", "不同模型按各自价格消耗{unit}，价格表见帮助与价格页"],
          excludes: [],
        },
      },
    },
    enterprisePlans: {
      eyebrow: "企业",
      title: "企业订阅，按席位计费",
      lead: "企业控制台统一管理成员与用量，{unit}池在企业内共享。",
      perSeatMonth: "/席位/月",
      perSeatYear: "/席位/年",
      yearly: "年付 {price}",
      minSeats: "{n} 席起",
      minOrder: "最低 {price}/月",
      cta: "联系销售",
      tiers: {
        standard: {
          name: "企业标准版",
          tag: "自接模型",
          points: ["自接 API Key", "企业控制台", "{unit}池共享", "按周发放 · 企业内池化"],
          excludes: ["官方内置智能体"],
        },
        premium: {
          name: "企业高级版",
          tag: "官方模型",
          points: ["官方模型，也可自接", "含官方内置智能体", "企业控制台", "{unit}池共享"],
          excludes: [],
        },
      },
      privateNote: "私有化部署与定制服务按项目单独评估报价。",
      legalNote: "本页为对外报价说明，具体条款以正式合同为准。",
    },
    packs: {
      eyebrow: "单独购买",
      title: "{unit}与会员",
      lead: "价格以下单时为准。购买需要登录账户，到账后桌面客户端会自动刷新余额。",
      groups: { membership: "会员", token: "{unit}", image_generation: "图片生成", video_generation: "视频生成", other: "其他" },
      buy: "去购买",
      recommended: "推荐",
      validityDays: "有效期 {n} 天",
      membershipDays: "会员 {n} 天",
      paymentSoon: "在线支付即将开放，需要购买请联系我们。",
      emptyTitle: "单独购买即将开放",
      emptyDesc: "在线购买正在准备中。现在注册就能使用体验额度；需要更多额度或企业方案，请联系我们。",
      regionTitle: "当前地区暂未开放在线购买",
      regionDesc: "你仍然可以下载 Lily 并使用体验额度。需要购买额度或企业方案，请联系我们。",
      unavailableTitle: "暂时读不到价格",
      unavailableDesc: "价格服务暂时没有响应，请稍后刷新。需要报价可以直接联系我们。",
      contact: "联系我们",
    },
    units: { token: "{n} {unit}", image: "{n} 次图片生成", video: "{n} 次视频生成", generic: "{n} 个单位", membership: "会员权益" },
    compare: {
      eyebrow: "对比",
      title: "方案对比",
      columns: ["方案", "价格", "模型", "官方内置智能体", "{unit}", "企业控制台", "起购"],
      rows: {
        pro: ["自接 API Key", false, "按周发放、每周重置", false, "1 个账号"],
        max: ["官方模型，也可自接", true, "按周发放、每周重置", false, "1 个账号"],
        standard: ["自接 API Key", false, "按周发放 · 企业内池化", true, "{n} 席起"],
        premium: ["官方模型，也可自接", true, "企业内{unit}池共享", true, "{n} 席起"],
      },
      yes: "包含",
      no: "不包含",
    },
    faq: {
      eyebrow: "常见问题",
      title: "计费是怎么回事",
      items: [
        {
          q: "怎么计费？",
          a: "个人可以订阅 Lily Pro 或 Lily Max，按月或按年付费，也可以单独购买{unit}。使用官方模型时消耗{unit}：不同模型按各自价格消耗{unit}，价格表见帮助与价格页；图片和视频按生成次数计量。每一笔购买、消耗和退款都记在“我的账户 → 账单”里。",
        },
        {
          q: "“按周发放、每周重置”是什么意思？",
          a: "从订阅生效那一刻起，每 7 天算一周：每周开始时发放当周的{unit}，本周没用完的不会累积到下周。有效期的最后一周在到期时截止。",
        },
        {
          q: "续费和年付怎么算？",
          a: "同一方案再次购买，会接在当前有效期之后顺延，提前续费不会损失天数。年付一次买一年，价格相当于 10 个月。",
        },
        {
          q: "用个人身份还是企业身份，由谁付费？",
          a: "由你在客户端选择的身份决定，而且只扣一方：个人身份只用你的个人订阅和个人余额；企业身份只扣企业{unit}池，并受你的每周预算限制，不会动用你的个人订阅和余额。",
        },
        {
          q: "{unit}用完了会怎样？",
          a: "使用官方模型的新请求会暂停，并提示你续订或购买{unit}；Max 会在下一周开始时发放新的{unit}；企业成员会看到企业{unit}池或本周预算已用完。已经完成的工作和电脑上的文件不受影响。你也可以在设置里接入自己的模型密钥，费用由该服务商结算。",
        },
        {
          q: "可以退款吗？",
          a: "价格、{unit}和有效期以购买页面和订单为准。除法律另有规定或页面另有说明外，已消耗的数字服务不支持退款；重复支付会自动原路退回。",
          link: { href: "/terms#payment", label: "查看服务条款中的退款说明" },
        },
      ],
    },
    account: {
      title: "订阅方案",
      lead: "Pro 与 Max 按月或按年订阅。同一方案再次购买，有效期会接在当前有效期之后顺延。",
      current: "当前方案",
      none: "你还没有订阅方案。",
      signIn: "登录后可以看到你的当前方案。",
      signInLink: "去登录",
      unavailable: "暂时读不到你的方案，请稍后刷新。",
      expiresAt: "有效期至",
      weekly: "每周发放",
      weekRemaining: "本周剩余",
      weekResetsAt: "重置时间",
      month: "月付",
      year: "年付",
      periodDays: "每期 {n} 天",
      buy: "订阅",
      renew: "续费",
      extendNote: "现在续费，新的一期从 {date} 开始。",
      empty: "暂无可订阅的方案。管理员在后台添加订阅方案后会显示在这里。",
      tiers: { pro: "Lily Pro", max: "Lily Max" },
    },
  },
  en: {
    meta: { title: "Pricing", description: "Trial credit when you sign up; subscribe to Lily Pro or Lily Max monthly or yearly; organizations subscribe per seat." },
    head: {
      eyebrow: "Pricing",
      title: "Start free. Subscribe when you need more.",
      lead: "Sign up and get trial credit. Bring your own model with Pro, or use it out of the box with Max; teams subscribe per seat and manage members and usage in one place.",
    },
    personal: {
      name: "Free trial",
      tag: "Start free",
      price: "Free trial",
      priceNote: "Trial credit when you sign up",
      desc: "See whether Lily handles your documents, research and everyday work.",
      points: [
        "Desktop app for macOS and Windows",
        "Trial credit on signup, no payment up front",
        "Upgrade to Pro or Max at any time",
        "Statement, usage and balance whenever you want",
      ],
      cta: "Download free",
      secondary: "Sign in or sign up",
    },
    plans: {
      eyebrow: "Personal plans",
      title: "Choose the plan that fits",
      lead: "Pay monthly or yearly; yearly costs less. Buying the same plan again extends it.",
      periodLegend: "Billing period",
      month: "Monthly",
      year: "Yearly",
      yearHint: "The price of {n} months",
      perMonth: "/account/month",
      perYear: "/account/year",
      recommended: "Recommended",
      buy: "Subscribe",
      soon: "Opening soon",
      soonNote: "Online subscription opens soon. Contact us to start now.",
      paymentSoon: "Online payment opens soon. Contact us to subscribe now.",
      quoteLabel: "List price",
      contact: "Contact us",
      weekly: "{n} {unit} every week",
      weeklyNone: "No platform {unit}; use your own model API",
      periodDays: "{n} days per period",
      tiers: {
        pro: {
          name: "Lily Pro",
          tag: "Bring your model",
          desc: "You already have a model API and want every personal feature of Lily.",
          points: ["Bring your own model API (your API key)", "Every basic personal feature"],
          excludes: ["Built-in official agents"],
        },
        max: {
          name: "Lily Max",
          tag: "Ready to use",
          desc: "No model setup: open Lily and work with the official models.",
          points: ["Ready to use: official models, or bring your own", "Built-in official agents", "{unit} are issued weekly and reset every week", "Each model uses {unit} at its own rate; see the price list in Help and on this page"],
          excludes: [],
        },
      },
    },
    enterprisePlans: {
      eyebrow: "Enterprise",
      title: "Enterprise plans, priced per seat",
      lead: "An enterprise console for members and usage, with {unit} pooled across the organization.",
      perSeatMonth: "/seat/month",
      perSeatYear: "/seat/year",
      yearly: "{price} billed yearly",
      minSeats: "From {n} seats",
      minOrder: "From {price}/month",
      cta: "Contact sales",
      tiers: {
        standard: {
          name: "Enterprise Standard",
          tag: "Bring your model",
          points: ["Your own API key", "Enterprise console", "Shared {unit} pool", "Issued weekly, pooled within the organization"],
          excludes: ["Built-in official agents"],
        },
        premium: {
          name: "Enterprise Premium",
          tag: "Official models",
          points: ["Official models, or bring your own", "Built-in official agents", "Enterprise console", "Shared {unit} pool"],
          excludes: [],
        },
      },
      privateNote: "Private deployment and custom services are quoted per project.",
      legalNote: "This page is a public price guide; the formal contract governs the terms.",
    },
    packs: {
      eyebrow: "Buy separately",
      title: "{unit} and membership",
      lead: "The price at checkout is final. Buying needs a signed-in account; the desktop app refreshes your balance once payment lands.",
      groups: { membership: "Membership", token: "{unit}", image_generation: "Image generation", video_generation: "Video generation", other: "Other" },
      buy: "Buy",
      recommended: "Recommended",
      validityDays: "Valid for {n} days",
      membershipDays: "{n}-day membership",
      paymentSoon: "Online payment opens soon. Contact us to buy now.",
      emptyTitle: "Separate purchases open soon",
      emptyDesc: "Online purchase is being prepared. Sign up now to use your trial credit; for more credit or an enterprise plan, contact us.",
      regionTitle: "Online purchase is not available in your region yet",
      regionDesc: "You can still download Lily and use your trial credit. To buy credit or an enterprise plan, contact us.",
      unavailableTitle: "Prices could not be loaded",
      unavailableDesc: "The pricing service did not respond. Refresh in a moment, or contact us for a quote.",
      contact: "Contact us",
    },
    units: { token: "{n} {unit}", image: "{n} image generations", video: "{n} video generations", generic: "{n} units", membership: "Membership benefits" },
    compare: {
      eyebrow: "Compare",
      title: "Compare plans",
      columns: ["Plan", "Price", "Models", "Built-in official agents", "{unit}", "Enterprise console", "Minimum"],
      rows: {
        pro: ["Your own API key", false, "Issued weekly, reset every week", false, "1 account"],
        max: ["Official models, or your own", true, "Issued weekly, reset every week", false, "1 account"],
        standard: ["Your own API key", false, "Issued weekly, pooled within the organization", true, "From {n} seats"],
        premium: ["Official models, or your own", true, "Shared {unit} pool in the organization", true, "From {n} seats"],
      },
      yes: "Included",
      no: "Not included",
    },
    faq: {
      eyebrow: "FAQ",
      title: "How billing works",
      items: [
        {
          q: "How am I billed?",
          a: "You can subscribe to Lily Pro or Lily Max, monthly or yearly, or buy {unit} separately. Official models use {unit}: each model at its own rate, listed in Help and on this page. Images and videos are counted per generation. Every purchase, charge and refund is listed under Account → Statement.",
        },
        {
          q: "What does “issued weekly, reset every week” mean?",
          a: "From the moment your plan starts, every 7 days is a week: each week begins with that week's {unit}, and what you do not use does not carry over. The last week ends when the plan does.",
        },
        {
          q: "How do renewals and yearly billing work?",
          a: "Buying the same plan again adds a new period after the current one ends, so renewing early never loses days. Yearly billing buys a year at the price of 10 months.",
        },
        {
          q: "Personal or organization identity: who pays?",
          a: "The identity you choose in the app decides, and only one side is charged: the personal identity uses only your personal plan and balance; an organization identity uses only the organization's {unit} pool, within your weekly budget, and never touches your personal plan or balance.",
        },
        {
          q: "What happens when my {unit} run out?",
          a: "New requests to official models pause and ask you to renew or buy {unit}; Max issues new {unit} when the next week begins; organization members see that the pool or this week's budget is used up. Finished work and files on your computer are untouched. You can also connect your own model key in Settings, billed by that provider.",
        },
        {
          q: "Can I get a refund?",
          a: "Prices, {unit} and validity follow the purchase page and your order. Unless the law or the page says otherwise, digital services already used are not refundable; a duplicate payment is refunded automatically.",
          link: { href: "/terms#payment", label: "Read the refund terms" },
        },
      ],
    },
    account: {
      title: "Plans",
      lead: "Subscribe to Pro or Max monthly or yearly. Buying the same plan again adds a new period after the current one ends.",
      current: "Your plan",
      none: "You do not have a plan yet.",
      signIn: "Sign in to see your current plan.",
      signInLink: "Sign in",
      unavailable: "Your plan could not be loaded. Refresh in a moment.",
      expiresAt: "Valid until",
      weekly: "Every week",
      weekRemaining: "Left this week",
      weekResetsAt: "Resets",
      month: "Monthly",
      year: "Yearly",
      periodDays: "{n} days per period",
      buy: "Subscribe",
      renew: "Renew",
      extendNote: "Renew now and the new period starts {date}.",
      empty: "No plans are on sale yet. They appear here once an administrator adds them.",
      tiers: { pro: "Lily Pro", max: "Lily Max" },
    },
  },
  ar: {
    meta: { title: "الأسعار", description: "رصيد تجريبي عند التسجيل؛ اشترك في Lily Pro أو Lily Max شهرياً أو سنوياً؛ وتشترك المؤسسات لكل مقعد." },
    head: {
      eyebrow: "الأسعار",
      title: "ابدأ مجاناً، واشترك حين تحتاج المزيد.",
      lead: "سجّل واحصل على رصيد تجريبي. استخدم نموذجك الخاص مع Pro، أو ابدأ فوراً مع Max؛ وتشترك الفرق لكل مقعد وتدير الأعضاء والاستخدام من مكان واحد.",
    },
    personal: {
      name: "تجربة مجانية",
      tag: "ابدأ مجاناً",
      price: "تجربة مجانية",
      priceNote: "رصيد تجريبي عند التسجيل",
      desc: "جرّب إن كان Lily يساعدك في مستنداتك وأبحاثك وعملك اليومي.",
      points: [
        "تطبيق سطح المكتب لنظامي macOS وWindows",
        "رصيد تجريبي عند التسجيل دون دفع مسبق",
        "الترقية إلى Pro أو Max في أي وقت",
        "كشف الحساب والاستخدام والرصيد متاحة دائماً",
      ],
      cta: "تنزيل مجاني",
      secondary: "تسجيل الدخول أو إنشاء حساب",
    },
    plans: {
      eyebrow: "الخطط الشخصية",
      title: "اختر الخطة المناسبة لك",
      lead: "ادفع شهرياً أو سنوياً، والدفع السنوي أوفر. شراء الخطة نفسها مرة أخرى يمدّد صلاحيتها.",
      periodLegend: "فترة الدفع",
      month: "شهري",
      year: "سنوي",
      yearHint: "بسعر {n} أشهر",
      perMonth: "/حساب/شهر",
      perYear: "/حساب/سنة",
      recommended: "موصى به",
      buy: "اشترك الآن",
      soon: "متاح قريباً",
      soonNote: "الاشتراك الإلكتروني متاح قريباً. تواصل معنا لتبدأ الآن.",
      paymentSoon: "الدفع الإلكتروني متاح قريباً. تواصل معنا للاشتراك الآن.",
      quoteLabel: "السعر الرسمي",
      contact: "تواصل معنا",
      weekly: "{n} {unit} كل أسبوع",
      weeklyNone: "بلا {unit} من المنصة؛ استخدم واجهة نموذجك الخاص",
      periodDays: "{n} يوماً لكل فترة",
      tiers: {
        pro: {
          name: "Lily Pro",
          tag: "نموذجك الخاص",
          desc: "لديك واجهة نموذج خاصة وتريد كل الميزات الشخصية في Lily.",
          points: ["واجهة نموذجك الخاص (مفتاح API خاص بك)", "كل الميزات الأساسية للنسخة الشخصية"],
          excludes: ["الوكلاء الرسميون المدمجون"],
        },
        max: {
          name: "Lily Max",
          tag: "جاهز للاستخدام",
          desc: "بلا إعداد للنماذج: افتح Lily واعمل بالنماذج الرسمية مباشرة.",
          points: ["جاهز للاستخدام: نماذج رسمية، أو نموذجك الخاص", "الوكلاء الرسميون المدمجون", "تُمنح {unit} أسبوعياً وتتجدد كل أسبوع", "يستهلك كل نموذج {unit} بسعره الخاص؛ راجع قائمة الأسعار في المساعدة وفي هذه الصفحة"],
          excludes: [],
        },
      },
    },
    enterprisePlans: {
      eyebrow: "المؤسسات",
      title: "خطط المؤسسات، بالسعر لكل مقعد",
      lead: "لوحة تحكم للمؤسسة لإدارة الأعضاء والاستخدام، مع {unit} مشتركة داخل المؤسسة.",
      perSeatMonth: "/مقعد/شهر",
      perSeatYear: "/مقعد/سنة",
      yearly: "{price} عند الدفع السنوي",
      minSeats: "من {n} مقاعد",
      minOrder: "ابتداءً من {price}/شهر",
      cta: "تواصل مع المبيعات",
      tiers: {
        standard: {
          name: "المؤسسات القياسية",
          tag: "نموذجك الخاص",
          points: ["مفتاح API خاص بك", "لوحة تحكم المؤسسة", "رصيد {unit} مشترك", "تُمنح أسبوعياً وتُجمع داخل المؤسسة"],
          excludes: ["الوكلاء الرسميون المدمجون"],
        },
        premium: {
          name: "المؤسسات المتقدمة",
          tag: "نماذج رسمية",
          points: ["نماذج رسمية، أو نموذجك الخاص", "الوكلاء الرسميون المدمجون", "لوحة تحكم المؤسسة", "رصيد {unit} مشترك"],
          excludes: [],
        },
      },
      privateNote: "النشر الخاص والخدمات المخصصة تُسعَّر لكل مشروع على حدة.",
      legalNote: "هذه الصفحة دليل أسعار عام؛ والعقد الرسمي هو المرجع في الشروط.",
    },
    packs: {
      eyebrow: "شراء منفصل",
      title: "{unit} والعضوية",
      lead: "السعر عند الدفع هو المعتمد. يتطلب الشراء تسجيل الدخول، ويحدّث تطبيق سطح المكتب رصيدك فور وصول الدفعة.",
      groups: { membership: "العضوية", token: "{unit}", image_generation: "توليد الصور", video_generation: "توليد الفيديو", other: "أخرى" },
      buy: "شراء",
      recommended: "موصى به",
      validityDays: "صالح لمدة {n} يوماً",
      membershipDays: "عضوية {n} يوماً",
      paymentSoon: "الدفع الإلكتروني متاح قريباً. تواصل معنا للشراء الآن.",
      emptyTitle: "الشراء المنفصل متاح قريباً",
      emptyDesc: "نجهّز الشراء الإلكتروني الآن. سجّل لتستخدم رصيدك التجريبي؛ ولمزيد من الرصيد أو خطة للمؤسسات تواصل معنا.",
      regionTitle: "الشراء الإلكتروني غير متاح في منطقتك بعد",
      regionDesc: "يمكنك تنزيل Lily واستخدام رصيدك التجريبي. لشراء رصيد أو خطة للمؤسسات تواصل معنا.",
      unavailableTitle: "تعذّر تحميل الأسعار",
      unavailableDesc: "لم تستجب خدمة الأسعار. أعد التحميل بعد قليل، أو تواصل معنا للحصول على عرض سعر.",
      contact: "تواصل معنا",
    },
    units: { token: "{n} {unit}", image: "{n} عملية توليد صور", video: "{n} عملية توليد فيديو", generic: "{n} وحدة", membership: "مزايا العضوية" },
    compare: {
      eyebrow: "مقارنة",
      title: "مقارنة الخطط",
      columns: ["الخطة", "السعر", "النماذج", "الوكلاء الرسميون المدمجون", "{unit}", "لوحة تحكم المؤسسة", "الحد الأدنى"],
      rows: {
        pro: ["مفتاح API خاص بك", false, "تُمنح أسبوعياً وتتجدد كل أسبوع", false, "حساب واحد"],
        max: ["نماذج رسمية، أو نموذجك الخاص", true, "تُمنح أسبوعياً وتتجدد كل أسبوع", false, "حساب واحد"],
        standard: ["مفتاح API خاص بك", false, "تُمنح أسبوعياً وتُجمع داخل المؤسسة", true, "من {n} مقاعد"],
        premium: ["نماذج رسمية، أو نموذجك الخاص", true, "رصيد {unit} مشترك داخل المؤسسة", true, "من {n} مقاعد"],
      },
      yes: "مشمول",
      no: "غير مشمول",
    },
    faq: {
      eyebrow: "الأسئلة الشائعة",
      title: "كيف تعمل الفوترة",
      items: [
        {
          q: "كيف تتم الفوترة؟",
          a: "يمكنك الاشتراك في Lily Pro أو Lily Max شهرياً أو سنوياً، أو شراء {unit} بشكل منفصل. تستهلك النماذج الرسمية {unit}: كل نموذج بسعره الخاص، والقائمة في المساعدة وفي هذه الصفحة. تُحسب الصور والفيديو لكل عملية توليد. كل شراء وخصم واسترداد مسجّل في الحساب ← كشف الحساب.",
        },
        {
          q: "ماذا يعني «تُمنح أسبوعياً وتتجدد كل أسبوع»؟",
          a: "منذ لحظة بدء خطتك، كل 7 أيام أسبوع: يبدأ كل أسبوع بـ{unit} ذلك الأسبوع، وما لا تستخدمه لا يُرحَّل إلى الأسبوع التالي. وينتهي الأسبوع الأخير بانتهاء الخطة.",
        },
        {
          q: "كيف يعمل التجديد والدفع السنوي؟",
          a: "شراء الخطة نفسها مرة أخرى يضيف فترة جديدة بعد انتهاء الفترة الحالية، فلا يضيع أي يوم عند التجديد المبكر. والدفع السنوي يمنحك سنة بسعر 10 أشهر.",
        },
        {
          q: "هوية شخصية أم هوية المؤسسة: من يدفع؟",
          a: "الهوية التي تختارها في التطبيق هي التي تحدد، ويُخصم من جهة واحدة فقط: الهوية الشخصية تستخدم خطتك ورصيدك الشخصيين وحدهما؛ وهوية المؤسسة تستخدم رصيد {unit} المشترك للمؤسسة وحده ضمن ميزانيتك الأسبوعية، ولا تمس خطتك أو رصيدك الشخصيين.",
        },
        {
          q: "ماذا يحدث عند نفاد {unit}؟",
          a: "تتوقف الطلبات الجديدة إلى النماذج الرسمية وتطلب منك التجديد أو شراء {unit}؛ ويمنح Max {unit} جديدة عند بداية الأسبوع التالي؛ ويرى أعضاء المؤسسة أن الرصيد المشترك أو ميزانية هذا الأسبوع قد نفدت. العمل المنجز والملفات على جهازك لا تتأثر. يمكنك أيضاً ربط مفتاح نموذجك الخاص من الإعدادات، ويحاسبك عليه مزوّده.",
        },
        {
          q: "هل يمكن استرداد المبلغ؟",
          a: "تخضع الأسعار و{unit} والصلاحية لصفحة الشراء وطلبك. ما لم ينص القانون أو الصفحة على خلاف ذلك، لا تُسترد الخدمات الرقمية المستهلكة؛ أما الدفع المكرر فيُسترد تلقائياً.",
          link: { href: "/terms#payment", label: "اقرأ شروط الاسترداد" },
        },
      ],
    },
    account: {
      title: "الخطط",
      lead: "اشترك في Pro أو Max شهرياً أو سنوياً. شراء الخطة نفسها مرة أخرى يضيف فترة جديدة بعد انتهاء الفترة الحالية.",
      current: "خطتك",
      none: "ليست لديك خطة بعد.",
      signIn: "سجّل الدخول لترى خطتك الحالية.",
      signInLink: "تسجيل الدخول",
      unavailable: "تعذّر تحميل خطتك. أعد التحميل بعد قليل.",
      expiresAt: "صالحة حتى",
      weekly: "كل أسبوع",
      weekRemaining: "المتبقي هذا الأسبوع",
      weekResetsAt: "التجديد",
      month: "شهري",
      year: "سنوي",
      periodDays: "{n} يوماً لكل فترة",
      buy: "اشترك",
      renew: "جدّد",
      extendNote: "إذا جدّدت الآن تبدأ الفترة الجديدة في {date}.",
      empty: "لا توجد خطط معروضة بعد. ستظهر هنا بعد أن يضيفها المسؤول.",
      tiers: { pro: "Lily Pro", max: "Lily Max" },
    },
  },
};

function fillUnit(value, unit) {
  if (typeof value === "string") return value.replace(/\{unit\}/g, unit);
  if (Array.isArray(value)) return value.map((item) => fillUnit(item, unit));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, fillUnit(nested, unit)]));
  return value;
}

const filled = new Map();

/** The copy for a locale with the credit unit filled in. */
export function copyFor(locale) {
  const key = pricingCopy[locale] ? locale : "zh";
  if (!filled.has(key)) filled.set(key, fillUnit(pricingCopy[key], creditUnit(key)));
  return filled.get(key);
}
