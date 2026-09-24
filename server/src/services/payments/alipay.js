// Alipay open platform adapter (public-key mode, RSA2).
//
// Protocol only: sign requests, verify what Alipay sends back, normalize its
// answers into the shapes the payment service understands. No database, no
// order logic — the service decides what a result means for an order.
//
//   createCharge  page (PC website) / wap (mobile website) → a signed redirect
//                 URL; precreate → a QR code the buyer scans
//   verifyNotify  the asynchronous notification (form POST), signature-checked
//   query / close / refund / refundQuery / downloadBill
//
// Every Alipay RESPONSE is signature-checked too: a man in the middle must not
// be able to say "paid".

import crypto from "node:crypto";
import { centsToYuan, yuanToCents } from "./money.js";

const PROD_GATEWAY = "https://openapi.alipay.com/gateway.do";
const SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
const TIMEOUT_MS = 10_000;

/** Alipay's timestamp: Beijing time, "yyyy-MM-dd HH:mm:ss". */
export function beijingTime(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 19)}`;
}

/** "yyyy-MM-dd HH:mm:ss" in Beijing time → ISO string, or "" when absent/malformed. */
export function parseBeijingTime(text) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(String(text || "").trim());
  if (!m) return "";
  const ms = Date.parse(`${m[1]}T${m[2]}+08:00`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function derOrPem(text, kind) {
  const value = String(text || "").trim();
  if (!value) throw Object.assign(new Error(`ALIPAY_${kind}_KEY_MISSING`), { code: `ALIPAY_${kind}_KEY_MISSING` });
  if (value.includes("-----BEGIN")) {
    return kind === "PRIVATE" ? crypto.createPrivateKey(value) : crypto.createPublicKey(value);
  }
  // The Alipay key tool hands out bare base64. PKCS#8 / SPKI first, PKCS#1 second.
  const der = Buffer.from(value.replace(/\s+/g, ""), "base64");
  const attempts = kind === "PRIVATE" ? ["pkcs8", "pkcs1"] : ["spki", "pkcs1"];
  for (const type of attempts) {
    try {
      return kind === "PRIVATE"
        ? crypto.createPrivateKey({ key: der, format: "der", type })
        : crypto.createPublicKey({ key: der, format: "der", type });
    } catch { /* next encoding */ }
  }
  throw Object.assign(new Error(`ALIPAY_${kind}_KEY_INVALID`), { code: `ALIPAY_${kind}_KEY_INVALID` });
}

/** The string Alipay signs: sorted non-empty params, sign/sign_type excluded (for notify). */
export function signContent(params, { excludeSignType = false } = {}) {
  return Object.keys(params)
    .filter((k) => k !== "sign" && !(excludeSignType && k === "sign_type"))
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

export function rsa2Sign(content, privateKey) {
  return crypto.sign("RSA-SHA256", Buffer.from(content, "utf8"), derOrPem(privateKey, "PRIVATE")).toString("base64");
}

export function rsa2Verify(content, signature, publicKey) {
  try {
    return crypto.verify("RSA-SHA256", Buffer.from(content, "utf8"), derOrPem(publicKey, "PUBLIC"), Buffer.from(String(signature || ""), "base64"));
  } catch {
    return false;
  }
}

/**
 * The raw JSON text of `<method>_response` inside Alipay's response body — the
 * exact bytes Alipay signed (re-serialising parsed JSON would not match).
 */
export function extractSignedResponse(body, method) {
  const key = `"${method.replace(/\./g, "_")}_response"`;
  const errorKey = '"error_response"';
  let at = body.indexOf(key);
  let keyLength = key.length;
  if (at < 0) { at = body.indexOf(errorKey); keyLength = errorKey.length; }
  if (at < 0) return null;
  let i = body.indexOf("{", at + keyLength);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  let inString = false;
  for (; i < body.length; i += 1) {
    const c = body[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return body.slice(start, i + 1); }
  }
  return null;
}

const TRADE_STATUS = {
  WAIT_BUYER_PAY: "pending",
  TRADE_CLOSED: "closed",
  TRADE_SUCCESS: "succeeded",
  TRADE_FINISHED: "succeeded",
};

/** A provider result the service can act on. */
function tradeResult({ outTradeNo, tradeNo, tradeStatus, totalAmount, appId, sellerId, paidAt, raw }) {
  return {
    outTradeNo: String(outTradeNo || ""),
    providerTradeNo: String(tradeNo || ""),
    status: TRADE_STATUS[tradeStatus] || "unknown",
    providerStatus: String(tradeStatus || ""),
    amountCents: yuanToCents(totalAmount),
    currency: "CNY",
    appId: String(appId || ""),
    merchantId: String(sellerId || ""),
    // When the buyer paid, by Alipay's clock (the statement is cut by it).
    paidAt: parseBeijingTime(paidAt),
    raw,
  };
}

export function createAlipayGateway(config, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const gateway = config.gatewayUrl || (config.sandbox ? SANDBOX_GATEWAY : PROD_GATEWAY);

  function commonParams(method, bizContent, extra = {}) {
    return {
      app_id: config.appId,
      method,
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: beijingTime(now()),
      version: "1.0",
      biz_content: JSON.stringify(bizContent),
      ...extra,
    };
  }

  function signed(params) {
    return { ...params, sign: rsa2Sign(signContent(params), config.privateKey) };
  }

  /** Call an API method and return its verified `<method>_response` object. */
  async function call(method, bizContent, extra = {}) {
    const params = signed(commonParams(method, bizContent, extra));
    let text;
    try {
      const res = await fetchImpl(`${gateway}?charset=utf-8`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      return { ok: false, code: "ALIPAY_UNREACHABLE", detail: String(err?.message || err) };
    }
    const signedText = extractSignedResponse(text, method);
    let body = null;
    try { body = JSON.parse(text); } catch { return { ok: false, code: "ALIPAY_BAD_RESPONSE", detail: text.slice(0, 200) }; }
    const response = body[`${method.replace(/\./g, "_")}_response`] || body.error_response || {};
    // Success answers are always signed; an unsigned one is not trusted.
    if (body.sign) {
      if (!signedText || !rsa2Verify(signedText, body.sign, config.publicKey)) {
        return { ok: false, code: "ALIPAY_RESPONSE_SIGNATURE_INVALID" };
      }
    } else if (response.code === "10000") {
      return { ok: false, code: "ALIPAY_RESPONSE_UNSIGNED" };
    }
    if (response.code !== "10000") {
      return { ok: false, code: response.sub_code || response.code || "ALIPAY_ERROR", detail: response.sub_msg || response.msg || "", response };
    }
    return { ok: true, response };
  }

  return {
    provider: "alipay",

    /**
     * @param {object} p
     * @param {string} p.outTradeNo  our payment id
     * @param {number} p.amountCents
     * @param {string} p.subject
     * @param {"page"|"wap"|"precreate"} p.method
     * @param {Date}   p.expiresAt
     * @param {string} p.returnUrl  where the buyer's browser comes back (display only)
     */
    async createCharge({ outTradeNo, amountCents, subject, method, expiresAt, returnUrl }) {
      const biz = {
        out_trade_no: outTradeNo,
        total_amount: centsToYuan(amountCents),
        subject: String(subject || "").slice(0, 128),
        time_expire: beijingTime(expiresAt),
      };
      if (method === "precreate") {
        // The notification only comes if the precreate names where to send it.
        const result = await call("alipay.trade.precreate", biz, { notify_url: config.notifyUrl });
        if (!result.ok) return result;
        return { ok: true, checkout: { kind: "qrcode", code: result.response.qr_code } };
      }
      const apiMethod = method === "wap" ? "alipay.trade.wap.pay" : "alipay.trade.page.pay";
      const product = method === "wap" ? "QUICK_WAP_WAY" : "FAST_INSTANT_TRADE_PAY";
      const params = signed(commonParams(apiMethod, { ...biz, product_code: product, ...(method === "wap" ? { quit_url: returnUrl } : {}) }, {
        notify_url: config.notifyUrl,
        ...(returnUrl ? { return_url: returnUrl } : {}),
      }));
      return { ok: true, checkout: { kind: "redirect", url: `${gateway}?${new URLSearchParams(params).toString()}` } };
    },

    /** Verify Alipay's asynchronous notification (a form POST). */
    verifyNotify(form) {
      const params = Object.fromEntries(Object.entries(form || {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : String(v)]));
      const verified = rsa2Verify(signContent(params, { excludeSignType: true }), params.sign, config.publicKey);
      const raw = { ...params };
      delete raw.sign;
      return {
        verified,
        result: tradeResult({
          outTradeNo: params.out_trade_no,
          tradeNo: params.trade_no,
          tradeStatus: params.trade_status,
          totalAmount: params.total_amount,
          appId: params.app_id,
          sellerId: params.seller_id,
          paidAt: params.gmt_payment,
          raw,
        }),
        // Alipay stops retrying only on this exact body.
        ack: "success",
        nack: "failure",
      };
    },

    async query(outTradeNo) {
      const result = await call("alipay.trade.query", { out_trade_no: outTradeNo });
      if (!result.ok) {
        // The buyer has not opened the checkout yet: nothing exists at Alipay.
        if (result.code === "ACQ.TRADE_NOT_EXIST") return { ok: true, result: { outTradeNo, status: "not_found", raw: {} } };
        return result;
      }
      const r = result.response;
      return { ok: true, result: tradeResult({ outTradeNo: r.out_trade_no, tradeNo: r.trade_no, tradeStatus: r.trade_status, totalAmount: r.total_amount, appId: config.appId, sellerId: config.merchantId, paidAt: r.send_pay_date, raw: r }) };
    },

    async close(outTradeNo) {
      const result = await call("alipay.trade.close", { out_trade_no: outTradeNo });
      if (result.ok || result.code === "ACQ.TRADE_NOT_EXIST") return { ok: true };
      return result;
    },

    async refund({ outTradeNo, outRequestNo, amountCents, reason }) {
      const result = await call("alipay.trade.refund", {
        out_trade_no: outTradeNo,
        out_request_no: outRequestNo,
        refund_amount: centsToYuan(amountCents),
        refund_reason: String(reason || "").slice(0, 256),
      });
      if (!result.ok) return result;
      // A repeated out_request_no answers fund_change "N": already refunded — still success.
      return { ok: true, status: "succeeded", providerRefundNo: result.response.trade_no || "" };
    },

    async refundQuery({ outTradeNo, outRequestNo }) {
      const result = await call("alipay.trade.fastpay.refund.query", { out_trade_no: outTradeNo, out_request_no: outRequestNo });
      if (!result.ok) return result;
      const done = result.response.refund_status === "REFUND_SUCCESS" || Boolean(result.response.refund_amount);
      return { ok: true, status: done ? "succeeded" : "pending" };
    },

    /** The day's trade statement: [{ outTradeNo, providerTradeNo, kind, amountCents }]. */
    async downloadBill(billDate) {
      const result = await call("alipay.data.dataservice.bill.downloadurl.query", { bill_type: "trade", bill_date: billDate });
      // No statement for the day: either no trades, or not generated yet —
      // the caller tells the two apart by whether it expected any.
      if (!result.ok) return result.code === "isp.bill_not_exist" ? { ok: true, rows: [], noStatement: true } : result;
      let zip;
      try {
        const res = await fetchImpl(result.response.bill_download_url, { signal: AbortSignal.timeout(30_000) });
        zip = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        return { ok: false, code: "ALIPAY_BILL_DOWNLOAD_FAILED", detail: String(err?.message || err) };
      }
      const { readZipEntries } = await import("./zip.js");
      const rows = [];
      for (const entry of readZipEntries(zip)) {
        if (!/明细|detail/i.test(entry.name) || /汇总|summary/i.test(entry.name)) continue;
        rows.push(...parseAlipayBillCsv(decodeStatement(entry.data)));
      }
      return { ok: true, rows };
    },
  };
}

/** Alipay statements are GBK; take UTF-8 when the bytes are valid UTF-8, GBK otherwise. */
export function decodeStatement(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gbk").decode(bytes);
  }
}

/** Rows of Alipay's trade-detail CSV (decoded text). */
export function parseAlipayBillCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const headerIndex = lines.findIndex((l) => l.includes("商户订单号"));
  if (headerIndex < 0) return [];
  const header = lines[headerIndex].split(",").map((h) => h.trim());
  const col = (name) => header.findIndex((h) => h.startsWith(name));
  const idx = { tradeNo: col("支付宝交易号"), outTradeNo: col("商户订单号"), kind: col("业务类型"), amount: col("订单金额") };
  const rows = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.split(",").map((c) => c.trim().replace(/^\t/, ""));
    if (cells.length < header.length / 2 || !cells[idx.outTradeNo]) continue;
    const amountCents = yuanToCents(cells[idx.amount]);
    if (amountCents === null) continue;
    rows.push({
      outTradeNo: cells[idx.outTradeNo],
      providerTradeNo: cells[idx.tradeNo] || "",
      kind: /退款/.test(cells[idx.kind] || "") ? "refund" : "payment",
      amountCents: Math.abs(amountCents),
    });
  }
  return rows;
}
