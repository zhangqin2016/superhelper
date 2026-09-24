import { userApiGetResult } from "../../../../../lib/user-api";

export const dynamic = "force-dynamic";

// Polled by the pay panel. The API asks the provider itself while the order is
// unpaid, so this settles even when the provider's notification is lost.
export async function GET(_request, { params }) {
  const { orderId } = await params;
  const result = await userApiGetResult(`/api/billing/orders/${encodeURIComponent(orderId)}`);
  return Response.json(result.ok ? { ok: true, order: result.data.order } : { ok: false, code: result.code }, { status: result.ok ? 200 : result.status || 400, headers: { "cache-control": "no-store" } });
}
