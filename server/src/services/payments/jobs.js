// Background work that closes the loop when a notification never arrives:
//   every minute   sweep — re-ask the provider about stale unpaid attempts,
//                  close expired orders, confirm refunds still processing
//   daily (10:00+ Beijing) reconcile yesterday's statement of every ready provider
// Overlapping runs are skipped; every step is idempotent anyway.

import { db as defaultDb } from "../../db.js";
import { getPaymentConfig } from "../app-settings.js";
import { readyProviders } from "./providers.js";
import { paymentService } from "./service.js";

/** Beijing calendar date `daysAgo` days before `now`, "YYYY-MM-DD". */
export function beijingDate(now = new Date(), daysAgo = 0) {
  return new Date(now.getTime() + 8 * 3600 * 1000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

export function startPaymentJobs({ log = console, service = paymentService(), db = defaultDb, sweepMs = 60_000, reconcileCheckMs = 60 * 60_000 } = {}) {
  let sweeping = false;
  let reconciling = false;

  const sweepTimer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const report = await service.sweep();
      if (report.synced || report.closed || report.refunds) log.info?.({ report }, "payment sweep");
    } catch (err) {
      log.warn?.({ err }, "payment sweep failed");
    } finally {
      sweeping = false;
    }
  }, sweepMs);
  sweepTimer.unref?.();

  const reconcileTimer = setInterval(async () => {
    if (reconciling) return;
    const now = new Date();
    // Providers publish yesterday's statement in the morning (Beijing).
    if (Number(new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 13)) < 10) return;
    reconciling = true;
    try {
      const billDate = beijingDate(now, 1);
      for (const provider of readyProviders(await getPaymentConfig())) {
        const done = await db.selectFrom("reconciliation_runs").select("id").where("provider", "=", provider).where("bill_date", "=", billDate).where("status", "!=", "failed").executeTakeFirst();
        if (done) continue;
        const result = await service.reconcile(provider, billDate);
        log.info?.({ provider, billDate, status: result.status || result.code }, "payment reconciliation");
      }
    } catch (err) {
      log.warn?.({ err }, "payment reconciliation failed");
    } finally {
      reconciling = false;
    }
  }, reconcileCheckMs);
  reconcileTimer.unref?.();

  return { stop() { clearInterval(sweepTimer); clearInterval(reconcileTimer); } };
}
