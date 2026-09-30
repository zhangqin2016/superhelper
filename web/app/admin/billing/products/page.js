import { AdminShell } from "../../../../components/admin-shell";
import { BillingAdminTabs } from "../../../../components/billing-admin-tabs";
import { AdminPageActions } from "../../../../components/admin-page-actions";
import { BillingProductsTable } from "../../../../components/billing-admin-panels";
import { AdminBillingPlansTable } from "../../../../components/admin-billing-plans-table";
import { loadAdmin } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function BillingProductsPage() {
  const { products } = await loadAdmin("/api/admin/billing/products", { products: [] });
  const { t, locale } = await getI18n();

  return (
    <AdminShell title="商品档位" subtitle="管理官网可购买的订阅方案（Pro / Max）、日卡、周卡、月卡、积分包、图片包和视频包。">
      <BillingAdminTabs active="products" />
      <AdminPageActions
        actions={[
          { href: "/admin/billing/products/new", label: "新增 / 更新商品", variant: "primary" },
          { href: "/admin/billing/pricing", label: "查看能力计价" },
        ]}
      />
      <AdminBillingPlansTable products={products || []} t={t} locale={locale} />
      <BillingProductsTable products={products || []} />
    </AdminShell>
  );
}
