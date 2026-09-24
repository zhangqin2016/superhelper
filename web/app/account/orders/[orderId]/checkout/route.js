import { userApiPostResult } from "../../../../../lib/user-api";

export const dynamic = "force-dynamic";

// The pay panel starts checkout through here: the buyer's session cookie
// travels server-side to the API; the browser never sees an API credential.
export async function POST(request, { params }) {
  const { orderId } = await params;
  const body = await request.json().catch(() => ({}));
  const client = body?.client === "mobile" ? "mobile" : "desktop";
  const result = await userApiPostResult(`/api/billing/orders/${encodeURIComponent(orderId)}/checkout`, { client });
  return Response.json(result.ok ? { ok: true, ...result.data } : { ok: false, code: result.code }, { status: result.ok ? 200 : result.status || 400, headers: { "cache-control": "no-store" } });
}
