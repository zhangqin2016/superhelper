import Link from "next/link";
import { AdminShell } from "../../../../../components/admin-shell";
import { BillingProductForm } from "../../../../../components/billing-admin-panels";

export default function NewBillingProductPage() {
  return (
    <AdminShell title="新增 / 更新商品" subtitle="只处理商品档位。能力消耗价格请到计价规则页面配置。">
      <div className="mb-5">
        <Link href="/admin/billing/products" className="text-sm font-semibold text-brand">返回商品档位</Link>
      </div>
      <BillingProductForm />
    </AdminShell>
  );
}
