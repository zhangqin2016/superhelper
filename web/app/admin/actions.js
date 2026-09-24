"use server";

import { adminMessage } from "../../lib/admin-messages.mjs";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { API_BASE, apiDelete, apiPatch, apiPost, apiPostForm, apiPostResult } from "../../lib/api";

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

function commaList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function jsonMap(value) {
  if (!String(value || "").trim()) return {};
  const parsed = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("i18n fields must be JSON objects.");
  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item || "").trim()]).filter(([, item]) => item));
}

export async function createLicenseAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  try {
    const expiresAt = new Date(text(formData, "expiresAt"));
    if (Number.isNaN(expiresAt.getTime())) {
      return { ok: false, message: await adminMessage("licenseInvalidExpiry") };
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
      message: await adminMessage("licenseCreated"),
      licenseId: result.licenseId,
      licenseKey: result.licenseKey,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : await adminMessage("licenseFailed") };
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
    return { ok: true, message: await adminMessage("releaseCreated", { id: result.id }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : await adminMessage("releaseFailed") };
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
    return { ok: true, message: await adminMessage("skillUploaded", { id: result.skillId }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : await adminMessage("skillFailed") };
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
      "minPlan",
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
    return { ok: true, message: await adminMessage("appUploaded", { id: result.appId }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : await adminMessage("appFailed") };
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
        return { ok: false, message: await adminMessage("configNotObject") };
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
    revalidatePath("/admin/config/profiles");
    return { ok: true, message: await adminMessage("configProfileSaved", { id: result.id }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : await adminMessage("configProfileFailed") };
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
      secretKey: text(formData, "secretKey"), // empty = keep existing (Kling)
      groupId: text(formData, "groupId"), // MiniMax GroupId
      nativeVision: bool(formData, "nativeVision"),
      defaultModel: text(formData, "defaultModel"),
      models: text(formData, "models")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      enabled: !bool(formData, "disabled"),
    });
    revalidatePath("/admin/config");
    revalidatePath("/admin/config/providers");
    return { ok: true, message: await adminMessage("providerSaved", { id: result.id }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : await adminMessage("providerFailed") };
  }
}

export async function deleteModelProviderAction(formData) {
  await apiDelete(`/api/admin/model-providers/${text(formData, "id")}`);
  revalidatePath("/admin/config");
  revalidatePath("/admin/config/providers");
}

export async function createConfigGroupAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  try {
    const result = await apiPost("/api/admin/config-groups", {
      id: text(formData, "id"),
      name: text(formData, "name"),
    });
    revalidatePath("/admin/config");
    revalidatePath("/admin/config/groups");
    return { ok: true, message: await adminMessage("groupSaved", { id: result.id }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : await adminMessage("groupFailed") };
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
    revalidatePath("/admin/config/groups");
    return { ok: true, message: await adminMessage("membershipUpdated") };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : await adminMessage("membershipFailed") };
  }
}

export async function deleteConfigGroupAction(formData) {
  await apiDelete(`/api/admin/config-groups/${text(formData, "id")}`);
  revalidatePath("/admin/config");
  revalidatePath("/admin/config/groups");
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
  revalidatePath(`/admin/licenses/${text(formData, "id")}/edit`);
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

// A rollout transition the server refuses (another version already rolling, a
// partial rollout without its own feed) is an answer, not a crash: it comes
// back to the page as a notice.
export async function rolloutAction(formData) {
  const percent = Number(text(formData, "percent"));
  let failure = "";
  try {
    await apiPatch(`/api/admin/rollouts/${text(formData, "id")}`, {
      action: text(formData, "action"),
      ...(Number.isInteger(percent) && percent > 0 ? { percent } : {}),
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  revalidatePath("/admin/releases");
  revalidatePath("/admin");
  if (failure) redirect(`/admin/releases?rolloutError=${encodeURIComponent(failure.slice(0, 300))}`);
}

// A channel × platform support policy: minimum supported version, blocked
// versions, deadline. "block"/"unblock" edit the list for one version.
export async function setReleaseSupportAction(formData) {
  const channel = text(formData, "channel") || "stable";
  const platform = text(formData, "platform");
  const op = text(formData, "op");
  let body;
  if (op === "block" || op === "unblock") {
    const current = text(formData, "blocked").split(",").map((v) => v.trim()).filter(Boolean);
    const version = text(formData, "version");
    body = { blockedVersions: op === "block" ? [...new Set([...current, version])] : current.filter((v) => v !== version), reason: op };
  } else {
    const deadline = text(formData, "mandateDeadline");
    body = {
      minSupportedVersion: text(formData, "minSupportedVersion"),
      blockedVersions: text(formData, "blockedVersions").split(",").map((v) => v.trim()).filter(Boolean),
      mandateDeadline: deadline ? new Date(deadline).toISOString() : "",
    };
  }
  let failure = "";
  try {
    await apiPatch(`/api/admin/release-support/${encodeURIComponent(channel)}/${encodeURIComponent(platform)}`, body);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  revalidatePath("/admin/releases");
  revalidatePath("/admin");
  if (failure) redirect(`/admin/releases?rolloutError=${encodeURIComponent(failure.slice(0, 300))}`);
}

export async function setReleaseForceAction(formData) {
  await apiPatch(`/api/admin/releases/${text(formData, "id")}`, { forceUpdate: text(formData, "forceUpdate") === "true" });
  revalidatePath("/admin/releases");
  revalidatePath("/admin");
}

export async function setContactStatusAction(formData) {
  await apiPatch(`/api/admin/contact-requests/${text(formData, "id")}`, { status: text(formData, "status") === "handled" ? "handled" : "new" });
  revalidatePath("/admin/contacts");
}

export async function setRuntimePackEnabledAction(formData) {
  await apiPatch(`/api/admin/runtime-packs/${text(formData, "id")}`, { enabled: text(formData, "enabled") === "true" });
  revalidatePath("/admin/runtime-packs");
}

export async function setSkillPackageEnabledAction(formData) {
  await apiPatch(`/api/admin/skill-packages/${text(formData, "id")}`, { enabled: text(formData, "enabled") === "true" });
  revalidatePath("/admin/skill-packages");
}

// --- Agent packages (智能体分发) -------------------------------------------------
// The definition is authored as JSON. The server is the validator; we only
// pre-parse so an obvious JSON typo is caught without a round trip, and we pass
// the server's structured body (code / field / issues) through untouched so the
// form can highlight the offending field.
export async function saveAgentPackageAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  const parseJson = (key, label) => {
    const raw = text(formData, key);
    if (!raw) return { value: null };
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return { error: `${label} must be a JSON object.` };
      return { value: parsed };
    } catch (error) {
      return { error: `${label}: ${error instanceof Error ? error.message : "invalid JSON"}` };
    }
  };
  try {
    const definition = parseJson("definition", "Definition");
    if (definition.error) return { ok: false, message: definition.error, field: "definition", issues: [] };
    if (!definition.value) return { ok: false, message: await adminMessage("agentDefinitionRequired"), field: "definition", issues: [] };
    const roleCard = parseJson("roleCard", "Role card");
    if (roleCard.error) return { ok: false, message: roleCard.error, field: "roleCard", issues: [] };
    const scopeType = text(formData, "scopeType") || "global";
    const result = await apiPostResult("/api/admin/agent-packages", {
      agentId: text(formData, "agentId"),
      version: text(formData, "version"),
      channel: text(formData, "channel") || "stable",
      scopeType,
      organizationId: scopeType === "organization" ? text(formData, "organizationId") : null,
      publisher: text(formData, "publisher") || null,
      minAppVersion: text(formData, "minAppVersion") || null,
      featured: bool(formData, "featured"),
      displayInCatalog: !bool(formData, "hideFromCatalog"),
      enabled: !bool(formData, "disabled"),
      definition: definition.value,
      roleCard: roleCard.value,
    });
    if (!result.ok) {
      const body = result.json || {};
      return {
        ok: false,
        code: body.code || `HTTP_${result.status}`,
        message: body.message || body.code || `API failed: ${result.status}`,
        field: body.field || null,
        issues: Array.isArray(body.issues) ? body.issues : [],
      };
    }
    revalidatePath("/admin/agents");
    return { ok: true, message: await adminMessage("agentSaved", { id: result.json.agentId, action: result.json.created ? "published" : "updated" }), id: result.json.id, issues: [] };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : await adminMessage("agentFailed"), issues: [] };
  }
}

export async function setAgentPackageEnabledAction(formData) {
  await apiPatch(`/api/admin/agent-packages/${text(formData, "id")}`, { enabled: text(formData, "enabled") === "true" });
  revalidatePath("/admin/agents");
}

export async function setAgentPackageFeaturedAction(formData) {
  await apiPatch(`/api/admin/agent-packages/${text(formData, "id")}`, { featured: text(formData, "featured") === "true" });
  revalidatePath("/admin/agents");
}

export async function setWorkspaceAppEnabledAction(formData) {
  await apiPatch(`/api/admin/workspace-apps/${text(formData, "id")}`, { enabled: text(formData, "enabled") === "true" });
  revalidatePath("/admin/apps");
}

export async function updateWishAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  const id = text(formData, "id");
  try {
    await apiPatch(`/api/admin/wishes/${id}`, {
      publicTitle: text(formData, "publicTitle") || null,
      publicTitleI18n: jsonMap(text(formData, "publicTitleI18n")),
      publicSummary: text(formData, "publicSummary") || null,
      publicSummaryI18n: jsonMap(text(formData, "publicSummaryI18n")),
      publicUpdate: text(formData, "publicUpdate") || null,
      publicUpdateI18n: jsonMap(text(formData, "publicUpdateI18n")),
      submitterStatusNote: text(formData, "submitterStatusNote") || null,
      category: text(formData, "category") || "other",
      status: text(formData, "status") || "reviewing",
      linkedAppIds: commaList(text(formData, "linkedAppIds")),
      linkedSkillIds: commaList(text(formData, "linkedSkillIds")),
    });
    revalidatePath("/admin/wishes");
    revalidatePath(`/admin/wishes/${id}`);
    return { ok: true, message: await adminMessage("wishUpdated") };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : await adminMessage("wishFailed") };
  }
}

export async function mergeWishAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  const id = text(formData, "id");
  try {
    await apiPost(`/api/admin/wishes/${id}/merge`, { targetWishId: text(formData, "targetWishId") });
    revalidatePath("/admin/wishes");
    revalidatePath(`/admin/wishes/${id}`);
    return { ok: true, message: await adminMessage("wishMerged") };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : await adminMessage("wishMergeFailed") };
  }
}

export async function setConfigProfileEnabledAction(formData) {
  await apiPatch(`/api/admin/config-profiles/${text(formData, "id")}`, { enabled: text(formData, "enabled") === "true" });
  revalidatePath("/admin/config");
  revalidatePath("/admin/config/profiles");
}

export async function rollbackConfigProfileAction(formData) {
  await apiPost(`/api/admin/config-profiles/${text(formData, "id")}/rollback`, {});
  revalidatePath("/admin/config");
  revalidatePath("/admin/config/profiles");
}

export async function deleteConfigProfileAction(formData) {
  await apiDelete(`/api/admin/config-profiles/${text(formData, "id")}`);
  revalidatePath("/admin/config");
  revalidatePath("/admin/config/profiles");
}

export async function updateSettingsAction(formData) {
  const section = text(formData, "settingsSection") || "all";
  const payload = {
    licenseTrialDays: Number(text(formData, "licenseTrialDays") || 0),
  };
  if (section === "all" || section === "delivery") {
    payload.modelDeliveryMode = text(formData, "modelDeliveryMode") || undefined;
    payload.mediaDeliveryMode = text(formData, "mediaDeliveryMode") || undefined;
  }
  if (section === "all" || section === "qiniu") {
    payload.qiniu = {
      publicBaseUrl: text(formData, "qiniuPublicBaseUrl"),
      accessKey: text(formData, "qiniuAccessKey"),
      secretKey: text(formData, "qiniuSecretKey") || null,
      bucket: text(formData, "qiniuBucket"),
      uploadUrl: text(formData, "qiniuUploadUrl") || "https://upload.qiniup.com",
    };
  }
  if (section === "all" || section === "sms") {
    payload.aliyunSms = {
      accessKeyId: text(formData, "aliyunSmsAccessKeyId"),
      accessKeySecret: text(formData, "aliyunSmsAccessKeySecret") || null,
      signName: text(formData, "aliyunSmsSignName"),
      templateLogin: text(formData, "aliyunSmsTemplateLogin"),
      region: text(formData, "aliyunSmsRegion") || "cn-hangzhou",
    };
  }
  if (section === "all" || section === "payment") {
    payload.payment = {
      fakePaymentsEnabled: bool(formData, "paymentFakePaymentsEnabled"),
      alipay: {
        enabled: bool(formData, "alipayEnabled"),
        appId: text(formData, "alipayAppId"),
        merchantId: text(formData, "alipayMerchantId"),
        publicKey: text(formData, "alipayPublicKey"),
        privateKey: text(formData, "alipayPrivateKey") || null,
        notifyUrl: text(formData, "alipayNotifyUrl"),
        returnUrl: text(formData, "alipayReturnUrl"),
        sandbox: bool(formData, "alipaySandbox"),
      },
      wechat: {
        enabled: bool(formData, "wechatEnabled"),
        appId: text(formData, "wechatAppId"),
        mchId: text(formData, "wechatMchId"),
        certSerialNo: text(formData, "wechatCertSerialNo"),
        apiV3Key: text(formData, "wechatApiV3Key") || null,
        privateKey: text(formData, "wechatPrivateKey") || null,
        notifyUrl: text(formData, "wechatNotifyUrl"),
        sandbox: bool(formData, "wechatSandbox"),
      },
    };
  }
  await apiPatch("/api/admin/settings", payload);
  revalidatePath("/admin/settings");
  revalidatePath("/admin/config");
  revalidatePath("/admin/config/settings");
  revalidatePath("/admin/config/storage");
  revalidatePath("/admin/config/sms");
  revalidatePath("/admin/config/payment");
  revalidatePath("/admin/devices");
}

export async function loginAction(_previousState, formData) {
  formData = actionFormData(_previousState, formData);
  const email = text(formData, "email");
  const password = text(formData, "password");
  if (!email || !password) return { ok: false, message: await adminMessage("loginMissingCredentials") };
  const response = await fetch(`${API_BASE}/api/admin/login`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).catch(() => null);
  if (!response?.ok) {
    return { ok: false, message: await adminMessage("loginRejected") };
  }

  const sessionCookie = response.headers
    .get("set-cookie")
    ?.match(/(?:^|,?\s*)lily_admin_session=([^;]+)/)?.[1];
  if (!sessionCookie) return { ok: false, message: await adminMessage("loginNoSession") };

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
