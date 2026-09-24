// After the buyer leaves for the web checkout, notice the purchase arriving.
//
// Paying happens in the browser; the desktop only learns of it by asking. So
// once the billing page is opened we ask again — quietly — whenever the window
// comes back to the front, and on a slow timer while it stays there, until
// something a purchase adds shows up or the watch runs out. A watch never
// shows errors: a failed ask is just "not yet"; the manual refresh remains.

const WATCH_MS = 30 * 60_000;
const POLL_MS = 45_000;
const MIN_GAP_MS = 10_000;

const COUNTS = ["tokenBalance", "imageGenerationsRemaining", "videoGenerationsRemaining"];

/**
 * Whether `after` holds something a purchase would add over `before`: more of
 * a resource, or membership running later. Going down is just usage — the
 * buyer may keep working while they pay — so only a rise counts.
 */
export function purchaseArrived(before, after) {
  if (!after) return false;
  if (COUNTS.some((key) => Number(after[key] || 0) > Number(before?.[key] || 0))) return true;
  const until = (e) => Date.parse(e?.membershipExpiresAt || "") || 0;
  return until(after) > until(before);
}

/**
 * @param {{
 *   fetchEntitlements: () => Promise<{ ok: boolean, entitlements?: unknown }>,
 *   onArrived: (entitlements: unknown) => void,
 *   target?: { addEventListener: Function, removeEventListener: Function },
 *   doc?: { visibilityState: string, addEventListener: Function, removeEventListener: Function },
 *   now?: () => number,
 *   setTimer?: typeof setInterval,
 *   clearTimer?: typeof clearInterval,
 * }} deps
 */
export function createPurchaseWatch({
  fetchEntitlements,
  onArrived,
  target = globalThis.window,
  doc = globalThis.document,
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (id) => clearInterval(id),
}) {
  let active = null; // { baseline, until, lastAsk, timer }
  let asking = false;

  const visible = () => doc?.visibilityState !== "hidden";

  async function ask() {
    if (!active || asking || !visible()) return;
    if (now() > active.until) return stop();
    if (now() - active.lastAsk < MIN_GAP_MS) return;
    active.lastAsk = now();
    asking = true;
    let result = null;
    try {
      result = await fetchEntitlements();
    } catch {
      result = null;
    } finally {
      asking = false;
    }
    if (!active || !result?.ok) return;
    if (purchaseArrived(active.baseline, result.entitlements)) {
      stop();
      onArrived(result.entitlements);
      return;
    }
    // Usage meanwhile lowers the bar, so a purchase shows up as a rise.
    active.baseline = result.entitlements ?? active.baseline;
  }

  const onFront = () => void ask();

  function stop() {
    if (!active) return;
    clearTimer(active.timer);
    target?.removeEventListener?.("focus", onFront);
    doc?.removeEventListener?.("visibilitychange", onFront);
    active = null;
  }

  return {
    /**
     * Begin (or restart) watching. `shownEntitlements` is the fallback
     * baseline; a fresh read replaces it, so a stale cache cannot pass for
     * a purchase.
     */
    start(shownEntitlements) {
      stop();
      const watch = {
        baseline: shownEntitlements ?? null,
        until: now() + WATCH_MS,
        // The buyer is still on the way to the checkout: no point asking yet.
        lastAsk: now(),
        timer: setTimer(onFront, POLL_MS),
      };
      active = watch;
      target?.addEventListener?.("focus", onFront);
      doc?.addEventListener?.("visibilitychange", onFront);
      Promise.resolve()
        .then(() => fetchEntitlements())
        .then((fresh) => {
          // Read as the checkout opens — before anything could be paid.
          if (active === watch && fresh?.ok && fresh.entitlements) watch.baseline = fresh.entitlements;
        })
        .catch(() => {});
    },
    stop,
    get watching() {
      return Boolean(active);
    },
  };
}
