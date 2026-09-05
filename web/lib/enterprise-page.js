import { redirect, notFound } from "next/navigation";
import { userApiGetResult } from "./user-api";

export async function requireEnterpriseAccount(next = "/account/enterprise") {
  const result = await userApiGetResult("/api/auth/session/current");
  if (result.status === 401) redirect(`/account/login?next=${encodeURIComponent(next)}`);
  if (!result.ok) throw new Error(result.message || "账户暂时无法加载，请稍后重试");
  if (result.data.user.passwordMustChange) redirect(`/account/password?next=${encodeURIComponent(next)}`);
  return result.data.user;
}

export async function requireEnterpriseOrganization(id, requiredRole = "member") {
  await requireEnterpriseAccount(`/account/enterprise/${encodeURIComponent(id)}`);
  const result = await userApiGetResult(`/api/enterprise/organizations/${encodeURIComponent(id)}`);
  if (result.status === 404) notFound();
  if (!result.ok) throw new Error(result.status === 403 ? "你没有访问此企业的权限，或成员资格已停用" : result.message);
  if (!result.data?.organization?.id) throw new Error("企业数据格式异常，请稍后重试");
  const org = result.data.organization;
  const levels = { member: 1, admin: 2, owner: 3 };
  if ((levels[org.role] || 0) < levels[requiredRole]) throw new Error("你没有管理此企业的权限");
  return org;
}

export async function requireEnterpriseData(path) {
  const result = await userApiGetResult(path);
  if (!result.ok) throw new Error(result.status === 403 ? "你没有访问此企业数据的权限" : result.message || "企业数据暂时无法加载");
  return result.data;
}
