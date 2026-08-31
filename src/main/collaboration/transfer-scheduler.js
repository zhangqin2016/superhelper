"use strict";

const MAX_ATTEMPTS = 3;
const CONCURRENCY = 2;
const terminal = (state) => ["verified", "bound", "ready", "cancelled"].includes(state);
const fail = (code) => Object.assign(new Error(code), { code, retryable: false });
const safeCode = (code) => typeof code === "string" && code.length <= 100 && /^(COLLAB[A-Z_]*|LILYENC_[A-Z_]+)$/.test(code) ? code : "COLLAB_TRANSFER_FAILED";

/** Scheduling is independent of the text outbox. Only an explicit enqueue
 * persists upload/download consent; finding a prepared file is not consent.
 * Each reserved attempt and deadline survives process restart. A single main
 * process owns this scheduler and its transfer manager for the active account.
 */
function createTransferScheduler({ manager, manifests, now = Date.now, onChange = () => {}, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  if (!manager || !manifests) throw new TypeError("Transfer scheduler dependencies are required.");
  let stopped = false, timer = null;
  const active = new Map();
  const emit = () => { if (!stopped) { try { onChange(); } catch { /* Observers cannot change durable work. */ } } };
  function readVisible(id) {
    if (stopped) throw fail("COLLABORATION_STOPPED");
    const view = manager.list().transfers.find((entry) => entry.id === id);
    if (!view) throw fail("COLLAB_ACCESS_REVOKED");
    if (view.code === "COLLAB_TRANSFER_DEVICE_CHANGED") throw fail(view.code);
    return manifests.read(id);
  }
  function schedule(item, value) {
    return manifests.update({ id: item.id, expectedRevision: item.revision, checkpoint: { ...item.checkpoint, schedule: value } });
  }
  async function run(id) {
    let reserved;
    try {
      const item = readVisible(id), previous = item.checkpoint.schedule;
      if (!previous?.enabled || terminal(item.checkpoint.state) || previous.nextAttemptAt > now() || previous.attempts >= MAX_ATTEMPTS) return;
      const attempts = previous.attempts + 1, delay = 1000 * 2 ** (attempts - 1);
      reserved = schedule(item, { enabled: true, attempts, nextAttemptAt: now() + delay });
      emit();
      const beforeDispatch = readVisible(id);
      if (beforeDispatch.revision !== reserved.revision || !beforeDispatch.checkpoint.schedule.enabled) return;
      const result = await (item.direction === "upload" ? manager.resumeUpload(id) : manager.resumeDownload(id));
      const current = readVisible(id);
      // Pause/cancel or another user decision must win over this late result.
      if (!current.checkpoint.schedule?.enabled || current.checkpoint.state === "cancelled") return;
      const complete = result?.ok === true && terminal(result.state);
      const retryable = result?.retryable === true && attempts < MAX_ATTEMPTS;
      schedule(current, { enabled: !complete && retryable, attempts, nextAttemptAt: now() + delay,
        ...(!complete ? { code: safeCode(result?.code) } : {}) });
      emit();
    } catch (error) {
      // No raw transport errors, metadata or old-account progress escape.
      if (!reserved || stopped) return;
      try {
        const current = readVisible(id);
        if (current.checkpoint.schedule?.enabled) schedule(current, { ...current.checkpoint.schedule, enabled: false, code: safeCode(error.code) });
        emit();
      } catch { /* Current authorization/ownership could no longer be proven. */ }
    }
  }
  async function tick() {
    if (stopped) return { ok: false, code: "COLLABORATION_STOPPED" };
    try {
      for (const view of manager.list().transfers) {
        if (active.size >= CONCURRENCY) break;
        if (active.has(view.id) || terminal(view.state) || view.code === "COLLAB_TRANSFER_DEVICE_CHANGED") continue;
        const item = readVisible(view.id), s = item.checkpoint.schedule;
        if (!s?.enabled || s.nextAttemptAt > now()) continue;
        if (s.attempts >= MAX_ATTEMPTS) {
          schedule(item, { ...s, enabled: false, code: "COLLAB_TRANSFER_RETRY_LIMIT" }); emit(); continue;
        }
        const task = Promise.resolve().then(() => run(view.id)).finally(() => active.delete(view.id));
        active.set(view.id, task);
      }
      await Promise.all([...active.values()]);
      return stopped ? { ok: false, code: "COLLABORATION_STOPPED" } : { ok: true };
    } catch { return { ok: false, code: "COLLAB_TRANSFER_UNAVAILABLE" }; }
  }
  return Object.freeze({
    tick,
    start() {
      if (stopped || timer !== null) return;
      timer = setIntervalImpl(() => { void tick(); }, 1000); timer?.unref?.();
      void tick();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearIntervalImpl(timer);
      timer = null; manager.stop();
    },
    enqueue(id) {
      const item = readVisible(id);
      if (terminal(item.checkpoint.state)) return { ok: true, id, state: item.checkpoint.state };
      if (active.has(id) || item.checkpoint.schedule?.enabled) return { ok: true, id, state: item.checkpoint.state };
      if (item.direction === "upload" && !item.checkpoint.content) throw fail("COLLAB_TRANSFER_NOT_READY");
      schedule(item, { enabled: true, attempts: 0, nextAttemptAt: now() });
      emit(); queueMicrotask(() => { void tick(); });
      return { ok: true, id, state: "queued" };
    },
    pause(id) {
      const item = readVisible(id);
      if (terminal(item.checkpoint.state)) return { ok: true, id, state: item.checkpoint.state };
      // The manager persists paused + disabled together before its local fence.
      manager.pause(id);
      emit(); return { ok: true, id, state: "paused" };
    },
    async cancel(id) {
      readVisible(id);
      const result = await manager.cancel(id);
      if (stopped) return { ok: false, code: "COLLABORATION_STOPPED" };
      // Manager guards late abort responses and never aborts a download object.
      emit(); return result;
    },
    list() {
      if (stopped) return { transfers: [] };
      const result = manager.list();
      return { ...result, transfers: result.transfers.map((view) => {
        if (view.code === "COLLAB_TRANSFER_DEVICE_CHANGED") return view;
        const s = manifests.read(view.id).checkpoint.schedule;
        return { ...view, ...(s ? { automaticRetry: s.enabled && !terminal(view.state), attempts: s.attempts, nextAttemptAt: s.nextAttemptAt, ...(s.code ? { code: s.code } : {}) } : {}) };
      }) };
    },
  });
}

module.exports = { createTransferScheduler };
