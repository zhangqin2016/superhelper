#!/usr/bin/env node
// Payment provider adapters, pure: RSA2 signing/verification, response
// signature extraction, notification verification (tampered / forged / wrong
// key), money conversion, WeChat v3 signatures + AES-GCM resources, statement
// parsing (Alipay's GBK zip, WeChat's backtick CSV).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const money = await import("../server/src/services/payments/money.js");
const alipay = await import("../server/src/services/payments/alipay.js");
const wechat = await import("../server/src/services/payments/wechat.js");
const { readZipEntries } = await import("../server/src/services/payments/zip.js");

const pair = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = (key, type) => key.export({ type, format: "pem" });
const bare = (key, type) => key.export({ type, format: "der" }).toString("base64"); // Alipay tool style

// --- money: digits, never floats ------------------------------------------------
assert.equal(money.centsToYuan(990), "9.90");
assert.equal(money.centsToYuan(5), "0.05");
assert.equal(money.centsToYuan(100000), "1000.00");
assert.equal(money.yuanToCents("0.29"), 29, "0.29 is 29 cents (a float would say 28)");
assert.equal(money.yuanToCents("9.9"), 990);
assert.equal(money.yuanToCents("10"), 1000);
assert.equal(money.yuanToCents("1.234"), null, "sub-cent amounts are not amounts");
assert.equal(money.yuanToCents("abc"), null);
assert.equal(alipay.beijingTime(new Date("2026-09-24T16:30:05Z")), "2026-09-25 00:30:05", "Beijing wall time");

// --- Alipay: sign, verify, the exact content rules -----------------------------
const app = pair();      // our application key pair
const ali = pair();      // Alipay's key pair (its public key is what we configure)
{
  const params = { b: "2", a: "1", empty: "", sign_type: "RSA2", sign: "x" };
  assert.equal(alipay.signContent(params), "a=1&b=2&sign_type=RSA2", "sorted, empties and sign dropped");
  assert.equal(alipay.signContent(params, { excludeSignType: true }), "a=1&b=2", "notify verification also drops sign_type");
  const sig = alipay.rsa2Sign("hello", bare(app.privateKey, "pkcs8"));
  assert.equal(alipay.rsa2Verify("hello", sig, bare(app.publicKey, "spki")), true, "bare base64 keys (Alipay key tool) work");
  assert.equal(alipay.rsa2Verify("hello", sig, pem(app.publicKey, "spki")), true, "PEM keys work");
  assert.equal(alipay.rsa2Verify("hellO", sig, pem(app.publicKey, "spki")), false);
  assert.equal(alipay.rsa2Verify("hello", "garbage", pem(app.publicKey, "spki")), false);
  assert.equal(alipay.rsa2Sign("x", pem(app.privateKey, "pkcs1")).length > 100, true, "PKCS#1 private keys work");
}

// The signed bytes of a response are the raw JSON text, key order and escapes intact.
{
  const inner = '{"code":"10000","msg":"Success","out_trade_no":"pay_1","qr_code":"https://qr.alipay.com/x\\"y","nested":{"a":"}"}}';
  const body = `{"alipay_trade_precreate_response":${inner},"sign":"abc"}`;
  assert.equal(alipay.extractSignedResponse(body, "alipay.trade.precreate"), inner);
  assert.equal(alipay.extractSignedResponse('{"error_response":{"code":"40002"},"sign":"s"}', "alipay.trade.query"), '{"code":"40002"}');
}

const config = { appId: "2021000000000001", merchantId: "2088000000000001", privateKey: pem(app.privateKey, "pkcs8"), publicKey: pem(ali.publicKey, "spki"), notifyUrl: "https://api.example/api/payments/alipay/notify", gatewayUrl: "https://gw.example/gateway.do" };
const gateway = alipay.createAlipayGateway(config, { now: () => new Date("2026-09-24T02:00:00Z") });

// Redirect checkout: a signed URL Alipay can verify with OUR public key.
{
  const { ok, checkout } = await gateway.createCharge({ outTradeNo: "pay_1", amountCents: 990, subject: "Lily Token 包", method: "page", expiresAt: new Date("2026-09-24T02:30:00Z"), returnUrl: "https://www.example/account/orders/ord_1" });
  assert.equal(ok, true);
  assert.equal(checkout.kind, "redirect");
  const url = new URL(checkout.url);
  assert.equal(url.origin + url.pathname, "https://gw.example/gateway.do");
  const params = Object.fromEntries(url.searchParams);
  assert.equal(params.method, "alipay.trade.page.pay");
  assert.equal(params.notify_url, config.notifyUrl);
  const biz = JSON.parse(params.biz_content);
  assert.deepEqual([biz.out_trade_no, biz.total_amount, biz.product_code, biz.time_expire], ["pay_1", "9.90", "FAST_INSTANT_TRADE_PAY", "2026-09-24 10:30:00"]);
  assert.equal(alipay.rsa2Verify(alipay.signContent(params), params.sign, pem(app.publicKey, "spki")), true, "Alipay can verify our request");
  const wap = await gateway.createCharge({ outTradeNo: "pay_2", amountCents: 1, subject: "x", method: "wap", expiresAt: new Date(), returnUrl: "https://r" });
  assert.equal(new URL(wap.checkout.url).searchParams.get("method"), "alipay.trade.wap.pay");
}

// Notifications: genuine, tampered, forged with the wrong key.
function aliNotify(fields, key = ali.privateKey) {
  const params = { notify_id: "n1", notify_type: "trade_status_sync", sign_type: "RSA2", charset: "utf-8", ...fields };
  return { ...params, sign: alipay.rsa2Sign(alipay.signContent(params, { excludeSignType: true }), pem(key, "pkcs8")) };
}
{
  const good = aliNotify({ out_trade_no: "pay_1", trade_no: "2026092422001", trade_status: "TRADE_SUCCESS", total_amount: "9.90", app_id: config.appId, seller_id: config.merchantId });
  const v = gateway.verifyNotify(good);
  assert.equal(v.verified, true);
  assert.deepEqual([v.result.status, v.result.amountCents, v.result.outTradeNo, v.result.providerTradeNo, v.result.appId, v.result.merchantId], ["succeeded", 990, "pay_1", "2026092422001", config.appId, config.merchantId]);
  assert.equal(v.ack, "success");
  assert.equal(v.result.raw.sign, undefined, "the signature is not kept in the event log");
  assert.equal(gateway.verifyNotify({ ...good, total_amount: "0.01" }).verified, false, "a tampered amount fails verification");
  assert.equal(gateway.verifyNotify(aliNotify({ out_trade_no: "pay_1", trade_status: "TRADE_SUCCESS", total_amount: "9.90" }, app.privateKey)).verified, false, "signed by anyone but Alipay: rejected");
  assert.equal(gateway.verifyNotify({ ...good, sign: undefined }).verified, false);
  assert.equal(gateway.verifyNotify(aliNotify({ out_trade_no: "p", trade_status: "WAIT_BUYER_PAY", total_amount: "1" })).result.status, "pending");
  assert.equal(gateway.verifyNotify(aliNotify({ out_trade_no: "p", trade_status: "TRADE_CLOSED", total_amount: "1" })).result.status, "closed");
}

// API responses are verified before they are believed.
{
  const signResponse = (method, inner) => `{"${method.replace(/\./g, "_")}_response":${inner},"sign":"${alipay.rsa2Sign(inner, pem(ali.privateKey, "pkcs8"))}"}`;
  let reply = "";
  const fake = alipay.createAlipayGateway(config, { fetchImpl: async () => ({ text: async () => reply }) });
  reply = signResponse("alipay.trade.query", '{"code":"10000","msg":"Success","out_trade_no":"pay_1","trade_no":"T1","trade_status":"TRADE_SUCCESS","total_amount":"9.90"}');
  const q = await fake.query("pay_1");
  assert.equal(q.ok, true);
  assert.equal(q.result.status, "succeeded");
  assert.equal(q.result.amountCents, 990);
  reply = reply.replace('"9.90"', '"0.01"');
  assert.equal((await fake.query("pay_1")).code, "ALIPAY_RESPONSE_SIGNATURE_INVALID", "an altered response is refused");
  reply = '{"alipay_trade_query_response":{"code":"10000","trade_status":"TRADE_SUCCESS"}}';
  assert.equal((await fake.query("pay_1")).code, "ALIPAY_RESPONSE_UNSIGNED", "an unsigned 'success' is refused");
  reply = signResponse("alipay.trade.query", '{"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_NOT_EXIST"}');
  assert.equal((await fake.query("pay_1")).result.status, "not_found", "not opened yet is not an error");
  reply = signResponse("alipay.trade.close", '{"code":"40004","sub_code":"ACQ.TRADE_NOT_EXIST"}');
  assert.equal((await fake.close("pay_1")).ok, true, "closing what never existed is fine");
  const down = alipay.createAlipayGateway(config, { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal((await down.query("pay_1")).code, "ALIPAY_UNREACHABLE");
}

// --- Alipay statement: GBK CSV inside a zip -----------------------------------------
function zipOf(files) {
  // Minimal writer (stored + deflated) to feed the reader real archive bytes.
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
{
  const csv = [
    "#支付宝业务明细查询",
    "#账号：[20880000000000010156]",
    "支付宝交易号,商户订单号,业务类型,商品名称,创建时间,完成时间,门店编号,门店名称,操作员,终端号,对方账户,订单金额（元）,商家实收（元）",
    "2026092422001\t,pay_1\t,交易,Lily Token 包,2026-09-24 10:00:00,2026-09-24 10:00:30,,,,,a***@x.com,9.90,9.90",
    "2026092422002\t,pay_2\t,退款,Lily Token 包,2026-09-24 11:00:00,2026-09-24 11:00:30,,,,,a***@x.com,-9.90,-9.90",
    "#-----------------------------------------业务明细列表结束------------------------------------",
  ].join("\r\n");
  // Encode as GBK the way Alipay does (TextEncoder has no GBK; round-trip via a known table is overkill — ASCII+UTF8 names are enough to prove the parser; GBK decoding is exercised on real bytes below).
  const gbkHeader = Buffer.from("d6a7b8b6b1a6bdbbd2d7bac5", "hex"); // "支付宝交易号" in GBK
  assert.equal(new TextDecoder("gbk").decode(gbkHeader), "支付宝交易号", "the runtime decodes GBK");
  assert.equal(alipay.decodeStatement(gbkHeader), "支付宝交易号", "a GBK statement (what Alipay sends) is decoded as GBK");
  assert.equal(alipay.decodeStatement(Buffer.from("支付宝交易号", "utf8")), "支付宝交易号", "a UTF-8 one as UTF-8");
  const rows = alipay.parseAlipayBillCsv(csv);
  assert.deepEqual(rows, [
    { outTradeNo: "pay_1", providerTradeNo: "2026092422001", kind: "payment", amountCents: 990 },
    { outTradeNo: "pay_2", providerTradeNo: "2026092422002", kind: "refund", amountCents: 990 },
  ]);
  const archive = zipOf([
    { name: "20880000000000010156_20260924_业务明细.csv", data: Buffer.from(csv, "utf8"), deflate: true },
    { name: "20880000000000010156_20260924_业务明细(汇总).csv", data: Buffer.from("汇总", "utf8") },
  ]);
  const entries = readZipEntries(archive);
  assert.deepEqual(entries.map((e) => e.name), ["20880000000000010156_20260924_业务明细.csv", "20880000000000010156_20260924_业务明细(汇总).csv"]);
  assert.equal(entries[0].data.toString("utf8"), csv, "deflated entry inflates back exactly");
}

// --- WeChat Pay v3 ---------------------------------------------------------------------
const merchant = pair();
const platform = pair();
const apiV3Key = "0123456789abcdef0123456789abcdef";
const wcfg = { appId: "wx123", mchId: "1900000001", certSerialNo: "SERIAL1", privateKey: pem(merchant.privateKey, "pkcs8"), apiV3Key, platformPublicKey: pem(platform.publicKey, "spki"), platformPublicKeyId: "PUB_KEY_ID_1", notifyUrl: "https://api.example/api/payments/wechat/notify", baseUrl: "https://wx.example" };
const nowMs = Date.parse("2026-09-24T02:00:00Z");
function wxSign(timestamp, nonce, body, key = platform.privateKey) {
  return crypto.sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), key).toString("base64");
}
function encrypt(obj) {
  const nonce = "0123456789ab";
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from("transaction"));
  const data = Buffer.concat([cipher.update(JSON.stringify(obj)), cipher.final(), cipher.getAuthTag()]);
  return { algorithm: "AEAD_AES_256_GCM", ciphertext: data.toString("base64"), associated_data: "transaction", nonce };
}
{
  const ts = String(nowMs / 1000);
  const body = JSON.stringify({ event_type: "TRANSACTION.SUCCESS", resource: encrypt({ out_trade_no: "pay_w1", transaction_id: "4200001", trade_state: "SUCCESS", appid: "wx123", mchid: "1900000001", amount: { total: 990, currency: "CNY" } }) });
  const headers = { "wechatpay-timestamp": ts, "wechatpay-nonce": "abc", "wechatpay-signature": wxSign(ts, "abc", body), "wechatpay-serial": "PUB_KEY_ID_1" };
  const g = wechat.createWechatGateway(wcfg, { now: () => nowMs });
  const v = g.verifyNotify({ headers, body });
  assert.equal(v.verified, true);
  assert.deepEqual([v.result.status, v.result.amountCents, v.result.outTradeNo, v.result.providerTradeNo, v.result.appId, v.result.merchantId], ["succeeded", 990, "pay_w1", "4200001", "wx123", "1900000001"]);
  assert.equal(g.verifyNotify({ headers, body: body.replace("TRANSACTION", "TRANSACTIoN") }).verified, false, "a changed body fails the signature");
  assert.equal(g.verifyNotify({ headers: { ...headers, "wechatpay-serial": "OTHER" }, body }).verified, false, "a key id that is not ours is refused");
  const replay = wechat.createWechatGateway(wcfg, { now: () => nowMs + 10 * 60_000 });
  assert.equal(replay.verifyNotify({ headers, body }).verified, false, "a 10-minute-old notification is a replay");
  const wrongKey = wechat.createWechatGateway({ ...wcfg, apiV3Key: "ffffffffffffffffffffffffffffffff" }, { now: () => nowMs });
  const undecryptable = wrongKey.verifyNotify({ headers, body });
  assert.equal(undecryptable.verified, false, "signed but not decryptable with our key: not a payment");
  assert.equal(undecryptable.nack.status, 500, "…and WeChat is told to retry");

  // Requests carry a v3 Authorization the merchant key signed; responses are verified.
  let seen = null;
  const reply = { status: 200, body: JSON.stringify({ code_url: "weixin://wxpay/bizpayurl?pr=abc" }) };
  const fake = wechat.createWechatGateway(wcfg, {
    now: () => nowMs,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      const rts = String(nowMs / 1000);
      return { ok: reply.status < 300, status: reply.status, text: async () => reply.body, headers: new Map(Object.entries({ "Wechatpay-Timestamp": rts, "Wechatpay-Nonce": "n", "Wechatpay-Signature": wxSign(rts, "n", reply.body), "Wechatpay-Serial": "PUB_KEY_ID_1" })) };
    },
  });
  const charge = await fake.createCharge({ outTradeNo: "pay_w1", amountCents: 990, subject: "Lily", expiresAt: new Date(nowMs + 1800_000) });
  assert.deepEqual(charge, { ok: true, checkout: { kind: "qrcode", code: "weixin://wxpay/bizpayurl?pr=abc" } });
  assert.equal(seen.url, "https://wx.example/v3/pay/transactions/native");
  const auth = seen.init.headers.Authorization;
  const field = (k) => new RegExp(`${k}="([^"]*)"`).exec(auth)[1];
  const message = `POST\n/v3/pay/transactions/native\n${field("timestamp")}\n${field("nonce_str")}\n${seen.init.body}\n`;
  assert.equal(crypto.verify("RSA-SHA256", Buffer.from(message), merchant.publicKey, Buffer.from(field("signature"), "base64")), true, "WeChat can verify our request");
  assert.equal(JSON.parse(seen.init.body).amount.total, 990);
  assert.equal(JSON.parse(seen.init.body).time_expire, "2026-09-24T10:30:00+08:00");
  reply.body = reply.body.replace("abc", "abd");
  const tampered = await wechat.createWechatGateway(wcfg, { now: () => nowMs, fetchImpl: async () => ({ ok: true, status: 200, text: async () => reply.body, headers: new Map(Object.entries({ "Wechatpay-Timestamp": String(nowMs / 1000), "Wechatpay-Nonce": "n", "Wechatpay-Signature": wxSign(String(nowMs / 1000), "n", '{"code_url":"x"}'), "Wechatpay-Serial": "PUB_KEY_ID_1" })) }) }).createCharge({ outTradeNo: "x", amountCents: 1, subject: "x", expiresAt: new Date() });
  assert.equal(tampered.code, "WECHAT_RESPONSE_SIGNATURE_INVALID");
}
{
  const csv = [
    "交易时间,公众账号ID,商户号,特约商户号,设备号,微信订单号,商户订单号,用户标识,交易类型,交易状态,付款银行,货币种类,应结订单金额,代金券金额,微信退款单号,商户退款单号,退款金额,充值券退款金额,退款类型,退款状态,商品名称,商户数据包,手续费,费率,订单金额,申请退款金额,费率备注",
    "`2026-09-24 10:00:00,`wx123,`1900000001,`0,`,`4200001,`pay_w1,`o1,`NATIVE,`SUCCESS,`OTHERS,`CNY,`9.90,`0.00,`0,`0,`0.00,`0.00,`,`,`Lily,`,`0.05940,`0.60%,`9.90,`0.00,`",
    "`2026-09-24 11:00:00,`wx123,`1900000001,`0,`,`4200002,`pay_w2,`o1,`NATIVE,`REFUND,`OTHERS,`CNY,`0.00,`0.00,`500001,`rfd_1,`9.90,`0.00,`ORIGINAL,`SUCCESS,`Lily,`,`-0.05940,`0.60%,`9.90,`9.90,`",
    "总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额",
    "`2,`9.90,`9.90,`0.00,`0.00000,`19.80,`9.90",
  ].join("\n");
  assert.deepEqual(wechat.parseWechatBillCsv(csv), [
    { outTradeNo: "pay_w1", providerTradeNo: "4200001", kind: "payment", amountCents: 990 },
    { outTradeNo: "pay_w2", providerTradeNo: "4200002", kind: "refund", amountCents: 990 },
  ]);
}

// --- provider payment times: the statement day is the provider's ---------------
assert.equal(alipay.parseBeijingTime("2026-09-23 23:59:30"), "2026-09-23T15:59:30.000Z");
assert.equal(alipay.parseBeijingTime(""), "");
assert.equal(alipay.parseBeijingTime("2026/09/23 23:59"), "", "a malformed time is absent, never a guess");
assert.equal(alipay.beijingTime(new Date(alipay.parseBeijingTime("2026-01-01 00:00:05"))), "2026-01-01 00:00:05", "round-trips");

console.log("payment-adapters: ok");
