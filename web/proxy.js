import { NextResponse } from "next/server";
import { adminCredentialHeaders, readAdminSummaryResponse } from "./lib/admin-auth-shared.mjs";

const API_BASE = process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "https://lilych.lilywb.cn";

function headerValue(headers, name) {
  return String(headers.get(name) || "").trim().toLowerCase();
}

function isUaeRequest(request) {
  const host = headerValue(request.headers, "host").split(":")[0];
  const region = headerValue(request.headers, "x-lily-region") || headerValue(request.headers, "x-client-region");
  if (["uae", "ae", "overseas"].includes(region)) return true;
  if (host === "lilyuae.lilywb.cn") return true;
  const country =
    headerValue(request.headers, "cf-ipcountry") ||
    headerValue(request.headers, "x-vercel-ip-country") ||
    headerValue(request.headers, "x-country-code") ||
    headerValue(request.headers, "x-client-country");
  return country === "ae" || country === "uae";
}

function redirectToLogin(request) {
  const response = NextResponse.redirect(new URL("/admin/login", request.url));
  response.cookies.delete("lily_admin_token");
  response.cookies.delete("lily_admin_session");
  return response;
}

async function consumeBillingLink(request) {
  const token = request.nextUrl.searchParams.get("token") || "";
  if (request.nextUrl.pathname !== "/account/billing" || !token) return null;

  const cleanUrl = new URL(request.url);
  cleanUrl.searchParams.delete("token");
  const response = await fetch(`${API_BASE}/api/account/billing-link/consume`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => null);

  const json = await response?.json?.().catch(() => ({}));
  if (!response?.ok || !json?.webSessionToken) {
    cleanUrl.pathname = "/account/login";
    cleanUrl.searchParams.set("next", "/account/billing");
    return NextResponse.redirect(cleanUrl);
  }

  const redirect = NextResponse.redirect(cleanUrl);
  redirect.cookies.set("lily_user_session", json.webSessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Number(json.expiresIn || 60 * 60 * 24 * 7),
  });
  return redirect;
}

export async function proxy(request) {
  if (request.nextUrl.pathname.startsWith("/account")) {
    if (isUaeRequest(request)) {
      const response = NextResponse.redirect(new URL("/download", request.url));
      response.cookies.delete("lily_user_session");
      return response;
    }
    const billingLinkResponse = await consumeBillingLink(request);
    if (billingLinkResponse) return billingLinkResponse;
    return NextResponse.next();
  }

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
  matcher: ["/admin/:path*", "/account/:path*"],
};
