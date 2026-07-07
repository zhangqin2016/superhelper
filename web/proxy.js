import { NextResponse } from "next/server";
import { adminCredentialHeaders, readAdminSummaryResponse } from "./lib/admin-auth-shared.mjs";

const API_BASE = process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "https://lilych.lilywb.cn";

// Protect against a hanging fetch when the API server is unresponsive.
const ADMIN_SESSION_CHECK_TIMEOUT_MS = 10_000;

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

function redirectToLogin(request, clearSession = true) {
  const response = NextResponse.redirect(new URL("/admin/login", request.url));
  if (clearSession) {
    response.cookies.delete("lily_admin_token");
    response.cookies.delete("lily_admin_session");
  }
  return response;
}

/**
 * Validate the admin session by calling GET /api/admin/summary.
 *
 * Returns { valid: true } on success.  Returns { valid: false, authFailed: true }
 * ONLY when the API responds 401 — the session is truly invalid and the cookie
 * should be cleared.  All other failures (network error, timeout, 5xx,
 * non-JSON body) return { valid: false } — the server has a transient problem,
 * so we preserve the session cookie and pass through.
 */
async function validateAdminSession(headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADMIN_SESSION_CHECK_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${API_BASE}/api/admin/summary`, {
      cache: "no-store",
      headers,
      signal: controller.signal,
    });
  } catch {
    // Network error / timeout — server problem, NOT an auth failure.
    return { valid: false };
  } finally {
    clearTimeout(timer);
  }

  // 401 → the session token is genuinely invalid (e.g. expired, secret rotated).
  if (response.status === 401) return { valid: false, authFailed: true };

  // 5xx or other errors → server-side transient problem.
  if (!response.ok) return { valid: false };

  const summary = await readAdminSummaryResponse(response);
  if (!summary) return { valid: false };

  return { valid: true };
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

  // Fast-path: no credential cookie at all → definitely not logged in.
  const token = request.cookies.get("lily_admin_token")?.value || "";
  const session = request.cookies.get("lily_admin_session")?.value || "";
  if (!token && !session) return redirectToLogin(request, false);

  const headers = adminCredentialHeaders({ token, session });
  if (!headers) return redirectToLogin(request, false);

  const result = await validateAdminSession(headers);

  // Only clear the session cookie when the API confirms it's truly invalid
  // (401).  Network errors, 5xx, and timeouts mean the server has a transient
  // problem — we let the request through so the admin isn't logged out.
  if (result.authFailed) return redirectToLogin(request, true);

  // valid: session ok → pass through.
  // !valid without authFailed: server hiccup → pass through, preserve session.
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/account/:path*"],
};
