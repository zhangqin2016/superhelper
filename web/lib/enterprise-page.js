import { cache } from "react";
import { redirect, notFound } from "next/navigation";
import { userApiGetResult } from "./user-api";

// One request renders a layout and a page that both need the account and the
// organization; `cache` makes that one fetch each instead of two.
const currentAccount = cache(() => userApiGetResult("/api/auth/session/current"));
const organizationResult = cache((id) => userApiGetResult(`/api/enterprise/organizations/${encodeURIComponent(id)}`));

const ROLE_LEVELS = { member: 1, admin: 2, owner: 3 };

/** The server code a failed read stands for, so the page can say it in words. */
function failureCode(result) {
  if (result.code) return result.code;
  if (result.status === 401) return "USER_LOGIN_REQUIRED";
  if (result.status === 403) return "ORG_FORBIDDEN";
  if (result.status === 404) return "ORG_NOT_FOUND";
  return result.status ? "INTERNAL_ERROR" : "NETWORK_ERROR";
}

export function roleAtLeast(role, required = "member") {
  return (ROLE_LEVELS[role] || 0) >= (ROLE_LEVELS[required] || 0);
}

export async function requireEnterpriseAccount(next = "/account/enterprise") {
  const result = await currentAccount();
  if (result.status === 401) redirect(`/account/login?next=${encodeURIComponent(next)}`);
  if (!result.ok) throw new Error(result.message || "账户暂时无法加载，请稍后重试");
  if (result.data.user.passwordMustChange) redirect(`/account/password?next=${encodeURIComponent(next)}`);
  return result.data.user;
}

/**
 * The organization as its viewer may see it, or `{ ok: false, code }` when it
 * cannot be opened (not a member, membership disabled, server down). Login and
 * forced password change still redirect; a missing organization is a 404.
 */
export async function loadEnterpriseOrganization(id) {
  const user = await requireEnterpriseAccount(`/account/enterprise/${encodeURIComponent(id)}`);
  const result = await organizationResult(id);
  if (result.status === 404) notFound();
  if (result.status === 401) redirect(`/account/login?next=${encodeURIComponent(`/account/enterprise/${id}`)}`);
  if (!result.ok) return { ok: false, code: failureCode(result) };
  if (!result.data?.organization?.id) return { ok: false, code: "INTERNAL_ERROR" };
  return { ok: true, org: { ...result.data.organization, viewerId: user?.id || "" } };
}

export async function requireEnterpriseOrganization(id, requiredRole = "member") {
  const loaded = await loadEnterpriseOrganization(id);
  if (!loaded.ok) throw new Error(loaded.code === "ORG_FORBIDDEN" || loaded.code === "ORG_MEMBER_REQUIRED" ? "你没有访问此企业的权限，或成员资格已停用" : loaded.code);
  const org = loaded.org;
  if (!roleAtLeast(org.role, requiredRole)) throw new Error("你没有管理此企业的权限");
  return org;
}

/**
 * Read one section of an enterprise page.
 *
 * With a `fallback`, a failed read no longer throws the whole page away: it
 * answers the fallback plus `loadError` (the server code), so the page shows
 * everything else and says in words why that one section is missing. Without a
 * fallback it still throws — for data the page cannot exist without.
 */
export async function requireEnterpriseData(path, fallback) {
  const result = await userApiGetResult(path);
  if (result.ok) return result.data;
  if (fallback !== undefined) return { ...fallback, loadError: failureCode(result) };
  throw new Error(result.status === 403 ? "你没有访问此企业数据的权限" : result.message || "企业数据暂时无法加载");
}
