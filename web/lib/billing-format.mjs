// One vocabulary for money and orders across the account and admin pages.

export function formatMoney(cents, currency = "CNY") {
  const value = Math.trunc(Number(cents || 0));
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${currency === "CNY" ? "¥" : `${currency} `}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export const ORDER_STATUS = {
  pending: { label: "待支付", tone: "amber" },
  paid: { label: "已支付", tone: "emerald" },
  closed: { label: "已关闭", tone: "slate" },
  partially_refunded: { label: "部分退款", tone: "sky" },
  refunded: { label: "已退款", tone: "slate" },
};

export function orderStatusLabel(status) {
  return ORDER_STATUS[status]?.label || status || "未知";
}

export const TONE_CLASS = {
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
  rose: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function unitLabel({ resourceType, unitAmount }) {
  const n = Number(unitAmount || 0).toLocaleString("zh-CN");
  if (resourceType === "token") return `${n} tokens`;
  if (resourceType === "image_generation") return `${n} 次图片生成`;
  if (resourceType === "video_generation") return `${n} 次视频生成`;
  if (resourceType === "membership") return "会员权益";
  return `${n} 单位`;
}

export function resourceUnits(resourceType, units) {
  const n = Math.abs(Number(units || 0)).toLocaleString("zh-CN");
  if (resourceType === "token") return `${n} tokens`;
  if (resourceType === "image_generation" || resourceType === "video_generation") return `${n} 次`;
  return n;
}

export const PROVIDER_LABEL = { alipay: "支付宝", wechat: "微信支付", fake: "模拟支付" };

// What a buyer is told when something goes wrong — never a bare error code.
const PAYMENT_ERRORS = {
  PAYMENT_PROVIDER_UNAVAILABLE: "这个支付方式暂时不可用，请换一种方式。",
  ORDER_EXPIRED: "订单已超时关闭，请重新下单。",
  ORDER_NOT_PAYABLE: "这个订单已关闭，请重新下单。",
  ORDER_ALREADY_PAID: "这个订单已经支付过了。",
  ORDER_NOT_FOUND: "找不到这个订单。",
  PRODUCT_NOT_FOUND: "商品已下架，请刷新后重新选择。",
  USER_NOT_ACTIVE: "账号当前不可购买，请联系客服。",
  USER_LOGIN_REQUIRED: "请先登录。",
  ALIPAY_UNREACHABLE: "暂时连不上支付宝，请稍后再试。",
  WECHAT_UNREACHABLE: "暂时连不上微信支付，请稍后再试。",
};

export function paymentErrorMessage(code) {
  const key = String(code || "").split(":")[0].trim();
  return PAYMENT_ERRORS[key] || "支付暂时无法发起，请稍后再试或换一种方式。";
}

/** "12.3" → 1230; digits only, never float math. Returns null for anything that is not an amount. */
export function yuanToCents(yuan) {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(yuan ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
}

export function centsToYuan(cents) {
  const abs = Math.abs(Math.trunc(Number(cents || 0)));
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// What a payment event means, for someone who has never read a payment log.
export const EVENT_OUTCOME = {
  settled: "支付成功，已到账",
  duplicate: "重复通知（已忽略）",
  pending: "尚未支付",
  closed: "已关闭",
  succeeded: "成功",
  processing: "处理中",
  rejected: "通知被拒绝（签名、金额或商户不符）",
  error: "调用支付平台失败",
  double_paid: "重复支付（已自动退款）",
  unknown_payment: "收到未知订单的通知",
};

export const EVENT_KIND = { notify: "异步通知", query: "主动查询", charge: "发起支付", close: "关闭", refund: "退款", reconcile: "对账", sweep: "巡检" };

// The same outcome word means different things per kind: a refund "pending"
// is being processed, not "not yet paid".
const REFUND_OUTCOME = { pending: "退款处理中", succeeded: "退款成功", error: "退款失败" };
export function eventOutcomeLabel({ kind, outcome }) {
  if (kind === "refund") return REFUND_OUTCOME[outcome] || EVENT_OUTCOME[outcome] || outcome;
  if (kind === "close" && outcome === "closed") return "已在支付平台关闭";
  return EVENT_OUTCOME[outcome] || outcome;
}
