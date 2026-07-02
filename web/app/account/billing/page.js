import Link from "next/link";
import { CreditCard, Image, MessageSquareText, RefreshCw, ShieldCheck, Video, Zap } from "lucide-react";
import { userApiGet } from "../../../lib/user-api";
import { ProductPurchaseForm } from "../../../components/product-purchase-form";

export const dynamic = "force-dynamic";

const groups = [
  ["membership", "会员", Zap],
  ["token", "Token 包", MessageSquareText],
  ["image_generation", "图片生成", Image],
  ["video_generation", "视频生成", Video],
];

function formatMoney(cents, currency = "CNY") {
  const amount = Number(cents || 0) / 100;
  return `${currency === "CNY" ? "¥" : currency} ${amount.toFixed(2)}`;
}

function unitLabel(product) {
  if (product.resourceType === "token") return `${Number(product.unitAmount || 0).toLocaleString("zh-CN")} tokens`;
  if (product.resourceType === "image_generation") return `${Number(product.unitAmount || 0).toLocaleString("zh-CN")} 次图片`;
  if (product.resourceType === "video_generation") return `${Number(product.unitAmount || 0).toLocaleString("zh-CN")} 次视频`;
  if (product.resourceType === "membership") return `${Math.round(Number(product.durationSeconds || 0) / 86400)} 天`;
  return `${product.unitAmount || 0} 单位`;
}

export default async function AccountBillingPage() {
  const data = await userApiGet("/api/billing/products", { products: [] });
  const products = Array.isArray(data?.products) ? data.products : [];
  const paymentProviders = Array.isArray(data?.paymentProviders) ? data.paymentProviders : [];

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">购买与充值</h1>
            <p className="mt-2 text-sm text-slate-500">选择权益后使用支付宝或微信完成支付，到账后客户端刷新即可使用。</p>
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
