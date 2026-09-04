"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiPatch, apiPost } from "../../../lib/api";

/**
 * Create an organization for a customer and hand it to its first owner. When
 * the platform issues the owner account, the one-time password travels to the
 * page through the URL hash — never through the server — and is shown once.
 */
export async function createOrganizationAction(formData) {
  const name = String(formData.get("name") || "").trim();
  const plan = String(formData.get("plan") || "standard").trim() || "standard";
  const mode = String(formData.get("ownerMode") || "issue").trim();
  const phoneE164 = String(formData.get("ownerPhone") || "").trim();
  const loginName = String(formData.get("ownerLoginName") || "").trim();
  const displayName = String(formData.get("ownerDisplayName") || "").trim();
  if (!name) return { ok: false, message: "企业名称不能为空" };
  const owner = mode === "phone"
    ? { phoneE164 }
    : { issue: true, ...(loginName ? { loginName } : {}), ...(displayName ? { displayName } : {}) };
  if (mode === "phone" && !phoneE164) return { ok: false, message: "请填写 owner 的手机号" };
  try {
    const result = await apiPost("/api/admin/enterprise/organizations", { name, plan, owner });
    revalidatePath("/admin/enterprise");
    const id = result?.organization?.id;
    if (result?.owner?.issued && result.owner.initialPassword) {
      const payload = Buffer.from(JSON.stringify([{ l: result.owner.loginName, p: result.owner.initialPassword }]), "utf8").toString("base64url");
      redirect(`/admin/enterprise/${id}#issued=${payload}`);
    }
    redirect(id ? `/admin/enterprise/${id}` : "/admin/enterprise");
  } catch (error) {
    return { ok: false, message: String(error?.message || "创建失败") };
  }
}

export async function toggleOrgStatusAction(organizationId, formData) {
  const status = String(formData.get("status") || "").trim();
  if (status !== "active" && status !== "disabled") return { ok: false, message: "Invalid status" };
  try {
    await apiPatch(`/api/admin/enterprise/organizations/${organizationId}`, { status });
    revalidatePath("/admin/enterprise");
    revalidatePath(`/admin/enterprise/${organizationId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message || "Operation failed") };
  }
}

export async function adjustOrgGrantAction(organizationId, formData) {
  const resourceType = String(formData.get("resourceType") || "token").trim();
  const unitTotal = Number(formData.get("unitTotal") || 0);
  const expiresDays = Number(formData.get("expiresDays") || 365);
  if (!unitTotal || unitTotal <= 0) return { ok: false, message: "unitTotal must be > 0" };
  try {
    await apiPost(`/api/admin/enterprise/organizations/${organizationId}/grants`, {
      resourceType,
      unitTotal: Math.trunc(unitTotal),
      expiresDays: Math.trunc(expiresDays),
    });
    revalidatePath(`/admin/enterprise/${organizationId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message || "Operation failed") };
  }
}
