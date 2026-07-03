import Link from "next/link";
import { AdminShell } from "../../../../../components/admin-shell";
import { PricingRuleForm } from "../../../../../components/billing-admin-panels";

export default function NewPricingRulePage() {
  return (
    <AdminShell title="新增 / 更新计价规则" subtitle="只处理能力扣费规则。商品售卖档位请到商品页面配置。">
      <div className="mb-5">
        <Link href="/admin/billing/pricing" className="text-sm font-semibold text-brand">返回能力计价</Link>
      </div>
      <PricingRuleForm />
    </AdminShell>
  );
}
