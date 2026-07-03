import { upsertBillingProductAction, upsertPricingRuleAction } from "../app/admin/billing/actions";

function money(cents, currency = "CNY") {
  return `${currency === "CNY" ? "¥" : currency} ${(Number(cents || 0) / 100).toFixed(2)}`;
}

function Field({ label, children, span = "" }) {
  return (
    <label className={`block ${span}`}>
      <span className="mb-1.5 block text-xs font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

const inputClass = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500";
const selectClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500";

export function BillingProductForm() {
  return (
    <form action={upsertBillingProductAction} className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold">新增 / 更新商品</h2>
      <p className="mt-1 text-sm text-slate-500">保存后官网购买页会立即读取 active 商品。</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Field label="商品 ID">
          <input name="id" required placeholder="token_100k" className={inputClass} />
        </Field>
        <Field label="商品名称">
          <input name="name" required placeholder="100K Token 包" className={inputClass} />
        </Field>
        <Field label="商品类型">
          <select name="kind" defaultValue="token_pack" className={selectClass}>
            <option value="day_pass">日卡</option>
            <option value="week_pass">周卡</option>
            <option value="month_pass">月卡</option>
            <option value="token_pack">Token 包</option>
            <option value="image_pack">图片包</option>
            <option value="video_pack">视频包</option>
            <option value="single_use">单次购买</option>
          </select>
        </Field>
        <Field label="发放资源">
          <select name="resourceType" defaultValue="token" className={selectClass}>
            <option value="token">Token</option>
            <option value="image_generation">图片生成次数</option>
            <option value="video_generation">视频生成次数</option>
            <option value="membership">会员</option>
          </select>
        </Field>
        <Field label="价格（元）">
          <input name="priceYuan" required type="number" min="0" step="0.01" placeholder="9.90" className={inputClass} />
        </Field>
        <Field label="权益数量">
          <input name="unitAmount" required type="number" min="0" step="1" placeholder="100000" className={inputClass} />
        </Field>
        <Field label="会员秒数">
          <input name="durationSeconds" type="number" min="0" step="1" placeholder="月卡填 2592000，可空" className={inputClass} />
        </Field>
        <Field label="权益有效天数">
          <input name="grantExpiresDays" type="number" min="0" step="1" placeholder="365" className={inputClass} />
        </Field>
        <Field label="排序">
          <input name="sortOrder" type="number" step="1" placeholder="0" className={inputClass} />
        </Field>
        <Field label="状态">
          <select name="status" defaultValue="active" className={selectClass}>
            <option value="active">上架</option>
            <option value="disabled">下架</option>
          </select>
        </Field>
        <Field label="商品描述" span="md:col-span-2">
          <textarea name="description" placeholder="购买后立即发放到当前账号。" className={inputClass} rows={3} />
        </Field>
      </div>
      <button type="submit" className="mt-4 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">保存商品</button>
    </form>
  );
}

export function PricingRuleForm() {
  return (
    <form action={upsertPricingRuleAction} className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold">新增 / 更新计价规则</h2>
      <p className="mt-1 text-sm text-slate-500">计价规则会被模型、图片和视频网关实时读取；单次消耗填 0 表示免费。</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Field label="规则 ID">
          <input name="id" required placeholder="image_default" className={inputClass} />
        </Field>
        <Field label="能力">
          <select name="feature" defaultValue="image_generation" className={selectClass}>
            <option value="chat_model">聊天模型</option>
            <option value="image_generation">图片生成</option>
            <option value="video_generation">视频生成</option>
          </select>
        </Field>
        <Field label="Provider">
          <input name="provider" placeholder="可空，例：volcengine" className={inputClass} />
        </Field>
        <Field label="Model">
          <input name="model" placeholder="可空，例：qwen-image" className={inputClass} />
        </Field>
        <Field label="规格 Key">
          <input name="specKey" required placeholder="default" className={inputClass} />
        </Field>
        <Field label="扣减资源">
          <select name="resourceType" defaultValue="image_generation" className={selectClass}>
            <option value="token">Token</option>
            <option value="image_generation">图片次数</option>
            <option value="video_generation">视频次数</option>
            <option value="membership">会员</option>
          </select>
        </Field>
        <Field label="单次消耗">
          <input name="unitCost" required type="number" min="0" step="1" defaultValue="1" placeholder="1" className={inputClass} />
        </Field>
        <Field label="免费日限额">
          <input name="freeDailyLimit" type="number" min="0" step="1" placeholder="可空" className={inputClass} />
        </Field>
        <Field label="付费日限额">
          <input name="paidDailyLimit" type="number" min="0" step="1" placeholder="可空" className={inputClass} />
        </Field>
        <Field label="并发上限">
          <input name="concurrencyLimit" type="number" min="0" step="1" placeholder="可空" className={inputClass} />
        </Field>
        <Field label="状态">
          <select name="enabled" defaultValue="true" className={selectClass}>
            <option value="true">启用</option>
            <option value="false">停用</option>
          </select>
        </Field>
      </div>
      <button type="submit" className="mt-4 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">保存规则</button>
    </form>
  );
}

export function BillingProductsTable({ products = [] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">商品档位</h2>
        <span className="text-sm text-slate-500">{products.length} 项</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="border-b border-slate-200 py-2 pr-4">ID</th>
              <th className="border-b border-slate-200 py-2 pr-4">名称</th>
              <th className="border-b border-slate-200 py-2 pr-4">类型</th>
              <th className="border-b border-slate-200 py-2 pr-4">权益</th>
              <th className="border-b border-slate-200 py-2 pr-4">价格</th>
              <th className="border-b border-slate-200 py-2 pr-4">状态</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                <td className="border-b border-slate-100 py-3 pr-4 font-mono text-xs">{product.id}</td>
                <td className="border-b border-slate-100 py-3 pr-4 font-medium">{product.name}</td>
                <td className="border-b border-slate-100 py-3 pr-4">{product.kind}</td>
                <td className="border-b border-slate-100 py-3 pr-4">{product.resource_type} · {Number(product.unit_amount || 0).toLocaleString("zh-CN")}</td>
                <td className="border-b border-slate-100 py-3 pr-4">{money(product.price_cents, product.currency)}</td>
                <td className="border-b border-slate-100 py-3 pr-4">{product.status}</td>
              </tr>
            ))}
            {!products.length ? (
              <tr><td className="py-6 text-slate-500" colSpan={6}>暂无商品。后续可创建日卡、周卡、月卡、Token 包、图片包和视频包。</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PricingRulesTable({ rules = [] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">能力计价</h2>
        <span className="text-sm text-slate-500">{rules.length} 条</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="border-b border-slate-200 py-2 pr-4">能力</th>
              <th className="border-b border-slate-200 py-2 pr-4">规格</th>
              <th className="border-b border-slate-200 py-2 pr-4">资源</th>
              <th className="border-b border-slate-200 py-2 pr-4">单次价格</th>
              <th className="border-b border-slate-200 py-2 pr-4">免费/付费日限额</th>
              <th className="border-b border-slate-200 py-2 pr-4">状态</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td className="border-b border-slate-100 py-3 pr-4">{rule.feature}</td>
                <td className="border-b border-slate-100 py-3 pr-4 font-mono text-xs">{rule.spec_key}</td>
                <td className="border-b border-slate-100 py-3 pr-4">{rule.resource_type}</td>
                <td className="border-b border-slate-100 py-3 pr-4">{rule.unit_cost}</td>
                <td className="border-b border-slate-100 py-3 pr-4">{rule.free_daily_limit ?? "-"} / {rule.paid_daily_limit ?? "-"}</td>
                <td className="border-b border-slate-100 py-3 pr-4">{rule.enabled ? "enabled" : "disabled"}</td>
              </tr>
            ))}
            {!rules.length ? (
              <tr><td className="py-6 text-slate-500" colSpan={6}>暂无计价规则。可配置图片、视频和模型的单次价格、免费次数、每日上限和并发上限。</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
