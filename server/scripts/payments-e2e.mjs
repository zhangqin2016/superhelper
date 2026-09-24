// Payments, end to end on a real database with in-process fake Alipay and
// WeChat Pay gateways that behave like the real ones: they verify OUR request
// signatures, sign every response with THEIR key, send signed (Alipay) /
// encrypted+signed (WeChat) notifications, and serve statements.
//
//   DATABASE_URL=postgres://… node scripts/payments-e2e.mjs
//
// Covers: readiness gating, server-side price, checkout (redirect / QR),
// verified notification → paid + credit, duplicate / tampered / wrong-app /
// wrong-amount notifications, lost notification healed by the order page and
// by the sweeper, expiry + close, late payment honoured, double payment
// auto-refunded, partial + full refund reversing credit, reconciliation
// (heals a missed payment, reports a missing one, "not ready" is not "empty",
// a trade paid before midnight reconciles on the provider's day), the user
// statement (cursor paging skips nothing), and fake payments refused in
// production.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import zlib from "node:zlib";
import pg from "pg";

process.env.DATABASE_URL ||= "postgres://integration:integration@localhost:5432/integration";
process.env.ADMIN_TOKEN ||= "payments-e2e-admin";
process.env.SESSION_SECRET ||= "payments-e2e-session-secret-0123456789";
process.env.ALLOW_UNSIGNED_LICENSES ||= "true";
process.env.PUBLIC_BASE_URL = "https://api.payments-e2e.test";
process.env.WEB_BASE_URL = "https://www.payments-e2e.test";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try { await pool.query("select 1"); } catch {
  console.log("payments-e2e: skipped (DATABASE_URL unavailable)");
  await pool.end();
  process.exit(0);
}

const pem = (key, type) => key.export({ type, format: "pem" });
const pair = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const appKeys = pair(); // our Alipay application key
const aliKeys = pair(); // Alipay's key
const merchantKeys = pair(); // our WeChat merchant key
const platformKeys = pair(); // WeChat Pay's key
const API_V3 = "0123456789abcdef0123456789abcdef";

// --- fake Alipay ----------------------------------------------------------------------
const alipay = { ...(await import("../src/services/payments/alipay.js")), centsToYuanForTest: (await import("../src/services/payments/money.js")).centsToYuan };
const aliTrades = new Map(); // out_trade_no -> { amount, status, tradeNo, refunds: Map }
const aliCalls = [];
function aliSigned(method, inner) {
  const json = JSON.stringify(inner);
  return `{"${method.replace(/\./g, "_")}_response":${json},"sign":"${alipay.rsa2Sign(json, pem(aliKeys.privateKey, "pkcs8"))}"}`;
}
function aliVerifyRequest(params) {
  return alipay.rsa2Verify(alipay.signContent(params), params.sign, pem(appKeys.publicKey, "spki"));
}
let aliBillRows = [];
let aliBillMissing = false;
const aliServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/bill.zip") {
    const csv = ["支付宝交易号,商户订单号,业务类型,商品名称,创建时间,完成时间,门店编号,门店名称,操作员,终端号,对方账户,订单金额（元）,商家实收（元）",
      ...aliBillRows.map((r) => `${r.tradeNo}\t,${r.outTradeNo}\t,${r.kind === "refund" ? "退款" : "交易"},Lily,,,,,,,x,${r.kind === "refund" ? "-" : ""}${alipay.centsToYuanForTest(r.amount)},0`)].join("\r\n");
    const data = Buffer.from(csv, "utf8");
    const name = Buffer.from("2088_20260924_业务明细.csv", "utf8");
    const body = zlib.deflateRawSync(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + body.length, 16);
    res.end(Buffer.concat([local, name, body, central, name, end]));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const params = Object.fromEntries(req.method === "GET" ? url.searchParams : new URLSearchParams(raw));
  aliCalls.push(params.method);
  if (!aliVerifyRequest(params)) { res.end(`{"error_response":{"code":"40002","sub_code":"isv.invalid-signature"}}`); return; }
  const biz = JSON.parse(params.biz_content || "{}");
  const method = params.method;
  const trade = aliTrades.get(biz.out_trade_no);
  const reply = (inner) => res.end(aliSigned(method, { code: "10000", msg: "Success", ...inner }));
  const fail = (sub) => res.end(aliSigned(method, { code: "40004", msg: "Business Failed", sub_code: sub }));
  switch (method) {
    case "alipay.trade.page.pay":
    case "alipay.trade.wap.pay":
      // The buyer's browser lands here: the trade now exists, awaiting payment.
      if (!aliTrades.has(biz.out_trade_no)) aliTrades.set(biz.out_trade_no, { amount: biz.total_amount, status: "WAIT_BUYER_PAY", refunds: new Map(), notifyUrl: params.notify_url });
      res.end("<html>alipay checkout</html>");
      return;
    case "alipay.trade.precreate":
      aliTrades.set(biz.out_trade_no, { amount: biz.total_amount, status: "WAIT_BUYER_PAY", refunds: new Map(), notifyUrl: params.notify_url });
      return reply({ out_trade_no: biz.out_trade_no, qr_code: `https://qr.alipay.com/${biz.out_trade_no}` });
    case "alipay.trade.query":
      if (!trade) return fail("ACQ.TRADE_NOT_EXIST");
      return reply({ out_trade_no: biz.out_trade_no, trade_no: trade.tradeNo || "", trade_status: trade.status, total_amount: trade.amount, ...(trade.paidAt ? { send_pay_date: trade.paidAt } : {}) });
    case "alipay.trade.close":
      if (!trade) return fail("ACQ.TRADE_NOT_EXIST");
      if (trade.status === "TRADE_SUCCESS") return fail("ACQ.TRADE_STATUS_ERROR");
      trade.status = "TRADE_CLOSED";
      return reply({ out_trade_no: biz.out_trade_no });
    case "alipay.trade.refund":
      if (!trade || trade.status !== "TRADE_SUCCESS") return fail("ACQ.TRADE_STATUS_ERROR");
      trade.refunds.set(biz.out_request_no, biz.refund_amount);
      return reply({ out_trade_no: biz.out_trade_no, trade_no: trade.tradeNo, refund_fee: biz.refund_amount, fund_change: "Y" });
    case "alipay.trade.fastpay.refund.query":
      return reply({ refund_status: trade?.refunds.has(biz.out_request_no) ? "REFUND_SUCCESS" : "" });
    case "alipay.data.dataservice.bill.downloadurl.query":
      if (aliBillMissing) return fail("isp.bill_not_exist");
      return reply({ bill_download_url: `http://127.0.0.1:${aliServer.address().port}/bill.zip` });
    default:
      return fail("isv.method-not-supported");
  }
});
await new Promise((r) => aliServer.listen(0, "127.0.0.1", r));
process.env.ALIPAY_GATEWAY_URL = `http://127.0.0.1:${aliServer.address().port}/gateway.do`;

// --- fake WeChat Pay -------------------------------------------------------------------
const wxTrades = new Map();
function wxHeaders(body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(8).toString("hex");
  return { "Wechatpay-Timestamp": ts, "Wechatpay-Nonce": nonce, "Wechatpay-Serial": "PUB_KEY_ID_E2E", "Wechatpay-Signature": crypto.sign("RSA-SHA256", Buffer.from(`${ts}\n${nonce}\n${body}\n`), platformKeys.privateKey).toString("base64"), "Content-Type": "application/json" };
}
const wxServer = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  // Verify the merchant's v3 signature, as WeChat does.
  const auth = String(req.headers.authorization || "");
  const f = (k) => new RegExp(`${k}="([^"]*)"`).exec(auth)?.[1] || "";
  const message = `${req.method}\n${req.url}\n${f("timestamp")}\n${f("nonce_str")}\n${body}\n`;
  if (!crypto.verify("RSA-SHA256", Buffer.from(message), merchantKeys.publicKey, Buffer.from(f("signature"), "base64"))) {
    res.writeHead(401); res.end(JSON.stringify({ code: "SIGN_ERROR" })); return;
  }
  const send = (status, obj) => { const text = obj === null ? "" : JSON.stringify(obj); res.writeHead(status, wxHeaders(text)); res.end(text); };
  const payload = body ? JSON.parse(body) : {};
  let m;
  if (req.method === "POST" && req.url === "/v3/pay/transactions/native") {
    wxTrades.set(payload.out_trade_no, { total: payload.amount.total, state: "NOTPAY", refunds: new Map() });
    return send(200, { code_url: `weixin://wxpay/bizpayurl?pr=${payload.out_trade_no}` });
  }
  if ((m = /^\/v3\/pay\/transactions\/out-trade-no\/([^/?]+)\?mchid=/.exec(req.url)) && req.method === "GET") {
    const t = wxTrades.get(decodeURIComponent(m[1]));
    if (!t) return send(404, { code: "ORDER_NOT_EXIST", message: "not exist" });
    return send(200, { out_trade_no: decodeURIComponent(m[1]), transaction_id: t.transactionId || "", trade_state: t.state, appid: "wx_e2e", mchid: "1900000001", amount: { total: t.total, currency: "CNY" } });
  }
  if ((m = /^\/v3\/pay\/transactions\/out-trade-no\/([^/]+)\/close$/.exec(req.url))) {
    const t = wxTrades.get(decodeURIComponent(m[1]));
    if (t && t.state === "NOTPAY") t.state = "CLOSED";
    res.writeHead(204); res.end(); return;
  }
  if (req.url === "/v3/refund/domestic/refunds" && req.method === "POST") {
    const t = wxTrades.get(payload.out_trade_no);
    t.refunds.set(payload.out_refund_no, "PROCESSING"); // WeChat refunds are asynchronous
    return send(200, { refund_id: `5000${Date.now()}`, out_refund_no: payload.out_refund_no, status: "PROCESSING" });
  }
  if ((m = /^\/v3\/refund\/domestic\/refunds\/([^/?]+)$/.exec(req.url))) {
    for (const t of wxTrades.values()) if (t.refunds.has(decodeURIComponent(m[1]))) { t.refunds.set(decodeURIComponent(m[1]), "SUCCESS"); return send(200, { status: "SUCCESS" }); }
    return send(404, { code: "RESOURCE_NOT_EXISTS" });
  }
  send(404, { code: "NOT_FOUND" });
});
await new Promise((r) => wxServer.listen(0, "127.0.0.1", r));
process.env.WECHAT_PAY_BASE_URL = `http://127.0.0.1:${wxServer.address().port}`;

// --- the app ---------------------------------------------------------------------------
const fs = await import("node:fs");
for (const file of fs.readdirSync(new URL("../migrations", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) {
  await pool.query(fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
}
const { buildApp } = await import("../src/app.js");
const { createWebSessionToken } = await import("../src/services/account-auth.js");
const { paymentService } = await import("../src/services/payments/service.js");
const app = await buildApp();
const admin = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const run = Date.now().toString(36);

// A signed-in web user.
const userId = `usr_pay_${run}`;
const deviceId = `dev_pay_${run}`;
const sessionId = `ses_pay_${run}`;
await pool.query("insert into devices (id, platform, arch) values ($1, 'web', 'web') on conflict do nothing", [deviceId]).catch(async () => {
  await pool.query("insert into devices (id) values ($1) on conflict do nothing", [deviceId]);
});
await pool.query("insert into users (id, phone_e164, status) values ($1, $2, 'active')", [userId, `+86139${run.slice(-8).padStart(8, "0").replace(/\D/g, "1")}`]);
await pool.query("insert into user_sessions (id, user_id, device_id, refresh_token_hash, expires_at) values ($1, $2, $3, $4, now() + interval '1 day')", [sessionId, userId, deviceId, `h_${run}`]);
const cookie = { cookie: `lily_user_session=${createWebSessionToken({ userId, sessionId })}` };
const productId = `tok_${run}`;
await pool.query("insert into products (id, kind, name, price_cents, currency, resource_type, unit_amount, grant_expires_days, status) values ($1, 'token_pack', 'Token 包', 990, 'CNY', 'token', 100000, 365, 'active')", [productId]);

const api = async (method, url, { payload, headers = {} } = {}) => {
  const res = await app.inject({ method, url, payload, headers: { ...cookie, ...headers } });
  let json = {};
  try { json = res.json(); } catch { json = {}; }
  return { status: res.statusCode, json, body: res.body };
};
const tokenBalance = async () => (await pool.query("select coalesce(sum(unit_remaining),0)::int as n from wallet_grants where user_id = $1 and resource_type = 'token' and status = 'active'", [userId])).rows[0].n;
const orderRow = async (id) => (await pool.query("select * from orders where id = $1", [id])).rows[0];

try {
  // --- 1. Enabled but incomplete is NOT offered -------------------------------------
  let r = await api("PATCH", "/api/admin/settings", { headers: admin, payload: { licenseTrialDays: 3, payment: { fakePaymentsEnabled: false, alipay: { enabled: true, appId: "2021000000000001" }, wechat: { enabled: false } } } });
  assert.equal(r.status, 200, r.body);
  r = await api("GET", "/api/billing/products");
  assert.deepEqual(r.json.paymentProviders, [], "a toggle without keys offers no button that cannot complete");
  const health = await api("GET", "/api/admin/health", { headers: admin });
  const paymentCheck = (health.json.checks || []).find((c) => c.name === "payment");
  assert.ok(paymentCheck, "the console health has a payment check");
  assert.match(paymentCheck.detail, /incomplete: alipay missing/, "the console says exactly what is missing");

  // --- 2. Configure both providers fully -----------------------------------------------
  r = await api("PATCH", "/api/admin/settings", { headers: admin, payload: { licenseTrialDays: 3, payment: {
    fakePaymentsEnabled: false,
    alipay: { enabled: true, appId: "2021000000000001", merchantId: "2088000000000001", publicKey: pem(aliKeys.publicKey, "spki"), privateKey: pem(appKeys.privateKey, "pkcs8"), checkoutMode: "redirect" },
    wechat: { enabled: true, appId: "wx_e2e", mchId: "1900000001", certSerialNo: "MCH_SERIAL", apiV3Key: API_V3, privateKey: pem(merchantKeys.privateKey, "pkcs8"), platformPublicKey: pem(platformKeys.publicKey, "spki"), platformPublicKeyId: "PUB_KEY_ID_E2E" },
  } } });
  assert.equal(r.status, 200, r.body);
  r = await api("GET", "/api/billing/products");
  assert.deepEqual(r.json.paymentProviders.map((p) => p.id).sort(), ["alipay", "wechat"]);

  // --- 3. Alipay redirect: order → checkout → buyer pays → signed notification ---------
  const newOrder = async (provider = "alipay") => (await api("POST", "/api/billing/orders", { payload: { productId, payProvider: provider } })).json.order;
  const order1 = await newOrder();
  assert.equal(order1.amountCents, 990, "the price is the product's, never the client's");
  assert.equal(order1.status, "pending");
  assert.ok(order1.expiresAt, "an order has a lifetime");
  r = await api("POST", `/api/billing/orders/${order1.id}/checkout`, { payload: { client: "desktop" } });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.checkout.kind, "redirect");
  const checkoutUrl = new URL(r.json.checkout.url);
  assert.equal(checkoutUrl.searchParams.get("method"), "alipay.trade.page.pay");
  assert.equal(checkoutUrl.searchParams.get("notify_url"), "https://api.payments-e2e.test/api/payments/alipay/notify", "notify URL defaults to our own API");
  assert.equal(checkoutUrl.searchParams.get("return_url"), `https://www.payments-e2e.test/account/orders/${order1.id}`, "the buyer comes back to THIS order's page");
  await fetch(checkoutUrl); // the buyer's browser opens Alipay (the fake verifies our signature)
  const pay1 = r.json.paymentId;
  assert.ok(aliTrades.has(pay1), "Alipay accepted our signed request");
  const before = await tokenBalance();

  const notify = (fields, key = aliKeys.privateKey) => {
    const params = { notify_id: crypto.randomUUID(), notify_type: "trade_status_sync", sign_type: "RSA2", charset: "utf-8", app_id: "2021000000000001", seller_id: "2088000000000001", ...fields };
    params.sign = alipay.rsa2Sign(alipay.signContent(params, { excludeSignType: true }), pem(key, "pkcs8"));
    return app.inject({ method: "POST", url: "/api/payments/alipay/notify", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(params).toString() });
  };
  const aliPaid = (outTradeNo, paidAt = "") => { const t = aliTrades.get(outTradeNo); t.status = "TRADE_SUCCESS"; t.tradeNo = `2026${outTradeNo.slice(-10)}`; if (paidAt) t.paidAt = paidAt; return t; };

  aliPaid(pay1);
  let n = await notify({ out_trade_no: pay1, trade_no: aliTrades.get(pay1).tradeNo, trade_status: "TRADE_SUCCESS", total_amount: "9.90" });
  assert.equal(n.body, "success", "Alipay is acknowledged with exactly 'success'");
  assert.equal((await orderRow(order1.id)).status, "paid");
  assert.equal(await tokenBalance(), before + 100000, "credit arrives with the payment");
  n = await notify({ out_trade_no: pay1, trade_no: aliTrades.get(pay1).tradeNo, trade_status: "TRADE_SUCCESS", total_amount: "9.90" });
  assert.equal(n.body, "success", "a repeated notification is acknowledged…");
  assert.equal(await tokenBalance(), before + 100000, "…and never credits twice");
  r = await api("GET", `/api/billing/orders/${order1.id}`);
  assert.equal(r.json.order.status, "paid");

  // --- 4. Forged / tampered / wrong-app / wrong-amount notifications ------------------------
  const order2 = await newOrder();
  const pay2 = (await api("POST", `/api/billing/orders/${order2.id}/checkout`, { payload: {} })).json.paymentId;
  n = await notify({ out_trade_no: pay2, trade_no: "T_FORGED", trade_status: "TRADE_SUCCESS", total_amount: "9.90" }, appKeys.privateKey);
  assert.equal(n.body, "failure", "a signature that is not Alipay's is refused");
  n = await notify({ out_trade_no: pay2, trade_no: "T_CHEAP", trade_status: "TRADE_SUCCESS", total_amount: "0.01" });
  assert.equal(n.body, "success", "a genuine but wrong-amount notice is acknowledged (retrying cannot fix it)…");
  n = await notify({ out_trade_no: pay2, trade_no: "T_OTHERAPP", trade_status: "TRADE_SUCCESS", total_amount: "9.90", app_id: "2021999999999999" });
  assert.equal((await orderRow(order2.id)).status, "pending", "…and neither pays the order, nor does another app's notice");
  const rejected = (await pool.query("select outcome, detail, verified from payment_events where payment_id = $1 order by created_at", [pay2])).rows;
  assert.deepEqual(rejected.map((e) => e.outcome), ["rejected", "rejected", "rejected"], "each is on record");
  assert.match(rejected[1].detail, /amount 1 != 990/);
  assert.match(rejected[2].detail, /app id mismatch/);

  // --- 5. Lost notification: the order page asks Alipay itself -------------------------------
  await fetch((await api("POST", `/api/billing/orders/${order2.id}/checkout`, { payload: {} })).json.checkout.url);
  aliPaid(pay2);
  r = await api("GET", `/api/billing/orders/${order2.id}`);
  assert.equal(r.json.order.status, "paid", "no notification arrived, but the buyer's page settles it by query");
  assert.equal(await tokenBalance(), before + 200000);

  // --- 6. Lost notification, nobody watching: the sweeper finds it ---------------------------
  const order3 = await newOrder();
  const pay3 = (await api("POST", `/api/billing/orders/${order3.id}/checkout`, { payload: {} })).json.paymentId;
  await fetch(new URL(process.env.ALIPAY_GATEWAY_URL).origin); // noop
  aliTrades.set(pay3, { amount: "9.90", status: "TRADE_SUCCESS", tradeNo: `2026${pay3.slice(-10)}`, refunds: new Map() });
  await pool.query("update payments set created_at = now() - interval '5 minutes', last_synced_at = null where id = $1", [pay3]);
  let sweep = await paymentService().sweep();
  assert.ok(sweep.synced >= 1);
  assert.equal((await orderRow(order3.id)).status, "paid", "the sweeper settles what no notification told us");

  // --- 7. Expiry: an unpaid order is closed, at Alipay too ----------------------------------
  const order4 = await newOrder();
  const pay4 = (await api("POST", `/api/billing/orders/${order4.id}/checkout`, { payload: {} })).json.paymentId;
  aliTrades.set(pay4, { amount: "9.90", status: "WAIT_BUYER_PAY", refunds: new Map() });
  await pool.query("update orders set expires_at = now() - interval '1 minute' where id = $1", [order4.id]);
  sweep = await paymentService().sweep();
  assert.equal((await orderRow(order4.id)).status, "closed");
  assert.equal(aliTrades.get(pay4).status, "TRADE_CLOSED", "closed at the provider, so it cannot be paid afterwards by accident");
  r = await api("POST", `/api/billing/orders/${order4.id}/checkout`, { payload: {} });
  assert.equal(r.json.code, "ORDER_NOT_PAYABLE");

  // --- 8. Late payment (paid while we were closing): honoured -------------------------------
  const order5 = await newOrder();
  const pay5 = (await api("POST", `/api/billing/orders/${order5.id}/checkout`, { payload: {} })).json.paymentId;
  await pool.query("update orders set status = 'closed', closed_at = now() where id = $1", [order5.id]);
  aliTrades.set(pay5, { amount: "9.90", status: "TRADE_SUCCESS", tradeNo: `2026${pay5.slice(-10)}`, refunds: new Map() });
  const balance5 = await tokenBalance();
  n = await notify({ out_trade_no: pay5, trade_no: aliTrades.get(pay5).tradeNo, trade_status: "TRADE_SUCCESS", total_amount: "9.90" });
  assert.equal((await orderRow(order5.id)).status, "paid", "the buyer paid: the goods are delivered even after expiry");
  assert.equal(await tokenBalance(), balance5 + 100000);

  // --- 9. Paid twice (two attempts): the second is refunded automatically -------------------
  await api("PATCH", "/api/admin/settings", { headers: admin, payload: { licenseTrialDays: 3, payment: {
    fakePaymentsEnabled: false,
    alipay: { enabled: true, appId: "2021000000000001", merchantId: "2088000000000001", publicKey: pem(aliKeys.publicKey, "spki"), checkoutMode: "qrcode" },
    wechat: { enabled: true, appId: "wx_e2e", mchId: "1900000001", certSerialNo: "MCH_SERIAL", platformPublicKey: pem(platformKeys.publicKey, "spki"), platformPublicKeyId: "PUB_KEY_ID_E2E" },
  } } });
  const order6 = await newOrder();
  const qr = (await api("POST", `/api/billing/orders/${order6.id}/checkout`, { payload: {} })).json;
  assert.equal(qr.checkout.kind, "qrcode");
  assert.match(qr.checkout.code, /^https:\/\/qr\.alipay\.com\//);
  assert.match(qr.checkout.image, /^data:image\/png;base64,/, "the QR is rendered server-side");
  const again = (await api("POST", `/api/billing/orders/${order6.id}/checkout`, { payload: {} })).json;
  assert.equal(again.paymentId, qr.paymentId, "reopening the order resumes the same QR, not a new trade");
  // A second attempt of another method (the page flow) for the same order.
  await pool.query("insert into payments (id, order_id, user_id, provider, method, amount_cents, currency, status) values ($1, $2, $3, 'alipay', 'page', 990, 'CNY', 'pending')", [`pay_second_${run}`, order6.id, userId]);
  aliTrades.set(`pay_second_${run}`, { amount: "9.90", status: "WAIT_BUYER_PAY", refunds: new Map() });
  aliPaid(qr.paymentId);
  aliPaid(`pay_second_${run}`);
  const balance6 = await tokenBalance();
  await notify({ out_trade_no: qr.paymentId, trade_no: aliTrades.get(qr.paymentId).tradeNo, trade_status: "TRADE_SUCCESS", total_amount: "9.90" });
  await notify({ out_trade_no: `pay_second_${run}`, trade_no: aliTrades.get(`pay_second_${run}`).tradeNo, trade_status: "TRADE_SUCCESS", total_amount: "9.90" });
  assert.equal(await tokenBalance(), balance6 + 100000, "one order, one credit");
  const dup = (await pool.query("select * from refunds where payment_id = $1", [`pay_second_${run}`])).rows[0];
  assert.equal(dup?.status, "succeeded", "the second payment went back to the buyer");
  assert.equal(aliTrades.get(`pay_second_${run}`).refunds.size, 1);
  assert.equal((await orderRow(order6.id)).status, "paid", "the order itself stays paid");

  // --- 10. Refunds: partial, then the rest; the credit follows ---------------------------------
  const grantOf = async (orderId) => (await pool.query("select * from wallet_grants where source_type = 'order' and source_id = $1", [orderId])).rows[0];
  r = await api("POST", `/api/admin/billing/orders/${order1.id}/refund`, { headers: admin, payload: { amountCents: 495, reason: "客户申请" } });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.status, "succeeded");
  let o1 = await orderRow(order1.id);
  assert.equal(o1.status, "partially_refunded");
  assert.equal(o1.refunded_cents, 495);
  assert.equal((await grantOf(order1.id)).unit_remaining, 50000, "half the money back, half the credit gone");
  r = await api("POST", `/api/admin/billing/orders/${order1.id}/refund`, { headers: admin, payload: { amountCents: 1000, reason: "超额" } });
  assert.equal(r.json.code, "REFUND_AMOUNT_INVALID", "never more than was paid");
  r = await api("POST", `/api/admin/billing/orders/${order1.id}/refund`, { headers: admin, payload: { reason: "余下全部" } });
  assert.equal(r.json.status, "succeeded");
  o1 = await orderRow(order1.id);
  assert.equal(o1.status, "refunded");
  const g1 = await grantOf(order1.id);
  assert.equal(g1.status, "revoked");
  assert.equal(g1.unit_remaining, 0);
  const refundLedger = (await pool.query("select money_delta_cents, unit_delta from wallet_ledger where source_type = 'refund' and metadata->>'orderId' = $1 order by created_at", [order1.id])).rows;
  assert.deepEqual(refundLedger.map((l) => Number(l.money_delta_cents)), [-495, -495], "each refund is booked");

  // --- 11. WeChat Native: QR, encrypted notification, async refund ------------------------------
  const order7 = await newOrder("wechat");
  const wx = (await api("POST", `/api/billing/orders/${order7.id}/checkout`, { payload: {} })).json;
  assert.equal(wx.checkout.kind, "qrcode");
  assert.match(wx.checkout.code, /^weixin:\/\/wxpay\//);
  const wxNotify = (transaction) => {
    const nonce = crypto.randomBytes(6).toString("hex");
    const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(API_V3), Buffer.from(nonce));
    cipher.setAAD(Buffer.from("transaction"));
    const data = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]);
    const body = JSON.stringify({ id: crypto.randomUUID(), event_type: "TRANSACTION.SUCCESS", resource: { algorithm: "AEAD_AES_256_GCM", ciphertext: data.toString("base64"), associated_data: "transaction", nonce } });
    const h = wxHeaders(body);
    return app.inject({ method: "POST", url: "/api/payments/wechat/notify", headers: { "content-type": "application/json", "wechatpay-timestamp": h["Wechatpay-Timestamp"], "wechatpay-nonce": h["Wechatpay-Nonce"], "wechatpay-signature": h["Wechatpay-Signature"], "wechatpay-serial": h["Wechatpay-Serial"] }, payload: body });
  };
  const t7 = wxTrades.get(wx.paymentId);
  t7.state = "SUCCESS"; t7.transactionId = `4200${Date.now()}`;
  const balance7 = await tokenBalance();
  n = await wxNotify({ out_trade_no: wx.paymentId, transaction_id: t7.transactionId, trade_state: "SUCCESS", appid: "wx_e2e", mchid: "1900000001", amount: { total: 990, currency: "CNY" } });
  assert.equal(n.statusCode, 200);
  assert.equal(n.json().code, "SUCCESS");
  assert.equal((await orderRow(order7.id)).status, "paid");
  assert.equal(await tokenBalance(), balance7 + 100000);
  const forged = await app.inject({ method: "POST", url: "/api/payments/wechat/notify", headers: { "content-type": "application/json", "wechatpay-timestamp": String(Math.floor(Date.now() / 1000)), "wechatpay-nonce": "x", "wechatpay-signature": "Zm9yZ2Vk", "wechatpay-serial": "PUB_KEY_ID_E2E" }, payload: '{"resource":{}}' });
  assert.equal(forged.statusCode, 500, "an unsigned WeChat notice is refused");
  r = await api("POST", `/api/admin/billing/orders/${order7.id}/refund`, { headers: admin, payload: { reason: "测试退款" } });
  assert.equal(r.json.status, "pending", "WeChat refunds are processed asynchronously");
  assert.equal((await orderRow(order7.id)).status, "paid", "not refunded until WeChat confirms");
  await pool.query("update refunds set created_at = now() - interval '1 minute' where order_id = $1", [order7.id]);
  sweep = await paymentService().sweep();
  assert.equal(sweep.refunds, 1);
  assert.equal((await orderRow(order7.id)).status, "refunded", "confirmed by the sweeper's refund query");

  // --- 12. Reconciliation: heal a missed payment, report a missing one --------------------------
  const order8 = await newOrder();
  await api("PATCH", "/api/admin/settings", { headers: admin, payload: { licenseTrialDays: 3, payment: { fakePaymentsEnabled: false, alipay: { enabled: true, appId: "2021000000000001", merchantId: "2088000000000001", publicKey: pem(aliKeys.publicKey, "spki"), checkoutMode: "qrcode" }, wechat: { enabled: true, appId: "wx_e2e", mchId: "1900000001", certSerialNo: "MCH_SERIAL", platformPublicKey: pem(platformKeys.publicKey, "spki"), platformPublicKeyId: "PUB_KEY_ID_E2E" } } } });
  const pay8 = (await api("POST", `/api/billing/orders/${order8.id}/checkout`, { payload: {} })).json.paymentId;
  aliPaid(pay8);
  const billDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  aliBillRows = [
    { outTradeNo: pay1, tradeNo: aliTrades.get(pay1).tradeNo, kind: "payment", amount: 990 },
    { outTradeNo: pay8, tradeNo: aliTrades.get(pay8).tradeNo, kind: "payment", amount: 990 }, // paid, never told
  ];
  r = await api("POST", "/api/admin/billing/reconciliation", { headers: admin, payload: { provider: "alipay", billDate } });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.healed, 1, "the statement is a truth source: the missed payment is settled");
  assert.equal((await orderRow(order8.id)).status, "paid");
  assert.ok(r.json.mismatches.some((m) => m.type === "missing_at_provider" && m.outTradeNo === pay2), "a payment we have that the statement lacks is reported");
  assert.equal(r.json.status, "mismatched");
  const runs = await api("GET", "/api/admin/billing/reconciliation", { headers: admin });
  assert.ok(runs.json.runs.some((x) => x.provider === "alipay" && x.status === "mismatched"));

  // A statement not generated yet is not an empty day: we took money, so wait.
  aliBillMissing = true;
  r = await api("POST", "/api/admin/billing/reconciliation", { headers: admin, payload: { provider: "alipay", billDate } });
  assert.equal(r.json.code, "BILL_NOT_READY", "a missing statement on a day we were paid is 'not ready', never 'all missing'");
  r = await api("POST", "/api/admin/billing/reconciliation", { headers: admin, payload: { provider: "alipay", billDate: "2020-01-01" } });
  assert.equal(r.json.status, "matched", "no statement on a day with no payments is simply a quiet day");
  aliBillMissing = false;

  // The day a payment belongs to is the provider's: paid 23:59 yesterday, settled today.
  const yesterday = new Date(Date.now() + 8 * 3600 * 1000 - 86_400_000).toISOString().slice(0, 10);
  const orderMidnight = await newOrder();
  const payMidnight = (await api("POST", `/api/billing/orders/${orderMidnight.id}/checkout`, { payload: {} })).json.paymentId;
  aliPaid(payMidnight, `${yesterday} 23:59:30`);
  await pool.query("update payments set last_synced_at = null where id = $1", [payMidnight]);
  r = await api("GET", `/api/billing/orders/${orderMidnight.id}`);
  assert.equal(r.json.order.status, "paid");
  const settledAt = (await pool.query("select succeeded_at from payments where id = $1", [payMidnight])).rows[0].succeeded_at;
  assert.equal(new Date(settledAt).toISOString(), new Date(`${yesterday}T23:59:30+08:00`).toISOString(), "the payment is booked at the provider's time");
  aliBillRows = [{ outTradeNo: payMidnight, tradeNo: aliTrades.get(payMidnight).tradeNo, kind: "payment", amount: 990 }];
  r = await api("POST", "/api/admin/billing/reconciliation", { headers: admin, payload: { provider: "alipay", billDate: yesterday } });
  assert.equal(r.json.status, "matched", "a trade paid before midnight and settled after it reconciles on the provider's day");
  assert.equal(r.json.healed, 0);

  // --- 13. The buyer's statement ----------------------------------------------------------------
  r = await api("GET", "/api/billing/statement?kind=topup");
  assert.equal(r.status, 200);
  const kinds = r.json.lines.map((l) => l.kind);
  assert.ok(kinds.includes("topup") && kinds.includes("refund"), "top-ups and refunds are listed");
  const top = r.json.lines.find((l) => l.kind === "topup");
  assert.equal(top.moneyCents, 990);
  assert.match(top.title, /购买 Token 包/);
  assert.ok(r.json.lines.filter((l) => l.kind === "refund").every((l) => l.orderId), "every refund line links to the order it returned money for");
  assert.ok(r.json.lines.some((l) => l.title === "重复支付退款"), "a double payment's refund says what it was");
  const all = (await api("GET", "/api/billing/statement?limit=200")).json.lines.map((l) => l.id);
  const walked = [];
  for (let before = "", guard = 0; guard < 100; guard += 1) {
    const page = (await api("GET", `/api/billing/statement?limit=1${before ? `&before=${encodeURIComponent(before)}` : ""}`)).json;
    walked.push(...page.lines.map((l) => l.id));
    if (!page.nextBefore) break;
    before = page.nextBefore;
  }
  assert.deepEqual(walked, all, "paging one line at a time walks the whole statement, none skipped or repeated");
  r = await api("GET", "/api/billing/balance");
  assert.ok(r.json.grants.every((g) => g.remaining > 0), "the balance lists what is left, by grant, with expiry");
  r = await api("GET", "/api/billing/orders");
  assert.ok(r.json.orders.some((o) => o.status === "refunded" && o.refundedCents === 990));
  r = await api("GET", "/api/admin/billing/orders?status=paid", { headers: admin });
  assert.ok(r.json.orders.length >= 3);
  r = await api("GET", `/api/admin/billing/orders/${order6.id}`, { headers: admin });
  assert.equal(r.json.order.payments.length, 2);
  assert.ok(r.json.order.events.length >= 2);

  // --- 14. Fake payments: never in production ------------------------------------------------------
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  r = await api("PATCH", "/api/admin/settings", { headers: admin, payload: { licenseTrialDays: 3, payment: { fakePaymentsEnabled: true } } });
  assert.equal(r.json.code, "FAKE_PAYMENTS_FORBIDDEN_IN_PRODUCTION");
  await pool.query("update app_settings set value = jsonb_set(value, '{fakePaymentsEnabled}', 'true') where key = 'payment_config'").catch(() => {});
  const order9 = await newOrder();
  r = await api("POST", `/api/billing/orders/${order9.id}/mock-pay`);
  assert.equal(r.status, 404, "even if the setting is forced on in the database, production refuses");
  process.env.NODE_ENV = prevEnv;

  console.log("payments-e2e: ok");
} finally {
  await app.close();
  aliServer.close();
  wxServer.close();
  await pool.end();
}
