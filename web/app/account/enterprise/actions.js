"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { API_BASE, userApiPost, userApiPatch, userApiDelete } from "../../../lib/user-api";

export async function createOrganizationAction(formData) {
  const name = String(formData.get("name") || "").trim();
  if (!name) return { ok: false, message: "组织名称不能为空" };
  try {
    const result = await userApiPost("/api/enterprise/organizations", { name });
    revalidatePath("/account/enterprise");
    if (result?.id) redirect(`/account/enterprise/${result.id}`);
    return { ok: true };
  } catch (error) {
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
  if (quotaRaw !== "") {
    const quota = Number(quotaRaw);
    body.memberQuota = Number.isFinite(quota) && quota >= 0 ? quota : null;
  }
  try {
    await userApiPatch(`/api/enterprise/organizations/${organizationId}/members/${userId}`, body);
    revalidatePath(`/account/enterprise/${organizationId}/members`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message || "更新失败") };
  }
}

export async function removeMemberAction(organizationId, userId) {
  try {
    await userApiDelete(`/api/enterprise/organizations/${organizationId}/members/${userId}`);
    revalidatePath(`/account/enterprise/${organizationId}/members`);
    return { ok: true };
  } catch (error) {
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
    return { ok: false, message: String(error?.message || "撤销失败") };
  }
}
