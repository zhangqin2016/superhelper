// Settlement: the ONE path from a provider's word to an order's state.
//
// A verified notification, an active query, the sweeper and reconciliation all
// arrive here. Each input is recorded in payment_events, then settled under
// row locks, so racing inputs on the same order produce exactly one
// fulfilment; fulfilment (grant + ledger) commits in the same transaction as
// "paid", so money and credit never diverge. Refunds are applied the same way:
// money back and credit taken back in one transaction.

import { createGrantFromPaidOrder } from "../billing.js";
import { publicId } from "../ids.js";
import { effectiveProviderConfig } from "./providers.js";

export function createSettlement({ db, gatewayFor, now, log }) {
  /** The provider's payment time when it gave a sane one, else ours. */
  function paidTime(iso) {
    const at = Date.parse(iso || "");
    const ours = now();
    // Not in the future (clock skew aside), not before the attempt could exist.
    return Number.isFinite(at) && at <= ours.getTime() + 5 * 60_000 && at > ours.getTime() - 400 * 86_400_000 ? new Date(at) : ours;
  }

  async function recordEvent({ provider, paymentId = null, kind, verified = false, outcome, detail = "", payload = {} }) {
    try {
      await db.insertInto("payment_events").values({
        id: publicId("pevt"),
        provider,
        payment_id: paymentId,
        kind,
        verified,
        outcome,
        detail: String(detail || "").slice(0, 500),
        payload: JSON.stringify(payload || {}),
      }).execute();
    } catch (err) {
      log.warn("payment event not recorded: %s", err?.message || err);
    }
  }

  /** Grant + ledger for a paid order, inside the caller's transaction. */
  async function fulfil(trx, order, { paymentId, providerOrderId, provider }) {
    const product = await trx.selectFrom("products").selectAll().where("id", "=", order.product_id).executeTakeFirst();
    if (!product) throw Object.assign(new Error("PRODUCT_NOT_FOUND"), { code: "PRODUCT_NOT_FOUND" });
    const grant = createGrantFromPaidOrder({ userId: order.user_id, orderId: order.id, product, now: now() });
    await trx.updateTable("orders").set({
      status: "paid",
      paid_at: now(),
      closed_at: null,
      payment_id: paymentId || null,
      provider_order_id: providerOrderId || order.provider_order_id || null,
      updated_at: now(),
    }).where("id", "=", order.id).execute();
    await trx.insertInto("wallet_grants").values(grant).execute();
    await trx.insertInto("wallet_ledger").values({
      id: publicId("ledger"),
      user_id: order.user_id,
      grant_id: grant.id,
      event_type: "grant",
      resource_type: grant.resource_type,
      token_delta: grant.resource_type === "token" ? grant.unit_total : 0,
      unit_delta: grant.unit_total,
      money_delta_cents: order.amount_cents,
      source_type: "order",
      source_id: order.id,
      // One fulfilment per order, enforced by the database, whatever races.
      idempotency_key: `order_paid:${order.id}`,
      metadata: JSON.stringify({ productId: product.id, provider, paymentId: paymentId || null }),
    }).execute();
    return grant;
  }

  /**
   * Settle a provider-confirmed result (verified notification or query).
   * @returns {Promise<{outcome: string, orderId?: string, refundId?: string}>}
   *   settled | duplicate | double_paid | closed | pending | unknown_payment | rejected
   */
  async function settle(provider, result, payment) {
    const expected = effectiveProviderConfig(provider, payment);
    const settled = await db.transaction().execute(async (trx) => {
      const pay = await trx.selectFrom("payments").selectAll().where("id", "=", result.outTradeNo).forUpdate().executeTakeFirst();
      if (!pay) return { outcome: "unknown_payment" };
      if (pay.provider !== provider) return { outcome: "rejected", detail: "provider mismatch" };

      if (result.status === "closed") {
        if (pay.status === "pending") {
          await trx.updateTable("payments").set({ status: "closed", closed_at: now(), updated_at: now() }).where("id", "=", pay.id).execute();
        }
        return { outcome: "closed", orderId: pay.order_id };
      }
      if (result.status !== "succeeded") {
        await trx.updateTable("payments").set({ last_synced_at: now() }).where("id", "=", pay.id).execute();
        return { outcome: "pending", orderId: pay.order_id };
      }

      // Paid — but only if it is OUR merchant, OUR app, and the right amount.
      if (result.amountCents !== pay.amount_cents) return { outcome: "rejected", detail: `amount ${result.amountCents} != ${pay.amount_cents}` };
      if (String(result.currency || "CNY") !== String(pay.currency || "CNY")) return { outcome: "rejected", detail: "currency mismatch" };
      if (result.appId && expected.appId && result.appId !== expected.appId) return { outcome: "rejected", detail: "app id mismatch" };
      const merchant = provider === "wechat" ? expected.mchId : expected.merchantId;
      if (result.merchantId && merchant && result.merchantId !== merchant) return { outcome: "rejected", detail: "merchant mismatch" };

      if (pay.status === "succeeded") return { outcome: "duplicate", orderId: pay.order_id };
      await trx.updateTable("payments").set({
        status: "succeeded",
        provider_trade_no: result.providerTradeNo || null,
        succeeded_at: paidTime(result.paidAt),
        last_synced_at: now(),
        updated_at: now(),
      }).where("id", "=", pay.id).execute();

      const order = await trx.selectFrom("orders").selectAll().where("id", "=", pay.order_id).forUpdate().executeTakeFirst();
      // A payment after the order expired still delivers: the buyer paid.
      if (order.status === "pending" || order.status === "closed") {
        await fulfil(trx, order, { paymentId: pay.id, providerOrderId: result.providerTradeNo, provider });
        return { outcome: "settled", orderId: order.id };
      }
      // Paid twice (two attempts both completed): the second is given back.
      const refundId = publicId("rfd");
      await trx.insertInto("refunds").values({
        id: refundId,
        order_id: order.id,
        payment_id: pay.id,
        user_id: order.user_id,
        amount_cents: pay.amount_cents,
        reason: "重复支付自动退款",
        status: "pending",
        actor: "system",
      }).execute();
      return { outcome: "double_paid", orderId: order.id, refundId };
    });

    if (settled.outcome === "settled") await closeOtherAttempts(settled.orderId, result.outTradeNo, payment);
    if (settled.outcome === "double_paid") await executeRefund(settled.refundId, payment);
    return settled;
  }

  /** The order is paid: the other open attempts will never be — close them at the provider. */
  async function closeOtherAttempts(orderId, paidPaymentId, payment) {
    const open = await db.selectFrom("payments").selectAll().where("order_id", "=", orderId).where("status", "=", "pending").where("id", "!=", paidPaymentId).execute();
    for (const pay of open) {
      try {
        const res = await gatewayFor(pay.provider, payment).close(pay.id);
        if (res.ok) await db.updateTable("payments").set({ status: "closed", closed_at: now(), updated_at: now() }).where("id", "=", pay.id).where("status", "=", "pending").execute();
      } catch { /* the sweeper retries */ }
    }
  }

  async function syncPayment(pay, payment, { source = "query" } = {}) {
    let res;
    try {
      res = await gatewayFor(pay.provider, payment).query(pay.id);
    } catch (err) {
      res = { ok: false, code: err?.code || "QUERY_FAILED", detail: err?.message };
    }
    if (!res.ok) {
      await recordEvent({ provider: pay.provider, paymentId: pay.id, kind: source, outcome: "error", detail: `${res.code} ${res.detail || ""}` });
      await db.updateTable("payments").set({ last_synced_at: now() }).where("id", "=", pay.id).execute();
      return { outcome: "error", code: res.code };
    }
    if (res.result.status === "not_found") {
      await db.updateTable("payments").set({ last_synced_at: now() }).where("id", "=", pay.id).execute();
      return { outcome: "pending" };
    }
    const settled = await settle(pay.provider, { ...res.result, outTradeNo: pay.id }, payment);
    await recordEvent({ provider: pay.provider, paymentId: pay.id, kind: source, verified: true, outcome: settled.outcome, detail: settled.detail, payload: res.result.raw });
    return settled;
  }

  async function executeRefund(refundId, payment) {
    const refund = await db.selectFrom("refunds").selectAll().where("id", "=", refundId).executeTakeFirst();
    if (!refund || refund.status !== "pending") return { ok: false, code: "REFUND_NOT_PENDING" };
    const pay = await db.selectFrom("payments").selectAll().where("id", "=", refund.payment_id).executeTakeFirst();
    let res;
    try {
      res = await gatewayFor(pay.provider, payment).refund({
        outTradeNo: pay.id,
        outRequestNo: refund.id,
        amountCents: refund.amount_cents,
        totalCents: pay.amount_cents,
        reason: refund.reason,
      });
    } catch (err) {
      res = { ok: false, code: err?.code || "REFUND_FAILED", detail: err?.message };
    }
    await recordEvent({ provider: pay.provider, paymentId: pay.id, kind: "refund", verified: Boolean(res.ok), outcome: res.ok ? res.status : "error", detail: res.ok ? refund.id : `${res.code} ${res.detail || ""}`, payload: { refundId: refund.id, amountCents: refund.amount_cents } });
    if (!res.ok) {
      await db.updateTable("refunds").set({ status: "failed", error: String(res.code || "").slice(0, 200), updated_at: now() }).where("id", "=", refund.id).execute();
      return { ok: false, code: res.code };
    }
    if (res.status === "pending") return { ok: true, status: "pending" }; // confirmed later by the sweeper
    await applyRefund(refund.id, res.providerRefundNo);
    return { ok: true, status: "succeeded" };
  }

  /** The provider confirmed the refund: take the credit back and book it. */
  async function applyRefund(refundId, providerRefundNo = "") {
    return db.transaction().execute(async (trx) => {
      const refund = await trx.selectFrom("refunds").selectAll().where("id", "=", refundId).forUpdate().executeTakeFirst();
      if (!refund || refund.status === "succeeded") return;
      const order = await trx.selectFrom("orders").selectAll().where("id", "=", refund.order_id).forUpdate().executeTakeFirst();
      await trx.updateTable("refunds").set({ status: "succeeded", provider_refund_no: providerRefundNo || null, succeeded_at: now(), updated_at: now() }).where("id", "=", refund.id).execute();
      const isDuplicate = order.payment_id && order.payment_id !== refund.payment_id;
      if (isDuplicate) {
        // Giving back a second payment of the same order: the credit stays.
        await trx.insertInto("wallet_ledger").values({
          id: publicId("ledger"),
          user_id: order.user_id,
          event_type: "refund",
          money_delta_cents: -refund.amount_cents,
          source_type: "refund",
          source_id: refund.id,
          idempotency_key: `refund:${refund.id}`,
          metadata: JSON.stringify({ orderId: order.id, duplicatePayment: true }),
        }).execute();
        return;
      }
      const refunded = Number(order.refunded_cents || 0) + refund.amount_cents;
      await trx.updateTable("orders").set({
        refunded_cents: refunded,
        status: refunded >= order.amount_cents ? "refunded" : "partially_refunded",
        updated_at: now(),
      }).where("id", "=", order.id).execute();
      // Take back the unused credit in proportion to the money returned.
      const grant = await trx.selectFrom("wallet_grants").selectAll().where("source_type", "=", "order").where("source_id", "=", order.id).forUpdate().executeTakeFirst();
      let units = 0;
      if (grant) {
        const share = Math.ceil(Number(grant.unit_total || 0) * refund.amount_cents / Math.max(1, order.amount_cents));
        units = Math.min(Number(grant.unit_remaining || 0), share);
        const full = refunded >= order.amount_cents;
        await trx.updateTable("wallet_grants").set((eb) => ({
          unit_remaining: eb("unit_remaining", "-", units),
          ...(grant.resource_type === "token" ? { token_remaining: eb("token_remaining", "-", units) } : {}),
          ...(full ? { status: "revoked" } : {}),
        })).where("id", "=", grant.id).execute();
      }
      await trx.insertInto("wallet_ledger").values({
        id: publicId("ledger"),
        user_id: order.user_id,
        grant_id: grant?.id || null,
        event_type: "refund",
        resource_type: grant?.resource_type || null,
        token_delta: grant?.resource_type === "token" ? -units : 0,
        unit_delta: -units,
        money_delta_cents: -refund.amount_cents,
        source_type: "refund",
        source_id: refund.id,
        idempotency_key: `refund:${refund.id}`,
        metadata: JSON.stringify({ orderId: order.id }),
      }).execute();
    });
  }

  return { recordEvent, fulfil, settle, syncPayment, executeRefund, applyRefund };
}
