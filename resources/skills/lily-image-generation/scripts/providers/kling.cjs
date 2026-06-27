"use strict";

// Kling 可灵 image adapter. Async create + poll. Auth is a per-request HS256 JWT
// (iss=AccessKey, signed with SecretKey). In gateway mode the server signs the
// JWT and the client only holds a short gateway token (KLING_API_KEY); in
// direct/BYOK mode the client holds AccessKey+SecretKey and signs locally.

const { requestJson, sleep, pollIntervalMs, signHs256Jwt } = require("./_shared.cjs");

const DEFAULT_BASE_URL = "https://api-beijing.klingai.com";

function baseUrl(env) {
  return (env.KLING_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

// Gateway mode delivers a ready bearer (KLING_API_KEY). Direct/BYOK delivers
// AccessKey+SecretKey so we mint the JWT here.
function authToken(env, ctx) {
  if (env.KLING_API_KEY) return env.KLING_API_KEY;
  if (env.KLING_ACCESS_KEY && env.KLING_SECRET_KEY) {
    return signHs256Jwt({ accessKey: env.KLING_ACCESS_KEY, secretKey: env.KLING_SECRET_KEY });
  }
  throw new Error(
    ctx.msg(
      "缺少可灵凭证：网关模式需 KLING_API_KEY，直连模式需 KLING_ACCESS_KEY + KLING_SECRET_KEY。",
      "Missing Kling credentials: gateway mode needs KLING_API_KEY, direct mode needs KLING_ACCESS_KEY + KLING_SECRET_KEY.",
    ),
  );
}

module.exports = {
  id: "kling",
  async generate(input, ctx) {
    const env = ctx.env;
    const token = authToken(env, ctx);
    const model = input.model || env.KLING_IMAGE_MODEL || "kling-v1-5";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const payload = {
      model_name: model,
      prompt: input.prompt,
      ...(input.negative_prompt ? { negative_prompt: input.negative_prompt } : {}),
      aspect_ratio: input.aspect_ratio || input.ratio || "16:9",
      n: Number(input.n || 1),
      ...(input.image ? { image: input.image } : {}),
    };

    ctx.logProgress(ctx.msg("正在提交可灵图片任务...", "Submitting Kling image task..."));
    const create = await requestJson(`${baseUrl(env)}/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const taskId = create?.data?.task_id || create?.task_id || "";
    if (!taskId) {
      throw new Error(`${ctx.msg("可灵未返回 task_id。", "Kling did not return a task_id.")}\n${JSON.stringify(create, null, 2)}`);
    }
    ctx.logProgress(ctx.msg(`任务已提交：${taskId}`, `Task submitted: ${taskId}`));

    const deadline = Date.now() + Number(input.timeout_ms || 240_000);
    const taskUrl = `${baseUrl(env)}/v1/images/generations/${encodeURIComponent(taskId)}`;
    const intervalMs = pollIntervalMs(3000);
    let lastStatus = "";
    while (Date.now() < deadline) {
      const data = await requestJson(taskUrl, { method: "GET", headers });
      const status = String(data?.data?.task_status || data?.task_status || "").toLowerCase();
      if (status && status !== lastStatus) {
        ctx.logProgress(ctx.msg(`任务状态：${status}`, `Task status: ${status}`));
        lastStatus = status;
      }
      if (status === "succeed" || status === "succeeded") {
        const images = data?.data?.task_result?.images || data?.task_result?.images || [];
        const urls = images.map((item) => item?.url).filter(Boolean);
        if (!urls.length) {
          throw new Error(
            `${ctx.msg("图片任务完成，但没有找到图片 URL。", "Image task finished but no image URL was returned.")}\n${JSON.stringify(data, null, 2)}`,
          );
        }
        return { taskId, urls };
      }
      if (status === "failed") {
        throw new Error(data?.data?.task_status_msg || data?.message || ctx.msg(`任务失败：${status}`, `Task failed: ${status}`));
      }
      await sleep(intervalMs);
    }
    throw new Error(ctx.msg(`图片生成超时，task_id=${taskId}`, `Image generation timed out, task_id=${taskId}`));
  },
};
