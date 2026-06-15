"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { API_BASE, apiDelete, apiPatch, apiPost, apiPostForm } from "../../lib/api";

function text(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function bool(formData, key) {
  return formData.get(key) === "on";
}

function actionFormData(firstArg, secondArg) {
  return secondArg || firstArg;
}

export async function createLicenseAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  try {
    const expiresAt = new Date(text(formData, "expiresAt"));
    if (Number.isNaN(expiresAt.getTime())) {
      return { ok: false, message: "Invalid expiration date." };
    }

    const result = await apiPost("/api/admin/licenses", {
      customerName: text(formData, "customerName") || null,
      plan: text(formData, "plan") || "pro",
      seats: Number(text(formData, "seats") || 1),
      expiresAt: expiresAt.toISOString(),
      features: text(formData, "features")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    });
    revalidatePath("/admin/licenses");
    return {
      ok: true,
      message: "License created. Copy it now; the plain key is shown only once.",
      licenseId: result.licenseId,
      licenseKey: result.licenseKey,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to create license." };
  }
}

export async function createReleaseAction(formData) {
  try {
    const result = await apiPost("/api/admin/releases", {
      version: text(formData, "version"),
      platform: text(formData, "platform"),
      url: text(formData, "url"),
      sha256: text(formData, "sha256"),
      sizeBytes: Number(text(formData, "sizeBytes") || 0),
      notes: text(formData, "notes") || null,
      forceUpdate: bool(formData, "forceUpdate"),
      enabled: !bool(formData, "disabled"),
    });
    revalidatePath("/admin/releases");
    return { ok: true, message: `Release ${result.id} created.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to create release." };
  }
}

export async function createSkillPackageAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  try {
    const uploadForm = new FormData();
    for (const key of [
      "skillId",
      "name",
      "description",
      "version",
      "category",
      "capabilityLayer",
      "publisher",
      "sourceRepo",
      "minAppVersion",
      "channel",
      "riskLevel",
    ]) {
      uploadForm.set(key, text(formData, key));
    }
    uploadForm.set("sourceKind", "lily");
    if (bool(formData, "defaultEligible")) uploadForm.set("defaultEligible", "true");
    if (bool(formData, "featured")) uploadForm.set("featured", "true");
    if (bool(formData, "disabled")) uploadForm.set("disabled", "true");
    const artifact = formData.get("artifact");
    if (artifact) uploadForm.set("artifact", artifact);
    const result = await apiPostForm("/api/admin/skill-packages/upload", uploadForm);
    revalidatePath("/admin/skill-packages");
    return { ok: true, message: `Skill package ${result.skillId} uploaded.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to upload skill package." };
  }
}

export async function createWorkspaceAppAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  try {
    const uploadForm = new FormData();
    for (const key of [
      "appId",
      "name",
      "summary",
      "description",
      "version",
      "category",
      "appType",
      "entryKind",
      "publisher",
      "sourceRepo",
      "minAppVersion",
      "channel",
      "riskLevel",
      "tags",
      "requiredRuntimePacks",
      "requiredSkillPackages",
      "notes",
    ]) {
      uploadForm.set(key, text(formData, key));
    }
    uploadForm.set("sourceKind", "lily");
    if (bool(formData, "featured")) uploadForm.set("featured", "true");
    if (bool(formData, "disabled")) uploadForm.set("disabled", "true");
    const artifact = formData.get("artifact");
    if (artifact) uploadForm.set("artifact", artifact);
    const result = await apiPostForm("/api/admin/workspace-apps/upload", uploadForm);
    revalidatePath("/admin/apps");
    return { ok: true, message: `Workspace app ${result.appId} uploaded.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to upload workspace app." };
  }
}

export async function createConfigProfileAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  try {
    let parsedConfig = {};
    const configText = text(formData, "config");
    if (configText) {
      parsedConfig = JSON.parse(configText);
      if (!parsedConfig || Array.isArray(parsedConfig) || typeof parsedConfig !== "object") {
        return { ok: false, message: "Config must be a JSON object." };
      }
    }
    const scope = text(formData, "scope") || "global";
    const result = await apiPost("/api/admin/config-profiles", {
      id: text(formData, "id"),
      name: text(formData, "name"),
      scope,
      targetId: scope === "global" ? null : text(formData, "targetId"),
      priority: Number(text(formData, "priority") || 0),
      rolloutPercent: Number(text(formData, "rolloutPercent") || 100),
      enabled: !bool(formData, "disabled"),
      config: parsedConfig,
    });
    revalidatePath("/admin/config");
    return { ok: true, message: `Config profile ${result.id} saved.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to save config profile." };
  }
}

export async function createReleaseStateAction(_previousState, formData) {
  return createReleaseAction(formData);
}

export async function createModelProviderAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  try {
    const result = await apiPost("/api/admin/model-providers", {
      id: text(formData, "id"),
      label: text(formData, "label") || text(formData, "id"),
      type: text(formData, "type") || "anthropic",
      baseUrl: text(formData, "baseUrl"),
      apiKey: text(formData, "apiKey"), // empty = keep existing key
      defaultModel: text(formData, "defaultModel"),
      models: text(formData, "models")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      enabled: !bool(formData, "disabled"),
    });
    revalidatePath("/admin/config");
    return { ok: true, message: `Provider ${result.id} saved.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to save provider." };
  }
}

export async function deleteModelProviderAction(formData) {
  await apiDelete(`/api/admin/model-providers/${text(formData, "id")}`);
  revalidatePath("/admin/config");
}

export async function createConfigGroupAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  try {
    const result = await apiPost("/api/admin/config-groups", {
      id: text(formData, "id"),
      name: text(formData, "name"),
    });
    revalidatePath("/admin/config");
    return { ok: true, message: `Group ${result.id} saved.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to save group." };
  }
}

export async function assignConfigGroupAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  try {
    await apiPost("/api/admin/config-groups/assign", {
      kind: text(formData, "kind") || "device",
      id: text(formData, "targetId"),
      groupId: text(formData, "groupId") || null,
    });
    revalidatePath("/admin/config");
    return { ok: true, message: "Membership updated." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to update membership." };
  }
}

export async function deleteConfigGroupAction(formData) {
  await apiDelete(`/api/admin/config-groups/${text(formData, "id")}`);
  revalidatePath("/admin/config");
}

export async function setLicenseStatusAction(formData) {
  await apiPatch(`/api/admin/licenses/${text(formData, "id")}`, { status: text(formData, "status") });
  revalidatePath("/admin/licenses");
}

export async function updateLicenseAction(formData) {
  const expiresAt = new Date(text(formData, "expiresAt"));
  await apiPatch(`/api/admin/licenses/${text(formData, "id")}`, {
    customerName: text(formData, "customerName") || null,
    plan: text(formData, "plan") || "pro",
    seats: Number(text(formData, "seats") || 1),
    expiresAt: expiresAt.toISOString(),
    status: text(formData, "status") || "active",
    features: text(formData, "features")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  });
  revalidatePath("/admin/licenses");
  revalidatePath(`/admin/licenses/${text(formData, "id")}`);
}

export async function setLicenseDeviceStatusAction(formData) {
  await apiPatch(`/api/admin/license-devices/${text(formData, "id")}`, { status: text(formData, "status") });
  revalidatePath("/admin/devices");
}

export async function removeLicenseDeviceAction(formData) {
  await apiDelete(`/api/admin/license-devices/${text(formData, "id")}`);
  revalidatePath("/admin/devices");
}

export async function setReleaseEnabledAction(formData) {
  await apiPatch(`/api/admin/releases/${text(formData, "id")}`, { enabled: text(formData, "enabled") === "true" });
  revalidatePath("/admin/releases");
}

export async function setRuntimePackEnabledAction(formData) {
  await apiPatch(`/api/admin/runtime-packs/${text(formData, "id")}`, { enabled: text(formData, "enabled") === "true" });
  revalidatePath("/admin/runtime-packs");
}

export async function setSkillPackageEnabledAction(formData) {
  await apiPatch(`/api/admin/skill-packages/${text(formData, "id")}`, { enabled: text(formData, "enabled") === "true" });
  revalidatePath("/admin/skill-packages");
}

export async function setWorkspaceAppEnabledAction(formData) {
  await apiPatch(`/api/admin/workspace-apps/${text(formData, "id")}`, { enabled: text(formData, "enabled") === "true" });
  revalidatePath("/admin/apps");
}

export async function setConfigProfileEnabledAction(formData) {
  await apiPatch(`/api/admin/config-profiles/${text(formData, "id")}`, { enabled: text(formData, "enabled") === "true" });
  revalidatePath("/admin/config");
}

export async function rollbackConfigProfileAction(formData) {
  await apiPost(`/api/admin/config-profiles/${text(formData, "id")}/rollback`, {});
  revalidatePath("/admin/config");
}

export async function updateSettingsAction(formData) {
  await apiPatch("/api/admin/settings", {
    licenseTrialDays: Number(text(formData, "licenseTrialDays") || 0),
    modelDeliveryMode: text(formData, "modelDeliveryMode") || undefined,
    mediaDeliveryMode: text(formData, "mediaDeliveryMode") || undefined,
    qiniu: {
      publicBaseUrl: text(formData, "qiniuPublicBaseUrl"),
      accessKey: text(formData, "qiniuAccessKey"),
      secretKey: text(formData, "qiniuSecretKey") || null,
      bucket: text(formData, "qiniuBucket"),
      uploadUrl: text(formData, "qiniuUploadUrl") || "https://upload.qiniup.com",
    },
  });
  revalidatePath("/admin/settings");
  revalidatePath("/admin/devices");
}

export async function loginAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  const email = text(formData, "email");
  const password = text(formData, "password");
  if (!email || !password) return { ok: false, message: "Email and password are required." };
  const response = await fetch(`${API_BASE}/api/admin/login`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).catch(() => null);
  if (!response?.ok) {
    return { ok: false, message: "Login failed. Check the email and password." };
  }

  const sessionCookie = response.headers
    .get("set-cookie")
    ?.match(/(?:^|,?\s*)lily_admin_session=([^;]+)/)?.[1];
  if (!sessionCookie) return { ok: false, message: "Login succeeded but no admin session was returned." };

  const store = await cookies();
  store.delete("lily_admin_token");
  store.set("lily_admin_session", decodeURIComponent(sessionCookie), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  redirect("/admin");
}

export async function logoutAction() {
  const store = await cookies();
  store.delete("lily_admin_token");
  store.delete("lily_admin_session");
  redirect("/admin/login");
}
