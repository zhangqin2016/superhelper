"use server";

import { revalidatePath } from "next/cache";
import { userApiDelete, userApiPost } from "../../lib/user-api";

function failure(error, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  return {
    ok: false,
    loginRequired: /USER_LOGIN_REQUIRED|WEB_SESSION/.test(message),
    message,
  };
}

export async function toggleWishSupportAction({ wishId, supported }) {
  try {
    const result = supported
      ? await userApiDelete(`/api/wishes/${wishId}/support`)
      : await userApiPost(`/api/wishes/${wishId}/support`, {});
    revalidatePath("/wishes");
    return { ok: true, supported: Boolean(result.supported) };
  } catch (error) {
    return failure(error, "无法更新需求，请稍后重试。");
  }
}

export async function findSimilarWishesAction({ title, locale }) {
  try {
    const result = await userApiPost("/api/wishes/similar", { title, locale });
    return { ok: true, wishes: Array.isArray(result.wishes) ? result.wishes : [] };
  } catch (error) {
    return failure(error, "无法检查相似愿望，请稍后重试。");
  }
}

export async function createWishAction(payload) {
  try {
    const result = await userApiPost("/api/wishes", payload);
    revalidatePath("/wishes");
    revalidatePath("/account/wishes");
    return { ok: true, id: result.id, status: result.status };
  } catch (error) {
    return failure(error, "愿望提交失败，请稍后重试。");
  }
}
