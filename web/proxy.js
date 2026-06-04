import { NextResponse } from "next/server";
import { readAdminSummaryResponse } from "./lib/admin-auth-shared.mjs";

const API_BASE = process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "https://lily.lanrensoft.cn";

function redirectToLogin(request) {
  const response = NextResponse.redirect(new URL("/admin/login", request.url));
  response.cookies.delete("lily_admin_token");
  response.cookies.delete("lily_admin_session");
  return response;
}

export async function proxy(request) {
  if (request.nextUrl.pathname === "/admin/login") return NextResponse.next();

  const token = process.env.ADMIN_TOKEN || request.cookies.get("lily_admin_token")?.value || "";
  const session = request.cookies.get("lily_admin_session")?.value || "";
  if (!token && !session) return redirectToLogin(request);

  const response = await fetch(`${API_BASE}/api/admin/summary`, {
    cache: "no-store",
    headers: token
      ? { Authorization: `Bearer ${token}` }
      : { Cookie: `lily_admin_session=${encodeURIComponent(session)}` },
  }).catch(() => null);

  if (!(await readAdminSummaryResponse(response))) return redirectToLogin(request);
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
