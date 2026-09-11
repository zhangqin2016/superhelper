"use strict";

// Codex-relay image adapter (BYOK). Generates images through a Codex/ChatGPT
// account exposed by the codex-relay proxy — the SAME token the user already
// chats with. The relay auto-injects the Responses built-in `image_generation`
// tool on its /chat/completions path and streams the result back as a markdown
// data-URI image inside the assistant content: `![alt](data:image/png;base64,…)`.
// We drive that path, pull the data-URI out, and save real files — so the image
// lands in the normal media pipeline instead of bloating the chat transcript.
//
// Env (from Settings → image providers, "own"):
//   CODEX_RELAY_API_KEY   member key (cr_…)
//   CODEX_RELAY_BASE_URL  e.g. https://host/codex/v1
//   CODEX_RELAY_IMAGE_MODEL  optional, defaults to the account's Codex model
//
// Streaming is REQUIRED: the image is ~1MB+ and a non-streamed request sits long
// enough that the fronting nginx returns 502. We stream, buffer the full text,
// then extract every data:image occurrence (the payload arrives as one giant SSE
// line split across TCP chunks, so per-chunk line parsing is unsafe — buffer first).

const DEFAULT_MODEL = "gpt-6-astra";
const DATA_IMAGE_RE = /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g;

function apiKey(env) {
  return env.CODEX_RELAY_API_KEY || "";
}
function baseUrl(env) {
  return String(env.CODEX_RELAY_BASE_URL || "").replace(/\/+$/, "");
}

module.exports = {
  id: "codex-relay",
  async generate(input, ctx) {
    const env = ctx.env;
    const key = apiKey(env);
    const base = baseUrl(env);
    if (!key || !base) {
      throw new Error(
        ctx.msg(
          "缺少 Codex 中转配置。请在设置 → 图片服务商中填写中转地址（如 https://…/codex/v1）与 member key。",
          "Missing Codex relay config. Set the relay base URL (e.g. https://…/codex/v1) and member key under Settings → image providers.",
        ),
      );
    }
    // Strip a tier suffix (gpt-6-astra:high -> gpt-6-astra); the relay keys effort
    // off the base id anyway, and image generation does not vary by effort tier.
    const model = String(input.model || env.CODEX_RELAY_IMAGE_MODEL || DEFAULT_MODEL).split(":")[0];
    const directive = input.negative_prompt
      ? `\n\nAvoid: ${input.negative_prompt}`
      : "";
    const text = `Generate an image with your image generation tool. Do not describe it in words, just produce the image.\n\n${input.prompt}${directive}`;
    const body = {
      model,
      stream: true,
      messages: [{ role: "user", content: text }],
    };

    ctx.logProgress(ctx.msg(`正在通过 Codex 中转生成图片（${model}）...`, `Generating image via Codex relay (${model})...`));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(input.timeout_ms || 240_000));
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      // keep the timer until the body is drained below
    }
    if (!res.ok) {
      clearTimeout(timer);
      const detail = await res.text().catch(() => "");
      throw new Error(`${ctx.msg("Codex 中转拒绝了请求", "Codex relay rejected the request")} (HTTP ${res.status}): ${detail.slice(0, 200)}`);
    }

    // Drain the whole stream into text, then extract images. Accumulate only the
    // assistant delta content so we regex the image markdown, not raw SSE framing.
    let content = "";
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        // process complete SSE lines; keep the trailing partial in `buffer`
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const d = line.slice(5).trim();
          if (!d || d === "[DONE]") continue;
          let ev;
          try { ev = JSON.parse(d); } catch { continue; }
          const piece = ev.choices?.[0]?.delta?.content;
          if (piece) content += piece;
          const errMsg = ev.error?.message;
          if (errMsg) throw new Error(errMsg);
        }
      }
    } finally {
      clearTimeout(timer);
    }

    const buffers = [];
    let m;
    while ((m = DATA_IMAGE_RE.exec(content)) !== null) {
      const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
      buffers.push({ data: Buffer.from(m[2], "base64"), ext });
    }
    if (!buffers.length) {
      const preview = content.replace(DATA_IMAGE_RE, "data:image/<...>").slice(0, 300);
      throw new Error(
        `${ctx.msg("中转没有返回图片。模型可能没有调用图片生成工具。", "The relay returned no image. The model may not have invoked the image tool.")}\n${preview}`,
      );
    }
    return { buffers };
  },
};
