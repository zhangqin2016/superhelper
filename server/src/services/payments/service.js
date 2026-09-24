// The payment domain's public face: orders, checkout, notifications, status,
// the sweeper and refunds.
//
//   order    pending ──paid──▶ paid ──refund──▶ partially_refunded / refunded
//              └──expires──▶ closed ──(late payment)──▶ paid
//   payment  one attempt to pay an order; its id is the merchant trade number
//
// Truth comes only from a signature-verified notification or an active query
// of the provider — never from the buyer's browser coming back. Whatever the
// source, it is settled by settlement.js (row locks, one fulfilment, money and
// credit in one transaction); statements are compared by reconcile.js.

import QRCode from "qrcode";
import { db as defaultDb } from "../../db.js";
import { getPaymentConfig } from "../app-settings.js";
import { publicId } from "../ids.js";
import { createGateway, effectiveProviderConfig, fakePaymentsAllowed, readyProviders } from "./providers.js";
import { createReconciler } from "./reconcile.js";
import { createSettlement } from "./settlement.js";

export const ORDER_TTL_MS = 30 * 60 * 1000;
const SYNC_THROTTLE_MS = 3_000;
const STALE_PENDING_MS = 2 * 60 * 1000;

const METHOD_LABEL = { page: "支付宝网页支付", wap: "支付宝手机支付", precreate: "支付宝扫码", native: "微信扫码" };

function paymentError(code, status = 400) {
  return { ok: false, code, status };
}

export function createPaymentService({
  db = defaultDb,
  loadConfig = getPaymentConfig,
  gatewayFor = (provider, payment) => createGateway(provider, payment),
  now = () => new Date(),
  log = { info() {}, warn() {} },
} = {}) {
  const settlement = createSettlement({ db, gatewayFor, now, log });
  const { recordEvent, fulfil, settle, syncPayment, executeRefund, applyRefund } = settlement;
  const { reconcile } = createReconciler({ db, loadConfig, gatewayFor, now, settlement });

  return {
    recordEvent,

    /** Providers a buyer can pay with right now (ready, not just enabled). */
    async availableProviders() {
      const payment = await loadConfig();
      return { providers: readyProviders(payment), fakePayments: fakePaymentsAllowed(payment) };
    },

    async createOrder({ userId, productId, provider }) {
      const payment = await loadConfig();
      if (!readyProviders(payment).includes(provider) && !fakePaymentsAllowed(payment)) return paymentError("PAYMENT_PROVIDER_UNAVAILABLE");
      const product = await db.selectFrom("products").selectAll().where("id", "=", productId).where("status", "=", "active").executeTakeFirst();
      if (!product) return paymentError("PRODUCT_NOT_FOUND", 404);
      const user = await db.selectFrom("users").select(["id", "status"]).where("id", "=", userId).executeTakeFirst();
      if (!user || user.status !== "active") return paymentError("USER_NOT_ACTIVE", 403);
      const order = {
        id: publicId("ord"),
        user_id: userId,
        product_id: product.id,
        provider,
        amount_cents: product.price_cents,
        currency: product.currency || "CNY",
        status: "pending",
        expires_at: new Date(now().getTime() + ORDER_TTL_MS),
      };
      await db.insertInto("orders").values(order).execute();
      return { ok: true, order: { ...order, product_name: product.name } };
    },

    /**
     * Start (or resume) paying an order.
     * @param {"desktop"|"mobile"} client  decides Alipay's page vs wap checkout
     * @returns {{ ok, checkout: { kind: "redirect", url } | { kind: "qrcode", code, image } }}
     */
    async checkout({ userId, orderId, client = "desktop" }) {
      const payment = await loadConfig();
      const order = await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
      if (!order || order.user_id !== userId) return paymentError("ORDER_NOT_FOUND", 404);
      if (order.status !== "pending") return paymentError(order.status === "paid" ? "ORDER_ALREADY_PAID" : "ORDER_NOT_PAYABLE", 409);
      if (new Date(order.expires_at).getTime() <= now().getTime()) return paymentError("ORDER_EXPIRED", 409);
      if (!readyProviders(payment).includes(order.provider)) return paymentError("PAYMENT_PROVIDER_UNAVAILABLE");
      const provider = order.provider;
      const cfg = effectiveProviderConfig(provider, payment);
      const method = provider === "wechat" ? "native" : cfg.checkoutMode === "qrcode" ? "precreate" : client === "mobile" ? "wap" : "page";
      const product = await db.selectFrom("products").select(["name"]).where("id", "=", order.product_id).executeTakeFirst();

      // Resume the open attempt of the same method instead of starting another.
      let pay = await db.selectFrom("payments").selectAll()
        .where("order_id", "=", order.id).where("method", "=", method).where("status", "=", "pending")
        .orderBy("created_at", "desc").executeTakeFirst();
      if (pay?.checkout?.kind === "qrcode" && pay.checkout.code) {
        return { ok: true, paymentId: pay.id, method, checkout: { ...pay.checkout, image: await QRCode.toDataURL(pay.checkout.code, { margin: 1, width: 360 }) } };
      }
      if (!pay) {
        pay = { id: publicId("pay"), order_id: order.id, user_id: userId, provider, method, amount_cents: order.amount_cents, currency: order.currency, status: "pending" };
        await db.insertInto("payments").values(pay).execute();
      }
      const charge = await gatewayFor(provider, payment).createCharge({
        outTradeNo: pay.id,
        amountCents: order.amount_cents,
        subject: `Lily ${product?.name || order.product_id}`,
        method,
        expiresAt: new Date(order.expires_at),
        returnUrl: cfg.returnBase ? `${cfg.returnBase}/account/orders/${encodeURIComponent(order.id)}` : "",
      });
      if (!charge.ok) {
        await recordEvent({ provider, paymentId: pay.id, kind: "charge", outcome: "error", detail: `${charge.code} ${charge.detail || ""}` });
        await db.updateTable("payments").set({ status: "failed", updated_at: now() }).where("id", "=", pay.id).execute();
        return paymentError(charge.code || "PAYMENT_CHARGE_FAILED", 502);
      }
      // A redirect URL carries a signed timestamp: re-signed per checkout, never stored.
      const stored = charge.checkout.kind === "qrcode" ? charge.checkout : { kind: "redirect" };
      await db.updateTable("payments").set({ checkout: JSON.stringify(stored), updated_at: now() }).where("id", "=", pay.id).execute();
      await db.updateTable("orders").set({ payment_id: pay.id, updated_at: now() }).where("id", "=", order.id).where("status", "=", "pending").execute();
      const checkout = charge.checkout.kind === "qrcode"
        ? { ...charge.checkout, image: await QRCode.toDataURL(charge.checkout.code, { margin: 1, width: 360 }) }
        : charge.checkout;
      return { ok: true, paymentId: pay.id, method, methodLabel: METHOD_LABEL[method], checkout };
    },

    /**
     * A provider's asynchronous notification.
     * @param {"alipay"|"wechat"} provider
     * @param {object} input  alipay: the form fields; wechat: { headers, body }
     * @returns {{ ack: boolean, reply }}  reply is what the provider must receive
     */
    async handleNotify(provider, input) {
      const payment = await loadConfig();
      const gateway = gatewayFor(provider, payment);
      const notice = gateway.verifyNotify(input);
      if (!notice.verified) {
        await recordEvent({ provider, paymentId: notice.result?.outTradeNo || null, kind: "notify", outcome: "rejected", detail: "signature invalid", payload: provider === "alipay" ? notice.result?.raw : {} });
        return { ack: false, reply: notice.nack };
      }
      let settled;
      try {
        settled = await settle(provider, notice.result, payment);
      } catch (err) {
        await recordEvent({ provider, paymentId: notice.result.outTradeNo, kind: "notify", verified: true, outcome: "error", detail: err?.message, payload: notice.result.raw });
        // Not acknowledged: the provider retries, and nothing was half-done (one transaction).
        return { ack: false, reply: notice.nack };
      }
      await recordEvent({ provider, paymentId: notice.result.outTradeNo, kind: "notify", verified: true, outcome: settled.outcome, detail: settled.detail, payload: notice.result.raw });
      // A rejected (e.g. amount mismatch) or unknown notice is acknowledged too:
      // retrying cannot change it, and it is on record for a human.
      return { ack: true, reply: notice.ack };
    },

    /** The buyer is looking at the order: ask the provider (throttled) if still pending. */
    async orderStatus({ userId, orderId }) {
      let order = await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
      if (!order || order.user_id !== userId) return paymentError("ORDER_NOT_FOUND", 404);
      if (order.status === "pending") {
        const payment = await loadConfig();
        const open = await db.selectFrom("payments").selectAll().where("order_id", "=", order.id).where("status", "=", "pending").execute();
        for (const pay of open) {
          const last = pay.last_synced_at ? new Date(pay.last_synced_at).getTime() : 0;
          if (now().getTime() - last >= SYNC_THROTTLE_MS) await syncPayment(pay, payment, { source: "query" });
        }
        order = await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
      }
      return { ok: true, order };
    },

    /**
     * Background: find what notifications missed, and close what expired.
     * Idempotent; safe to run from several places at once.
     */
    async sweep() {
      const payment = await loadConfig();
      const t = now().getTime();
      const report = { synced: 0, closed: 0, refunds: 0 };
      // 1. Pending payments older than a couple of minutes: a notification may be lost.
      const stale = await db.selectFrom("payments").selectAll()
        .where("status", "=", "pending")
        .where("created_at", "<", new Date(t - STALE_PENDING_MS))
        .orderBy("created_at", "asc").limit(100).execute();
      for (const pay of stale) {
        const last = pay.last_synced_at ? new Date(pay.last_synced_at).getTime() : 0;
        if (t - last < 60_000) continue;
        await syncPayment(pay, payment, { source: "sweep" });
        report.synced += 1;
      }
      // 2. Expired orders: ask once more (it may have been paid), then close.
      const expired = await db.selectFrom("orders").selectAll()
        .where("status", "=", "pending").where("expires_at", "<", new Date(t))
        .orderBy("expires_at", "asc").limit(100).execute();
      for (const order of expired) {
        const open = await db.selectFrom("payments").selectAll().where("order_id", "=", order.id).where("status", "=", "pending").execute();
        let paid = false;
        for (const pay of open) {
          const r = await syncPayment(pay, payment, { source: "sweep" });
          if (r.outcome === "settled" || r.outcome === "duplicate") paid = true;
        }
        if (paid) continue;
        let allClosed = true;
        for (const pay of await db.selectFrom("payments").selectAll().where("order_id", "=", order.id).where("status", "=", "pending").execute()) {
          const res = await gatewayFor(pay.provider, payment).close(pay.id).catch((err) => ({ ok: false, code: err?.message }));
          await recordEvent({ provider: pay.provider, paymentId: pay.id, kind: "close", verified: Boolean(res.ok), outcome: res.ok ? "closed" : "error", detail: res.ok ? "order expired" : res.code });
          if (res.ok) await db.updateTable("payments").set({ status: "closed", closed_at: now(), updated_at: now() }).where("id", "=", pay.id).where("status", "=", "pending").execute();
          else allClosed = false;
        }
        if (allClosed) {
          const r = await db.updateTable("orders").set({ status: "closed", closed_at: now(), updated_at: now() }).where("id", "=", order.id).where("status", "=", "pending").executeTakeFirst();
          report.closed += Number(r?.numUpdatedRows || 0);
        }
      }
      // 3. Refunds the provider was still processing.
      const refunds = await db.selectFrom("refunds").selectAll().where("status", "=", "pending").where("created_at", "<", new Date(t - 30_000)).limit(50).execute();
      for (const refund of refunds) {
        const pay = await db.selectFrom("payments").selectAll().where("id", "=", refund.payment_id).executeTakeFirst();
        const res = await gatewayFor(pay.provider, payment).refundQuery({ outTradeNo: pay.id, outRequestNo: refund.id }).catch(() => ({ ok: false }));
        if (res.ok && res.status === "succeeded") { await applyRefund(refund.id); report.refunds += 1; }
        else if (res.ok && res.status === "failed") await db.updateTable("refunds").set({ status: "failed", error: "provider reported failure", updated_at: now() }).where("id", "=", refund.id).execute();
      }
      return report;
    },

    /** Admin: return money for a paid order (all or part). */
    async refund({ orderId, amountCents, reason, actor }) {
      const payment = await loadConfig();
      // Check what is left and claim it in one locked step, so two refunds
      // issued at once can never together exceed what was paid.
      const claim = await db.transaction().execute(async (trx) => {
        const order = await trx.selectFrom("orders").selectAll().where("id", "=", orderId).forUpdate().executeTakeFirst();
        if (!order) return paymentError("ORDER_NOT_FOUND", 404);
        if (!["paid", "partially_refunded"].includes(order.status) || !order.payment_id) return paymentError("ORDER_NOT_REFUNDABLE", 409);
        const pay = await trx.selectFrom("payments").selectAll().where("id", "=", order.payment_id).executeTakeFirst();
        if (!pay || pay.status !== "succeeded") return paymentError("ORDER_NOT_REFUNDABLE", 409);
        const inFlight = await trx.selectFrom("refunds").select((eb) => eb.fn.sum("amount_cents").as("sum")).where("order_id", "=", order.id).where("payment_id", "=", pay.id).where("status", "=", "pending").executeTakeFirst();
        const refundable = order.amount_cents - Number(order.refunded_cents || 0) - Number(inFlight?.sum || 0);
        const amount = Math.trunc(Number(amountCents ?? refundable));
        if (!(amount > 0) || amount > refundable) return paymentError("REFUND_AMOUNT_INVALID");
        const refundId = publicId("rfd");
        await trx.insertInto("refunds").values({ id: refundId, order_id: order.id, payment_id: pay.id, user_id: order.user_id, amount_cents: amount, reason: String(reason || "").slice(0, 200) || null, status: "pending", actor: String(actor || "admin") }).execute();
        return { ok: true, refundId };
      });
      if (!claim.ok) return claim;
      const { refundId } = claim;
      const res = await executeRefund(refundId, payment);
      return res.ok ? { ok: true, refundId, status: res.status } : { ...paymentError(res.code || "REFUND_FAILED", 502), refundId };
    },

    /** Admin: re-ask the provider about an order's attempts now. */
    async syncOrderNow(orderId) {
      const payment = await loadConfig();
      const open = await db.selectFrom("payments").selectAll().where("order_id", "=", orderId).where("status", "in", ["pending", "closed"]).execute();
      const results = [];
      for (const pay of open) results.push({ paymentId: pay.id, ...(await syncPayment(pay, payment, { source: "query" })) });
      return { ok: true, results };
    },

    reconcile,

    /** Fake settlement (development / the console's test mode) through the SAME fulfilment. */
    async fakeSettle({ orderId, userId = null }) {
      const payment = await loadConfig();
      if (!fakePaymentsAllowed(payment)) return paymentError("NOT_FOUND", 404);
      return db.transaction().execute(async (trx) => {
        const order = await trx.selectFrom("orders").selectAll().where("id", "=", orderId).forUpdate().executeTakeFirst();
        if (!order || (userId && order.user_id !== userId)) return paymentError("ORDER_NOT_FOUND", 404);
        if (order.status !== "pending") return paymentError(order.status === "paid" ? "ORDER_ALREADY_PAID" : "ORDER_NOT_PAYABLE", 409);
        const grant = await fulfil(trx, order, { paymentId: null, providerOrderId: `fake_${publicId("pay")}`, provider: "fake" });
        return { ok: true, grantId: grant.id };
      });
    },
  };
}

let shared = null;
/** The process-wide service over the real database and settings. */
export function paymentService() {
  if (!shared) shared = createPaymentService();
  return shared;
}
