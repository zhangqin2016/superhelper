import { AdminShell } from "../../../../components/admin-shell";
import { AdminPageActions } from "../../../../components/admin-page-actions";
import { BillingProductsTable } from "../../../../components/billing-admin-panels";
import { safeApiGet } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export default async function BillingProductsPage() {
  const { products } = await safeApiGet("/api/admin/billing/products", { products: [] });

  return (
    <AdminShell title="商品档位" subtitle="管理官网可购买的日卡、周卡、月卡、Token 包、图片包和视频包。">
      <AdminPageActions
        actions={[
          { href: "/admin/billing/products/new", label: "新增 / 更新商品", variant: "primary" },
          { href: "/admin/billing/pricing", label: "查看能力计价" },
        ]}
      />
      <BillingProductsTable products={products || []} />
    </AdminShell>
  );
}
