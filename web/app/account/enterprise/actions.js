"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { userApiPost, userApiPatch, userApiDelete } from "../../../lib/user-api";
import { getI18n } from "../../../lib/i18n.mjs";
import { enterpriseMessage } from "../../../lib/enterprise-messages.mjs";
import { consoleErrorMessage, enterpriseConsoleText, fill, formatDate } from "../../../lib/enterprise-console-i18n.mjs";

// Organizations are opened by the platform (the server answers
// ORG_CREATE_PLATFORM_ONLY to every self-serve create), so there is no
// create action here any more.

async function localeText() {
  const { locale } = await getI18n();
  return { locale, text: enterpriseConsoleText(locale) };
}

const orgPath = (organizationId) => `/api/enterprise/organizations/${encodeURIComponent(organizationId)}`;

/** Refresh the organization's layout and every page under it. */
function refresh(organizationId) {
  revalidatePath(`/account/enterprise/${organizationId}`, "layout");
  revalidatePath("/account/enterprise");
}

/** "" -> null (unlimited / use default), a whole number >= 0 -> that number, anything else -> undefined (invalid). */
function optionalWholeNumber(raw) {
  const value = String(raw ?? "").trim();
  if (value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

async function run(locale, work) {
  try {
    return await work();
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: consoleErrorMessage(error, locale) };
  }
}

/** Rename and/or set the default weekly budget (admin+). */
export async function saveOrganizationSettingsAction(organizationId, formData) {
  const { locale, text } = await localeText();
  const body = {};
  if (formData.has("name")) {
    const name = String(formData.get("name") || "").trim();
    if (!name || name.length > 120) return { ok: false, message: enterpriseMessage("VALIDATION_ERROR", locale) };
    body.name = name;
  }
  if (formData.has("defaultMemberWeeklyBudget")) {
    const budget = optionalWholeNumber(formData.get("defaultMemberWeeklyBudget"));
    if (budget === undefined) return { ok: false, message: enterpriseMessage("WEEKLY_BUDGET_INVALID", locale) };
    body.defaultMemberWeeklyBudget = budget;
  }
  if (!Object.keys(body).length) return { ok: false, message: enterpriseMessage("VALIDATION_ERROR", locale) };
  return run(locale, async () => {
    await userApiPatch(orgPath(organizationId), body);
    refresh(organizationId);
    return { ok: true, message: text.common.saved };
  });
}

/** The owner's own pause / resume. Resuming never lifts a platform freeze, and says so. */
export async function setOrganizationPausedAction(organizationId, paused) {
  const { locale, text } = await localeText();
  return run(locale, async () => {
    const result = await userApiPatch(orgPath(organizationId), { status: paused ? "disabled" : "active" });
    refresh(organizationId);
    if (paused) return { ok: true, message: text.settings.pausedDone };
    const frozen = result?.organization?.platform_status === "suspended" || result?.organization?.status === "disabled";
    return { ok: true, message: frozen ? text.settings.resumedButFrozen : text.settings.resumedDone };
  });
}

export async function transferOwnershipAction(organizationId, formData) {
  const { locale, text } = await localeText();
  const userId = String(formData.get("userId") || "").trim();
  if (!userId) return { ok: false, message: enterpriseMessage("MEMBER_TARGET_REQUIRED", locale) };
  return run(locale, async () => {
    await userApiPost(`${orgPath(organizationId)}/transfer-ownership`, { userId });
    refresh(organizationId);
    return { ok: true, message: text.settings.transferredDone };
  });
}

export async function leaveOrganizationAction(organizationId) {
  const { locale } = await localeText();
  return run(locale, async () => {
    await userApiPost(`${orgPath(organizationId)}/leave`, {});
    revalidatePath("/account/enterprise");
    redirect("/account/enterprise");
  });
}

/** Add by phone (registered -> member, unregistered -> pending seat) or by user ID. */
export async function addMemberAction(organizationId, formData) {
  const { locale, text } = await localeText();
  const userId = String(formData.get("userId") || "").trim();
  const phoneE164 = String(formData.get("phoneE164") || "").trim();
  const role = String(formData.get("role") || "member").trim() === "admin" ? "admin" : "member";
  if (!userId && !phoneE164) return { ok: false, message: enterpriseMessage("MEMBER_TARGET_REQUIRED", locale) };
  return run(locale, async () => {
    const result = await userApiPost(`${orgPath(organizationId)}/members`, {
      ...(userId ? { userId } : { phoneE164 }),
      role,
    });
    refresh(organizationId);
    if (result?.invitation) return { ok: true, message: fill(text.members.invited, { date: formatDate(result.invitation.expires_at, locale) }) };
    return { ok: true, message: text.members.addedMember };
  });
}

/** Bring a removed issued account back into the organization (its login comes back with it). */
export async function restoreAccountAction(organizationId, userId) {
  const { locale, text } = await localeText();
  return run(locale, async () => {
    await userApiPost(`${orgPath(organizationId)}/members`, { userId, role: "member" });
    refresh(organizationId);
    return { ok: true, message: text.accounts.restored };
  });
}

/** Role, weekly budget and per-request cap from the member's edit form. */
export async function patchMemberAction(organizationId, userId, formData) {
  const { locale, text } = await localeText();
  const body = {};
  // The form carries each field's value as it was shown; only what the admin
  // actually changed is sent, so the history reads "budget 500 -> 800", not a
  // re-save of every field.
  const changed = (name) => formData.has(name) && String(formData.get(name) ?? "").trim() !== String(formData.get(`${name}Was`) ?? "").trim();
  const role = String(formData.get("role") || "").trim();
  if ((role === "member" || role === "admin") && changed("role")) body.role = role;
  if (changed("weeklyBudget")) {
    const budget = optionalWholeNumber(formData.get("weeklyBudget"));
    if (budget === undefined) return { ok: false, message: enterpriseMessage("WEEKLY_BUDGET_INVALID", locale) };
    body.weeklyBudget = budget;
  }
  if (changed("quota")) {
    const quota = optionalWholeNumber(formData.get("quota"));
    if (quota === undefined) return { ok: false, message: text.members.capInvalid };
    body.memberQuota = quota;
  }
  if (!Object.keys(body).length) return { ok: true, message: text.common.saved };
  return run(locale, async () => {
    await userApiPatch(`${orgPath(organizationId)}/members/${encodeURIComponent(userId)}`, body);
    refresh(organizationId);
    return { ok: true, message: text.common.saved };
  });
}

export async function setMemberStatusAction(organizationId, userId, status) {
  const { locale, text } = await localeText();
  const next = status === "disabled" ? "disabled" : "active";
  return run(locale, async () => {
    await userApiPatch(`${orgPath(organizationId)}/members/${encodeURIComponent(userId)}`, { status: next });
    refresh(organizationId);
    return { ok: true, message: next === "disabled" ? text.members.disabledDone : text.members.enabledDone };
  });
}

export async function removeMemberAction(organizationId, userId) {
  const { locale, text } = await localeText();
  return run(locale, async () => {
    await userApiDelete(`${orgPath(organizationId)}/members/${encodeURIComponent(userId)}`);
    refresh(organizationId);
    return { ok: true, message: text.members.removedDone };
  });
}

/** Withdraw a seat handed to someone who has not signed up yet. */
export async function revokeInvitationAction(organizationId, invitationId) {
  const { locale, text } = await localeText();
  return run(locale, async () => {
    await userApiDelete(`${orgPath(organizationId)}/invitations/${encodeURIComponent(invitationId)}`);
    refresh(organizationId);
    return { ok: true, message: text.invitations.revoked };
  });
}

/**
 * Issue dedicated accounts. The initial passwords come back exactly once and
 * are never stored: they travel only in this action's result to the form that
 * asked, so reloading forgets them, which is the point.
 */
export async function provisionAccountsAction(organizationId, formData) {
  const { locale, text } = await localeText();
  const raw = String(formData.get("loginNames") || "").trim();
  const prefix = String(formData.get("prefix") || "").trim();
  const count = Math.max(0, Math.min(100, Math.trunc(Number(formData.get("count") || 0)) || 0));
  const role = String(formData.get("role") || "member").trim() === "admin" ? "admin" : "member";
  const named = raw.split(/[\n,，;；\s]+/).map((v) => v.trim()).filter(Boolean).map((loginName) => ({ loginName, role }));
  // Three ways to name a batch, most specific first: an explicit list; a
  // prefix the server numbers (MAX -> max_0001..); or a count of random names.
  let body;
  if (named.length) body = { accounts: named };
  else if (prefix && count) body = { pattern: { prefix, count, role } };
  else if (count) body = { accounts: Array.from({ length: count }, () => ({ role })) };
  else return { ok: false, message: enterpriseMessage("ACCOUNTS_REQUIRED", locale) };
  return run(locale, async () => {
    const result = await userApiPost(`${orgPath(organizationId)}/accounts`, body);
    refresh(organizationId);
    const issued = Array.isArray(result?.accounts) ? result.accounts : [];
    return { ok: true, message: fill(text.accounts.issuedN, { n: issued.length }), issued: issued.map((a) => ({ l: a.loginName, p: a.initialPassword })) };
  });
}

export async function resetAccountPasswordAction(organizationId, userId) {
  const { locale, text } = await localeText();
  return run(locale, async () => {
    const result = await userApiPost(`${orgPath(organizationId)}/accounts/${encodeURIComponent(userId)}/reset-password`, {});
    refresh(organizationId);
    return { ok: true, message: text.accounts.resetDone, issued: [{ l: result.loginName, p: result.initialPassword }] };
  });
}
