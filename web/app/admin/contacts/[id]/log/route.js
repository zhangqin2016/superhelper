import { apiGetRaw } from "../../../../../lib/api";

export const dynamic = "force-dynamic";

// The log never has a public URL: the browser asks this route, which forwards
// the operator's admin credential, so the API's admin check and audit apply.
export async function GET(_request, { params }) {
  const { id } = await params;
  const upstream = await apiGetRaw(`/api/admin/contact-requests/${encodeURIComponent(id)}/log`);
  if (!upstream.ok) {
    return new Response(upstream.status === 404 ? "No log attached." : `Log unavailable (${upstream.status}).`, {
      status: upstream.status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") || "text/plain; charset=utf-8",
      "content-disposition": upstream.headers.get("content-disposition") || `attachment; filename="lily-${id}.log"`,
      "cache-control": "no-store",
    },
  });
}
