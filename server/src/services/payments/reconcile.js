// Reconciliation: a provider's daily statement against our books.
//
// The statement is a signed truth source too: a trade the provider says was
// paid that we never settled (a lost notification) is settled now, through the
// same settlement path; everything else that differs is reported, never
// silently "fixed". A statement's day is the provider's: payments are booked
// at the provider's payment time, so trades around midnight line up.

import { publicId } from "../ids.js";

export function createReconciler({ db, loadConfig, gatewayFor, now, settlement }) {
  const { syncPayment } = settlement;

  /**
   * Compare a day's provider statement with our books. Anything the provider
   * says was paid that we have not settled is settled now (the statement is
   * a signed truth source too); the rest is reported.
   * @param {string} billDate "YYYY-MM-DD" (Beijing)
   */
  async function reconcile(provider, billDate) {
    const payment = await loadConfig();
    const bill = await gatewayFor(provider, payment).downloadBill(billDate);
    if (!bill.ok) {
      await upsertRun(provider, billDate, "failed", { error: bill.code, detail: bill.detail || "" });
      return { ok: false, code: bill.code };
    }
    const start = new Date(`${billDate}T00:00:00+08:00`);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const ours = await db.selectFrom("payments").select(["id", "amount_cents", "status", "provider_trade_no"])
      .where("provider", "=", provider).where("succeeded_at", ">=", start).where("succeeded_at", "<", end).execute();
    if (bill.noStatement && ours.length) {
      // We took money that day, so an absent statement is one not generated yet.
      await upsertRun(provider, billDate, "failed", { error: "BILL_NOT_READY" });
      return { ok: false, code: "BILL_NOT_READY" };
    }
    const oursById = new Map(ours.map((p) => [p.id, p]));
    const theirPayments = bill.rows.filter((r) => r.kind === "payment");
    const mismatches = [];
    let healed = 0;
    for (const row of theirPayments) {
      const mine = oursById.get(row.outTradeNo);
      if (mine) {
        if (mine.amount_cents !== row.amountCents) mismatches.push({ type: "amount_mismatch", outTradeNo: row.outTradeNo, ours: mine.amount_cents, theirs: row.amountCents });
        oursById.delete(row.outTradeNo);
        continue;
      }
      const pay = await db.selectFrom("payments").selectAll().where("id", "=", row.outTradeNo).executeTakeFirst();
      if (!pay) { mismatches.push({ type: "unknown_trade", outTradeNo: row.outTradeNo, theirs: row.amountCents }); continue; }
      if (pay.status === "succeeded") {
        // Settled here with a time on the other side of midnight (a payment
        // settled before the provider's time was known): the same trade.
        if (pay.amount_cents !== row.amountCents) mismatches.push({ type: "amount_mismatch", outTradeNo: row.outTradeNo, ours: pay.amount_cents, theirs: row.amountCents });
        continue;
      }
      // Paid at the provider, not settled here: a lost notification. Heal it.
      const r = await syncPayment(pay, payment, { source: "reconcile" });
      if (r.outcome === "settled" || r.outcome === "duplicate") healed += 1;
      else mismatches.push({ type: "unsettled_payment", outTradeNo: row.outTradeNo, theirs: row.amountCents, outcome: r.outcome });
    }
    for (const [id, mine] of oursById) mismatches.push({ type: "missing_at_provider", outTradeNo: id, ours: mine.amount_cents });
    const summary = { providerPayments: theirPayments.length, ourPayments: ours.length, healed, mismatches };
    await upsertRun(provider, billDate, mismatches.length ? "mismatched" : "matched", summary);
    return { ok: true, status: mismatches.length ? "mismatched" : "matched", ...summary };
  }

  async function upsertRun(provider, billDate, status, summary) {
    await db.insertInto("reconciliation_runs").values({ id: publicId("recon"), provider, bill_date: billDate, status, summary: JSON.stringify(summary) })
      .onConflict((oc) => oc.columns(["provider", "bill_date"]).doUpdateSet({ status, summary: JSON.stringify(summary), created_at: now() }))
      .execute();
  }

  return { reconcile };
}
