// WeChat Pay API v3 adapter (Native = QR code), with the WeChat Pay public
// key ("微信支付公钥") for verifying what WeChat sends.
//
// Protocol only, like alipay.js: sign requests (WECHATPAY2-SHA256-RSA2048),
// verify responses and notifications, decrypt notification resources
// (AEAD_AES_256_GCM with the API v3 key), normalize results.

import crypto from "node:crypto";
import { yuanToCents } from "./money.js";

const BASE_URL = "https://api.mch.weixin.qq.com";
const TIMEOUT_MS = 10_000;

function privateKeyOf(text) {
  const value = String(text || "").trim();
  if (!value) throw Object.assign(new Error("WECHAT_PRIVATE_KEY_MISSING"), { code: "WECHAT_PRIVATE_KEY_MISSING" });
  return crypto.createPrivateKey(value.includes("-----BEGIN") ? value : { key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" });
}

function publicKeyOf(text) {
  const value = String(text || "").trim();
  if (!value) throw Object.assign(new Error("WECHAT_PLATFORM_KEY_MISSING"), { code: "WECHAT_PLATFORM_KEY_MISSING" });
  return crypto.createPublicKey(value.includes("-----BEGIN") ? value : { key: Buffer.from(value, "base64"), format: "der", type: "spki" });
}

/** RFC 3339 in Beijing time, as WeChat expects for time_expire. */
export function rfc3339Beijing(date) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000).toISOString();
  return `${t.slice(0, 19)}+08:00`;
}

/** Verify a WeChat signature over `${timestamp}\n${nonce}\n${body}\n`. */
export function verifyWechatSignature({ timestamp, nonce, body, signature, serial }, config, { now = () => Date.now() } = {}) {
  if (config.platformPublicKeyId && serial && serial !== config.platformPublicKeyId) return false;
  // Replays of old notifications are refused (5-minute window, as WeChat advises).
  if (!timestamp || Math.abs(now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    return crypto.verify("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${body}\n`, "utf8"), publicKeyOf(config.platformPublicKey), Buffer.from(String(signature || ""), "base64"));
  } catch {
    return false;
  }
}

/** Decrypt a notification `resource` with the API v3 key. */
export function decryptResource(resource, apiV3Key) {
  const data = Buffer.from(String(resource?.ciphertext || ""), "base64");
  const tag = data.subarray(data.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key, "utf8"), Buffer.from(String(resource?.nonce || ""), "utf8"));
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from(String(resource?.associated_data || ""), "utf8"));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8"));
}

const TRADE_STATE = {
  NOTPAY: "pending",
  USERPAYING: "pending",
  SUCCESS: "succeeded",
  CLOSED: "closed",
  REVOKED: "closed",
  PAYERROR: "closed",
  REFUND: "succeeded", // paid, then (partly) refunded — it WAS paid
};

function tradeResult(t, raw = t) {
  return {
    outTradeNo: String(t.out_trade_no || ""),
    providerTradeNo: String(t.transaction_id || ""),
    status: TRADE_STATE[t.trade_state] || "unknown",
    providerStatus: String(t.trade_state || ""),
    amountCents: Number.isFinite(Number(t.amount?.total)) ? Number(t.amount.total) : null,
    currency: String(t.amount?.currency || "CNY"),
    appId: String(t.appid || ""),
    merchantId: String(t.mchid || ""),
    // When the buyer paid, by WeChat's clock (the statement is cut by it).
    paidAt: Number.isFinite(Date.parse(t.success_time || "")) ? new Date(t.success_time).toISOString() : "",
    raw,
  };
}

export function createWechatGateway(config, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const base = String(config.baseUrl || BASE_URL).replace(/\/+$/, "");

  function authorization(method, pathWithQuery, body) {
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = crypto.randomBytes(16).toString("hex");
    const message = `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(message, "utf8"), privateKeyOf(config.privateKey)).toString("base64");
    return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.certSerialNo}"`;
  }

  async function call(method, pathWithQuery, payload, { verifyResponse = true } = {}) {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    let res;
    let text;
    try {
      res = await fetchImpl(`${base}${pathWithQuery}`, {
        method,
        headers: {
          Authorization: authorization(method, pathWithQuery, body),
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      return { ok: false, code: "WECHAT_UNREACHABLE", detail: String(err?.message || err) };
    }
    if (verifyResponse && res.ok) {
      const header = (name) => res.headers.get(name) || "";
      const verified = verifyWechatSignature({
        timestamp: header("Wechatpay-Timestamp"),
        nonce: header("Wechatpay-Nonce"),
        body: text,
        signature: header("Wechatpay-Signature"),
        serial: header("Wechatpay-Serial"),
      }, config, { now });
      if (!verified) return { ok: false, code: "WECHAT_RESPONSE_SIGNATURE_INVALID" };
    }
    let json = {};
    if (text) { try { json = JSON.parse(text); } catch { json = {}; } }
    if (!res.ok) return { ok: false, status: res.status, code: json.code || `WECHAT_HTTP_${res.status}`, detail: json.message || "", response: json };
    return { ok: true, status: res.status, response: json, text };
  }

  return {
    provider: "wechat",

    async createCharge({ outTradeNo, amountCents, subject, expiresAt }) {
      const result = await call("POST", "/v3/pay/transactions/native", {
        appid: config.appId,
        mchid: config.mchId,
        description: String(subject || "").slice(0, 127),
        out_trade_no: outTradeNo,
        time_expire: rfc3339Beijing(expiresAt),
        notify_url: config.notifyUrl,
        amount: { total: amountCents, currency: "CNY" },
      });
      if (!result.ok) return result;
      return { ok: true, checkout: { kind: "qrcode", code: result.response.code_url } };
    },

    /** Verify + decrypt a notification. `headers` lower-cased, `body` the raw text. */
    verifyNotify({ headers = {}, body = "" }) {
      const verified = verifyWechatSignature({
        timestamp: headers["wechatpay-timestamp"],
        nonce: headers["wechatpay-nonce"],
        body,
        signature: headers["wechatpay-signature"],
        serial: headers["wechatpay-serial"],
      }, config, { now });
      const replies = {
        ack: { status: 200, body: { code: "SUCCESS", message: "成功" } },
        nack: { status: 500, body: { code: "FAIL", message: "处理失败" } },
      };
      let result = { outTradeNo: "", status: "unknown", raw: {} };
      if (!verified) return { verified: false, result, ...replies };
      try {
        const envelope = JSON.parse(body);
        const transaction = decryptResource(envelope.resource, config.apiV3Key);
        result = tradeResult(transaction, { event_type: envelope.event_type, ...transaction });
      } catch {
        // Signed by WeChat but not decryptable with our key: a key mismatch, not a payment.
        return { verified: false, result, ...replies };
      }
      return { verified: true, result, ...replies };
    },

    async query(outTradeNo) {
      const result = await call("GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchId)}`);
      if (!result.ok) {
        if (result.code === "ORDER_NOT_EXIST" || result.status === 404) return { ok: true, result: { outTradeNo, status: "not_found", raw: {} } };
        return result;
      }
      return { ok: true, result: tradeResult(result.response) };
    },

    async close(outTradeNo) {
      const result = await call("POST", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`, { mchid: config.mchId }, { verifyResponse: false });
      if (result.ok || result.code === "ORDER_CLOSED" || result.code === "ORDER_NOT_EXIST") return { ok: true };
      return result;
    },

    async refund({ outTradeNo, outRequestNo, amountCents, totalCents, reason }) {
      const result = await call("POST", "/v3/refund/domestic/refunds", {
        out_trade_no: outTradeNo,
        out_refund_no: outRequestNo,
        reason: String(reason || "").slice(0, 80) || undefined,
        amount: { refund: amountCents, total: totalCents, currency: "CNY" },
      });
      if (!result.ok) return result;
      const status = result.response.status === "SUCCESS" ? "succeeded" : result.response.status === "PROCESSING" ? "pending" : "failed";
      return { ok: status !== "failed", status, providerRefundNo: result.response.refund_id || "", code: status === "failed" ? `WECHAT_REFUND_${result.response.status}` : undefined };
    },

    async refundQuery({ outRequestNo }) {
      const result = await call("GET", `/v3/refund/domestic/refunds/${encodeURIComponent(outRequestNo)}`);
      if (!result.ok) return result;
      const s = result.response.status;
      return { ok: true, status: s === "SUCCESS" ? "succeeded" : s === "PROCESSING" ? "pending" : "failed" };
    },

    /** The day's trade statement: [{ outTradeNo, providerTradeNo, kind, amountCents }]. */
    async downloadBill(billDate) {
      const meta = await call("GET", `/v3/bill/tradebill?bill_date=${encodeURIComponent(billDate)}&bill_type=ALL`);
      if (!meta.ok) {
        if (meta.code === "NO_STATEMENT_EXIST") return { ok: true, rows: [], noStatement: true };
        if (meta.code === "STATEMENT_CREATING") return { ok: false, code: "BILL_NOT_READY" };
        return meta;
      }
      const url = new URL(meta.response.download_url);
      const file = await call("GET", `${url.pathname}${url.search}`, undefined, { verifyResponse: false });
      if (!file.ok) return { ok: false, code: "WECHAT_BILL_DOWNLOAD_FAILED", detail: file.detail };
      return { ok: true, rows: parseWechatBillCsv(file.text) };
    },
  };
}

/** Rows of WeChat's trade bill (UTF-8 text, cells prefixed with a backtick). */
export function parseWechatBillCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const col = (name) => header.findIndex((h) => h === name);
  const idx = { tradeNo: col("微信订单号"), outTradeNo: col("商户订单号"), state: col("交易状态"), amount: col("应结订单金额"), refund: col("退款金额") };
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.startsWith("`")) break; // the summary block follows the detail rows
    const cells = line.split(",").map((c) => c.trim().replace(/^`/, ""));
    const state = cells[idx.state] || "";
    const yuan = state === "REFUND" ? cells[idx.refund] : cells[idx.amount];
    const cents = yuanToCents(yuan);
    if (!cells[idx.outTradeNo] || cents === null) continue;
    rows.push({ outTradeNo: cells[idx.outTradeNo], providerTradeNo: cells[idx.tradeNo] || "", kind: state === "REFUND" ? "refund" : "payment", amountCents: Math.abs(cents) });
  }
  return rows;
}
