"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { API_BASE, userApiPost, userApiPatch, userApiDelete } from "../../../lib/user-api";

export async function createOrganizationAction(formData) {
  const name = String(formData.get("name") || "").trim();
  if (!name) return { ok: false, message: "组织名称不能为空" };
  try {
    const result = await userApiPost("/api/enterprise/organizations", { name });
    revalidatePath("/account/enterprise");
    if (result?.organization?.id) redirect(`/account/enterprise/${result.organization.id}`);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: String(error?.message || "创建失败") };
  }
}

export async function patchOrganizationAction(organizationId, formData) {
  const status = String(formData.get("status") || "").trim();
  try {
    await userApiPatch(`/api/enterprise/organizations/${organizationId}`, { status });
    revalidatePath(`/account/enterprise/${organizationId}`);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: String(error?.message || "操作失败") };
  }
}

export async function addMemberAction(organizationId, formData) {
  const userId = String(formData.get("userId") || "").trim();
  const phoneE164 = String(formData.get("phoneE164") || "").trim();
  const role = String(formData.get("role") || "member").trim();
  try {
    await userApiPost(`/api/enterprise/organizations/${organizationId}/members`, {
      ...(userId ? { userId } : {}),
      ...(phoneE164 ? { phoneE164 } : {}),
      role,
    });
    revalidatePath(`/account/enterprise/${organizationId}/members`);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: String(error?.message || "添加失败") };
  }
}

export async function patchMemberAction(organizationId, userId, formData) {
  const role = String(formData.get("role") || "").trim();
  const status = String(formData.get("status") || "").trim();
  const quotaRaw = String(formData.get("quota") || "").trim();
  const body = {};
  if (role) body.role = role;
  if (status) body.status = status;
  if (formData.has("quota")) {
    const quota = quotaRaw === "" ? null : Number(quotaRaw);
    if (quota !== null && (!Number.isSafeInteger(quota) || quota < 0)) return { ok: false, message: "额度必须为非负整数，留空表示不限" };
    body.memberQuota = quota;
  }
  try {
    await userApiPatch(`/api/enterprise/organizations/${organizationId}/members/${userId}`, body);
    revalidatePath(`/account/enterprise/${organizationId}/members`);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: String(error?.message || "更新失败") };
  }
}

export async function removeMemberAction(organizationId, userId) {
  try {
    await userApiDelete(`/api/enterprise/organizations/${organizationId}/members/${userId}`);
    revalidatePath(`/account/enterprise/${organizationId}/members`);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: String(error?.message || "移除失败") };
  }
}

/** Withdraw a seat handed to someone who has not signed up yet. */
export async function revokeInvitationAction(organizationId, invitationId) {
  try {
    await userApiDelete(`/api/enterprise/organizations/${organizationId}/invitations/${invitationId}`);
    revalidatePath(`/account/enterprise/${organizationId}/members`);
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: String(error?.message || "撤销失败") };
  }
}

/**
 * Issue dedicated accounts. The initial passwords come back exactly once and
 * are never stored, so they are carried to the page through the URL hash
 * rather than the server: reloading forgets them, which is the point.
 */
export async function provisionAccountsAction(organizationId, formData) {
  const raw = String(formData.get("loginNames") || "").trim();
  const prefix = String(formData.get("prefix") || "").trim();
  const count = Math.max(0, Math.min(100, Number(formData.get("count") || 0)));
  const role = String(formData.get("role") || "member").trim() === "admin" ? "admin" : "member";
  const named = raw.split(/[\n,，;；\s]+/).map((v) => v.trim()).filter(Boolean).map((loginName) => ({ loginName, role }));
  // Three ways to name a batch, most specific first: an explicit list; a
  // prefix the server numbers (MAX -> max_0001..); or a count of random names.
  let body;
  if (named.length) body = { accounts: named };
  else if (prefix && count) body = { pattern: { prefix, count, role } };
  else if (count) body = { accounts: Array.from({ length: count }, () => ({ role })) };
  else return { ok: false, message: "请填写登录名列表，或前缀+数量，或数量" };
  try {
    const result = await userApiPost(`/api/enterprise/organizations/${organizationId}/accounts`, body);
    revalidatePath(`/account/enterprise/${organizationId}/members`);
    const issued = Array.isArray(result?.accounts) ? result.accounts : [];
    return { ok: true, message: `已生成 ${issued.length} 个账户，请保存初始密码`, issued: issued.map((a) => ({ l: a.loginName, p: a.initialPassword })) };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: String(error?.message || "生成失败") };
  }
}

export async function resetAccountPasswordAction(organizationId, userId) {
  try {
    const result = await userApiPost(`/api/enterprise/organizations/${organizationId}/accounts/${userId}/reset-password`, {});
    revalidatePath(`/account/enterprise/${organizationId}/members`);
    return { ok: true, message: "密码已重置，旧登录会话已失效", issued: [{ l: result.loginName, p: result.initialPassword }] };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: String(error?.message || "重置失败") };
  }
}
