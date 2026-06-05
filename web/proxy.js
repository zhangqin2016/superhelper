import { NextResponse } from "next/server";
import { adminCredentialHeaders, readAdminSummaryResponse } from "./lib/admin-auth-shared.mjs";

const API_BASE = process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "https://lily.lanrensoft.cn";

function redirectToLogin(request) {
  const response = NextResponse.redirect(new URL("/admin/login", request.url));
  response.cookies.delete("lily_admin_token");
  response.cookies.delete("lily_admin_session");
  return response;
}

export async function proxy(request) {
  if (request.nextUrl.pathname === "/admin/login") return NextResponse.next();

  const token = request.cookies.get("lily_admin_token")?.value || "";
  const session = request.cookies.get("lily_admin_session")?.value || "";
  const headers = adminCredentialHeaders({ token, session });
  if (!headers) return redirectToLogin(request);

  const response = await fetch(`${API_BASE}/api/admin/summary`, {
    cache: "no-store",
    headers,
  }).catch(() => null);

  if (!(await readAdminSummaryResponse(response))) return redirectToLogin(request);
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
