/** Visibility observations only; main owns durable retries and server read state. */
export function createVisibleRead(ctx) {
  let destroyed = false, scheduled = null, epoch = null;
  const observations = new Map();
  function observe() {
    if (destroyed || ctx.disposed || !ctx.policyEnabled || ctx.navigating || ctx.searchQuery
      || !ctx.activeConversationId || !ctx.directory?.profile?.userId
      || document.visibilityState !== 'visible' || !document.hasFocus()
      || document.querySelector('dialog[open]') || !ctx.timeline?.isConnected
      || ctx.timeline.closest('[hidden]')) return;
    const bounds = ctx.timeline.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    if (epoch !== ctx.readEpoch) { epoch = ctx.readEpoch; observations.clear(); }
    const conversationId = ctx.activeConversationId, observedEpoch = ctx.readEpoch;
    const key = `${ctx.directory.profile.userId}:${conversationId}`;
    let seq = 0;
    for (const row of ctx.timeline.querySelectorAll('[data-message-keys]')) {
      const rect = row.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= Math.max(0, bounds.top)
        || rect.top >= Math.min(window.innerHeight, bounds.bottom)
        || rect.right <= Math.max(0, bounds.left) || rect.left >= Math.min(window.innerWidth, bounds.right)) continue;
      for (const token of row.dataset.messageKeys.split(' ')) {
        if (!token.startsWith('seq:')) continue;
        const value = Number(token.slice(4));
        if (Number.isSafeInteger(value) && value > seq) seq = value;
      }
    }
    if (!seq || typeof window.assistantClient?.collaboration?.markRead !== 'function') return;
    const previous = observations.get(key);
    if (previous?.pending || previous?.seq === seq && (previous.ok || Date.now() < previous.retryAt)) return;
    const observation = { seq, pending: true, ok: false, retryAt: Date.now() + 5000 };
    observations.set(key, observation);
    // Call the existing positional preload API, never a local badge reset.
    Promise.resolve().then(() => {
      if (destroyed || ctx.disposed || ctx.readEpoch !== observedEpoch || observations.get(key) !== observation) return null;
      return window.assistantClient.collaboration.markRead(conversationId, seq);
    }).then(result => {
      observation.ok = result?.ok === true && Number.isSafeInteger(result.seq) && result.seq >= seq;
    }).catch(() => {}).finally(() => { observation.pending = false; });
  }
  function schedule() {
    if (destroyed || scheduled != null) return;
    scheduled = requestAnimationFrame(() => { scheduled = null; observe(); });
  }
  ctx.timeline?.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('focus', schedule);
  window.addEventListener('resize', schedule);
  document.addEventListener('visibilitychange', schedule);
  // Also covers a panel becoming visible without a history render and retries
  // when IPC failed before the durable checkpoint could be admitted.
  const timer = setInterval(observe, 1000);
  return { schedule, destroy() {
    destroyed = true; clearInterval(timer);
    if (scheduled != null) cancelAnimationFrame(scheduled);
    ctx.timeline?.removeEventListener('scroll', schedule);
    window.removeEventListener('focus', schedule);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('visibilitychange', schedule);
    observations.clear();
  } };
}
