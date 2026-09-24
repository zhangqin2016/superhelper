import Link from "next/link";
import { redirect } from "next/navigation";
import { OrderPayPanel } from "../../../../components/account/order-pay-panel";
import { userApiGetResult } from "../../../../lib/user-api";

export const dynamic = "force-dynamic";

// One order: pay it, watch it settle, or see how it ended. Also where Alipay
// sends the buyer back (return_url) — the page shows what the API knows and
// keeps asking; it never takes "came back from Alipay" as "paid".
export default async function AccountOrderPage({ params, searchParams }) {
  const { orderId } = await params;
  const query = await searchParams;
  const result = await userApiGetResult(`/api/billing/orders/${encodeURIComponent(orderId)}`);
  if (!result.ok && (result.status === 401 || /USER_LOGIN_REQUIRED|WEB_SESSION/.test(result.code || ""))) {
    redirect(`/account/login?next=${encodeURIComponent(`/account/orders/${orderId}`)}`);
  }
  if (!result.ok) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-semibold">找不到这个订单</h1>
        <Link href="/account/orders" className="mt-4 inline-flex text-sm font-medium text-slate-700 underline">返回订单列表</Link>
      </section>
    );
  }
  return (
    <div className="space-y-4">
      <Link href="/account/orders" className="text-sm text-slate-500 hover:text-slate-900">← 全部订单</Link>
      <OrderPayPanel initialOrder={result.data.order} autoStart={query?.pay === "1"} />
    </div>
  );
}
