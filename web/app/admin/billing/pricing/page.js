import { AdminShell } from "../../../../components/admin-shell";
import { AdminPageActions } from "../../../../components/admin-page-actions";
import { PricingRulesTable } from "../../../../components/billing-admin-panels";
import { safeApiGet } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export default async function PricingRulesPage() {
  const { rules } = await safeApiGet("/api/admin/billing/pricing-rules", { rules: [] });

  return (
    <AdminShell title="能力计价" subtitle="管理模型、图片、视频的单次消耗、免费次数、每日上限和并发限制。">
      <AdminPageActions
        actions={[
          { href: "/admin/billing/pricing/new", label: "新增 / 更新计价规则", variant: "primary" },
          { href: "/admin/billing/products", label: "查看商品档位" },
        ]}
      />
      <PricingRulesTable rules={rules || []} />
    </AdminShell>
  );
}
