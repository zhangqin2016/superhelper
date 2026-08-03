"use server";

import { revalidatePath } from "next/cache";
import { apiPatch, apiPost } from "../../../lib/api";

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
