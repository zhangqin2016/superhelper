import Link from "next/link";
import { CalendarClock, CreditCard, Crown, Image, MessageSquareText, RefreshCw, ShieldCheck, Video, Zap } from "lucide-react";
import { userApiGet, userApiGetResult } from "../../../lib/user-api";
import { ProductPurchaseForm } from "../../../components/product-purchase-form";
import { getLocale } from "../../../lib/i18n.mjs";
import { accountPlanProducts, copyFor, creditUnit, currentPlanView, formatCredits } from "../../../lib/site-copy-pricing.mjs";

export const dynamic = "force-dynamic";

const groups = [
  ["membership", "会员", Zap],
  ["token", `${creditUnit("zh")}包`, MessageSquareText],
  ["image_generation", "图片生成", Image],
  ["video_generation", "视频生成", Video],
];

function formatMoney(cents, currency = "CNY") {
  const amount = Number(cents || 0) / 100;
  return `${currency === "CNY" ? "¥" : currency} ${amount.toFixed(2)}`;
}

function unitLabel(product) {
  if (product.resourceType === "token") return `${formatCredits(product.unitAmount, "zh")} ${creditUnit("zh")}`;
  if (product.resourceType === "image_generation") return `${Number(product.unitAmount || 0).toLocaleString("zh-CN")} 次图片`;
  if (product.resourceType === "video_generation") return `${Number(product.unitAmount || 0).toLocaleString("zh-CN")} 次视频`;
  if (product.resourceType === "membership") return `${Math.round(Number(product.durationSeconds || 0) / 86400)} 天`;
  return `${product.unitAmount || 0} 单位`;
}

function fill(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => (values[key] ?? `{${key}}`));
}

// The signed-in user's plan, from GET /api/account/entitlements (plan: null |
// { tier, expiresAt, weeklyUnits, weekRemaining?, weekResetsAt? }).
function CurrentPlan({ result, copy, locale }) {
  const loginRequired = !result.ok && (result.status === 401 || result.status === 403 || /USER_LOGIN_REQUIRED|WEB_SESSION/.test(result.message || ""));
  const plan = result.ok ? currentPlanView(result.data?.entitlements?.plan, locale) : null;
  const message = loginRequired ? copy.signIn : !result.ok ? copy.unavailable : plan ? "" : copy.none;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        <CalendarClock size={16} className="text-brand" />
        <span>{copy.current}</span>
        {plan ? <span className="text-base text-slate-950">{plan.name}</span> : null}
      </div>
      {plan ? (
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div><dt className="text-slate-500">{copy.expiresAt}</dt><dd className="mt-1 font-medium tabular-nums">{plan.expiresAt || "--"}</dd></div>
          {plan.weekly ? (
            <>
              <div><dt className="text-slate-500">{copy.weekRemaining}</dt><dd className="mt-1 font-medium tabular-nums">{plan.weekRemaining || "--"}<span className="ms-1 text-xs text-slate-400">/ {plan.weekly}</span></dd></div>
              <div><dt className="text-slate-500">{copy.weekResetsAt}</dt><dd className="mt-1 font-medium tabular-nums">{plan.weekResetsAt || "--"}</dd></div>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-slate-500">
          {message}
          {loginRequired ? <Link href="/account/login?next=/account/billing" className="ms-2 font-semibold text-brand">{copy.signInLink}</Link> : null}
        </p>
      )}
      {plan?.expiresAt ? <p className="mt-3 text-xs text-slate-500">{fill(copy.extendNote, { date: plan.expiresAt })}</p> : null}
    </div>
  );
}

export default async function AccountBillingPage() {
  const locale = await getLocale();
  const [data, entitlements] = await Promise.all([
    userApiGet("/api/billing/products", { products: [] }),
    userApiGetResult("/api/account/entitlements"),
  ]);
  const products = Array.isArray(data?.products) ? data.products : [];
  const paymentProviders = Array.isArray(data?.paymentProviders) ? data.paymentProviders : [];
  const planCopy = copyFor(locale).account;
  const plans = accountPlanProducts(products, locale);
  const currentTier = entitlements.ok ? String(entitlements.data?.entitlements?.plan?.tier || "") : "";

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">购买与充值</h1>
            <p className="mt-2 text-sm text-slate-500">选择权益后用支付宝或微信付款，到账后桌面客户端会自动刷新额度。</p>
          </div>
          <Link href="/account/login" className="inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
            手机号登录
          </Link>
        </div>
        <div className="mt-5 grid gap-3 text-sm md:grid-cols-3">
          {[
            [ShieldCheck, "登录同一个手机号"],
            [CreditCard, "官网下单并完成支付"],
            [RefreshCw, "客户端刷新额度后使用"],
          ].map(([Icon, label]) => (
            <div key={label} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-3 text-slate-600">
              <Icon size={16} className="text-brand" />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Plans first: the main offer. Buying goes through the same order flow as every product. */}
      <section className="space-y-3" aria-labelledby="account-plans-title">
        <div className="flex items-center gap-2">
          <Crown size={20} className="text-brand" />
          <h2 id="account-plans-title" className="text-lg font-semibold">{planCopy.title}</h2>
        </div>
        <p className="text-sm text-slate-500">{planCopy.lead}</p>
        <CurrentPlan result={entitlements} copy={planCopy} locale={locale} />
        {plans.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {plans.map((plan) => (
              <article key={plan.id} className={`rounded-lg border bg-white p-5 shadow-sm ${plan.tier === "max" ? "border-brand/40" : "border-slate-200"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{plan.name}</h3>
                    <p className="mt-1 text-xs text-slate-500">
                      {planCopy.tiers[plan.tier]}
                      {plan.period ? ` · ${planCopy[plan.period]}` : ""}
                      {plan.days ? ` · ${fill(planCopy.periodDays, { n: plan.days })}` : ""}
                    </p>
                  </div>
                  <div className="text-lg font-semibold tabular-nums">{plan.price}</div>
                </div>
                <p className="mt-3 text-sm font-medium text-slate-700 tabular-nums">{plan.weekly}</p>
                {plan.description ? <p className="mt-2 text-sm leading-5 text-slate-500">{plan.description}</p> : null}
                <div className="mt-4">
                  <ProductPurchaseForm
                    productId={plan.id}
                    paymentProviders={paymentProviders}
                    submitLabel={currentTier && currentTier === plan.tier ? planCopy.renew : planCopy.buy}
                  />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">{planCopy.empty}</div>
        )}
      </section>

      {groups.map(([resourceType, title, Icon]) => {
        const items = products.filter((product) => product.resourceType === resourceType);
        return (
          <section key={resourceType} className="space-y-3">
            <div className="flex items-center gap-2">
              <Icon size={20} className="text-brand" />
              <h2 className="text-lg font-semibold">{title}</h2>
            </div>
            {items.length ? (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {items.map((product) => (
                  <article key={product.id} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-semibold">{product.name}</h3>
                        <p className="mt-2 min-h-10 text-sm leading-5 text-slate-500">{product.description || "购买后立即发放到当前账号。"}</p>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-semibold">{formatMoney(product.priceCents, product.currency)}</div>
                        <div className="text-xs text-slate-400">{unitLabel(product)}</div>
                      </div>
                    </div>
                    <div className="mt-5 flex flex-col gap-3 text-sm text-slate-500 sm:flex-row sm:items-end sm:justify-between">
                      <span>有效期 {product.grantExpiresDays || Math.round((product.durationSeconds || 0) / 86400) || 0} 天</span>
                      <ProductPurchaseForm productId={product.id} paymentProviders={paymentProviders} />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
                暂无可售{title}商品。管理员可在后台计费页添加商品后自动显示在这里。
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
