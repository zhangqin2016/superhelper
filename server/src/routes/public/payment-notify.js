import { paymentService } from "../../services/payments/service.js";
import { NOTIFY_PATHS } from "../../services/payments/providers.js";

// Where Alipay and WeChat tell us a payment happened. No session: trust comes
// from the provider's signature alone, verified by the adapter. Registered as
// an encapsulated plugin so its body parsers (Alipay's form, WeChat's RAW JSON —
// its signature covers the exact bytes) do not change parsing anywhere else.

export async function paymentNotifyRoutes(app) {
  const payments = paymentService();

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 64 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 64 * 1024 }, (_req, body, done) => {
    done(null, body);
  });

  app.post(NOTIFY_PATHS.alipay, {
    schema: { tags: ["public:payments"], summary: "Alipay asynchronous payment notification (signature-verified)" },
  }, async (request, reply) => {
    const { reply: body } = await payments.handleNotify("alipay", request.body || {});
    // Alipay retries until it reads exactly "success".
    return reply.type("text/plain").send(body);
  });

  app.post(NOTIFY_PATHS.wechat, {
    schema: { tags: ["public:payments"], summary: "WeChat Pay payment notification (signature-verified, decrypted)" },
  }, async (request, reply) => {
    const { reply: answer } = await payments.handleNotify("wechat", {
      headers: request.headers,
      body: typeof request.body === "string" ? request.body : "",
    });
    return reply.code(answer.status).send(answer.body);
  });
}
