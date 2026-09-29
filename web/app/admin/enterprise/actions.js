"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { apiPatch, apiPostResult } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";
import { formatAdminMessage } from "../../../lib/admin-messages.mjs";
import { enterpriseMessage } from "../../../lib/enterprise-messages.mjs";

/**
 * Platform-side enterprise governance: create + hand off, freeze / unfreeze,
 * rename, the default weekly budget, quota grants and taking them back.
 *
 * Every answer is a sentence in the operator's language: a server code goes
 * through enterpriseMessage, our own outcomes through the admin catalog. A raw
 * code ("GRANT_NOT_ACTIVE") never reaches the page.
 */

async function lang() {
  const { locale } = await getI18n();
  return ["zh", "en", "ar"].includes(locale) ? locale : "zh";
}

async function say(key, params = {}) {
  return formatAdminMessage(key, await lang(), params);
}

async function failed(codeOrError) {
  return { ok: false, message: enterpriseMessage(codeOrError, await lang()) };
}

async function resourceName(resourceType) {
  const { t } = await getI18n();
  return t?.admin?.enterprise?.resource?.[resourceType] || resourceType;
}

function formatUnits(value, locale) {
  return Number(value || 0).toLocaleString(locale === "zh" ? "zh-CN" : locale === "ar" ? "ar" : "en-US");
}

function wholeNumber(raw) {
  const text = String(raw ?? "").replace(/[,\s，_]/g, "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function refresh(organizationId) {
  revalidatePath("/admin/enterprise");
  if (organizationId) revalidatePath(`/admin/enterprise/${organizationId}`);
}

const orgPath = (id) => `/api/admin/enterprise/organizations/${encodeURIComponent(id)}`;

/**
 * Create an organization for a customer and hand it to its first owner.
 *
 * An issued owner's one-time password comes back in the action's own result
 * and is rendered by the form that asked for it. It used to ride a redirect in
 * the URL hash, but Next drops the hash from the redirect it replays on the
 * client (createHrefFromUrl(url, false)), so the password could vanish before
 * the page read it — the one thing that must never be lost silently. A phone
 * owner has no secret to show, so that path still opens the new organization.
 */
export async function createOrganizationAction(formData) {
  const name = String(formData.get("name") || "").trim();
  const plan = String(formData.get("plan") || "").trim() || "standard";
  const mode = String(formData.get("ownerMode") || "issue").trim();
  const phoneE164 = String(formData.get("ownerPhone") || "").trim();
  const loginName = String(formData.get("ownerLoginName") || "").trim();
  const displayName = String(formData.get("ownerDisplayName") || "").trim();
  if (!name) return { ok: false, message: await say("enterpriseNameRequired") };
  if (mode === "phone" && !phoneE164) return { ok: false, message: await say("enterpriseOwnerPhoneRequired") };
  const owner = mode === "phone"
    ? { phoneE164 }
    : { issue: true, ...(loginName ? { loginName } : {}), ...(displayName ? { displayName } : {}) };
  try {
    const result = await apiPostResult("/api/admin/enterprise/organizations", { name, plan, owner });
    if (!result.ok) return failed(result.json?.code || "INTERNAL_ERROR");
    refresh();
    const id = result.json?.organization?.id || "";
    const issued = result.json?.owner;
    if (issued?.issued && issued.initialPassword) {
      return {
        ok: true,
        message: await say("enterpriseCreatedIssued", { name }),
        organizationId: id,
        issued: [{ l: issued.loginName, p: issued.initialPassword }],
      };
    }
    redirect(id ? `/admin/enterprise/${encodeURIComponent(id)}` : "/admin/enterprise");
  } catch (error) {
    unstable_rethrow(error);
    return failed(error);
  }
}

async function patchOrganization(organizationId, body, successKey, params = {}) {
  try {
    await apiPatch(orgPath(organizationId), body);
    refresh(organizationId);
    return { ok: true, message: await say(successKey, params) };
  } catch (error) {
    unstable_rethrow(error);
    return failed(error);
  }
}

/** The platform's freeze. A reason is required: it is what the history and the enterprise will read. */
export async function freezeOrganizationAction(organizationId, formData) {
  const reason = String(formData.get("reason") || "").trim().slice(0, 200);
  if (!reason) return { ok: false, message: await say("enterpriseFreezeReasonRequired") };
  return patchOrganization(organizationId, { platformStatus: "suspended", reason }, "enterpriseFrozen");
}

/** Lifts only the platform's freeze; the owner's own pause is theirs to lift. */
export async function unfreezeOrganizationAction(organizationId) {
  return patchOrganization(organizationId, { platformStatus: "active" }, "enterpriseUnfrozen");
}

export async function renameOrganizationAction(organizationId, formData) {
  const name = String(formData.get("name") || "").trim();
  if (!name || name.length > 120) return { ok: false, message: await say("enterpriseNameRequired") };
  return patchOrganization(organizationId, { name }, "enterpriseRenamed", { name });
}

/** Empty = unlimited (null); otherwise a whole number of units, ≥ 0. */
export async function setDefaultWeeklyBudgetAction(organizationId, formData) {
  const raw = String(formData.get("defaultMemberWeeklyBudget") ?? "").trim();
  if (!raw) return patchOrganization(organizationId, { defaultMemberWeeklyBudget: null }, "enterpriseBudgetCleared");
  const value = wholeNumber(raw);
  if (value === null) return failed("WEEKLY_BUDGET_INVALID");
  return patchOrganization(organizationId, { defaultMemberWeeklyBudget: value }, "enterpriseBudgetSaved", { units: formatUnits(value, await lang()) });
}

/**
 * Add a grant to the organization's pool. The idempotency key is minted once
 * per form render, so a retry after a timeout returns the first grant instead
 * of granting twice.
 */
export async function grantOrganizationQuotaAction(organizationId, formData) {
  const resourceType = String(formData.get("resourceType") || "").trim();
  const unitTotal = wholeNumber(formData.get("unitTotal"));
  const expiresDays = wholeNumber(formData.get("expiresDays") || "365");
  const idempotencyKey = String(formData.get("idempotencyKey") || "").trim();
  const note = String(formData.get("note") || "").trim().slice(0, 200);
  if (!["token", "image_generation", "video_generation"].includes(resourceType)) return failed("VALIDATION_ERROR");
  if (!unitTotal || unitTotal < 1 || unitTotal > 1000000000) return { ok: false, message: await say("enterpriseGrantInvalidUnits") };
  if (!expiresDays || expiresDays < 1 || expiresDays > 3650) return { ok: false, message: await say("enterpriseGrantInvalidDays") };
  try {
    const result = await apiPostResult(`${orgPath(organizationId)}/grants`, {
      resourceType,
      unitTotal,
      expiresDays,
      ...(idempotencyKey.length >= 8 ? { idempotencyKey: idempotencyKey.slice(0, 120) } : {}),
      ...(note ? { note } : {}),
    });
    if (!result.ok) return failed(result.json?.code || "INTERNAL_ERROR");
    refresh(organizationId);
    const locale = await lang();
    const params = { amount: `${formatUnits(unitTotal, locale)} ${await resourceName(resourceType)}`, days: expiresDays };
    return {
      ok: true,
      granted: true,
      message: await say(result.json?.idempotent ? "enterpriseGrantIdempotent" : "enterpriseGranted", params),
    };
  } catch (error) {
    unstable_rethrow(error);
    return failed(error);
  }
}

async function reduceGrant(organizationId, grantId, body, successKey) {
  try {
    const result = await apiPostResult(`${orgPath(organizationId)}/grants/${encodeURIComponent(grantId)}/reduce`, body);
    if (!result.ok) return failed(result.json?.code || "INTERNAL_ERROR");
    refresh(organizationId);
    return { ok: true, message: await say(successKey, { units: formatUnits(result.json?.taken, await lang()) }) };
  } catch (error) {
    unstable_rethrow(error);
    return failed(error);
  }
}

/** Take back part of what is left in one grant — a typo'd grant is no longer permanent. */
export async function reduceGrantAction(organizationId, grantId, formData) {
  const units = wholeNumber(formData.get("units"));
  const reason = String(formData.get("reason") || "").trim().slice(0, 200);
  if (!units || units < 1) return { ok: false, message: await say("enterpriseReduceInvalidUnits") };
  if (!reason) return { ok: false, message: await say("enterpriseReduceReasonRequired") };
  return reduceGrant(organizationId, grantId, { units, reason }, "enterpriseReduced");
}

/** Revoke a grant: everything still left in it comes back, and it stays revoked. */
export async function revokeGrantAction(organizationId, grantId, formData) {
  const reason = String(formData.get("reason") || "").trim().slice(0, 200);
  if (!reason) return { ok: false, message: await say("enterpriseReduceReasonRequired") };
  return reduceGrant(organizationId, grantId, { all: true, reason }, "enterpriseRevoked");
}

/** Only while the owner has not activated: afterwards the account is the enterprise's own. */
export async function reissueOwnerInitialPasswordAction(organizationId, userId) {
  try {
    const result = await apiPostResult(`${orgPath(organizationId)}/owner-initial-password`, { userId });
    if (!result.ok) return failed(result.json?.code || "INTERNAL_ERROR");
    const owner = result.json?.owner || {};
    refresh(organizationId);
    return { ok: true, message: await say("enterpriseOwnerPasswordReissued"), issued: [{ l: owner.loginName, p: owner.initialPassword }] };
  } catch (error) {
    unstable_rethrow(error);
    return failed(error);
  }
}
