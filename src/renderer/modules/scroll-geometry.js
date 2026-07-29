/** DOM-free scroll geometry helpers (pure — testable without a browser). */

export const OLDER_LOAD_TOP_THRESHOLD = 80;

/**
 * Whether a scroll event near the top should load older history. Requires the
 * panel to ACTUALLY be scrollable: when the conversation fits the viewport
 * scrollTop is pinned at ~0 (top == bottom), so a programmatic scroll-to-bottom
 * during streaming would otherwise spuriously trigger a history load that yanks
 * the view to the very top. Only a genuine user scroll-up in an overflowing
 * panel loads more.
 * @param {{ scrollHeight:number, clientHeight:number, scrollTop:number } | null} panel
 */
export function shouldLoadOlderOnScroll(panel) {
  if (!panel) return false;
  const overflow = panel.scrollHeight - panel.clientHeight;
  if (overflow <= OLDER_LOAD_TOP_THRESHOLD) return false;
  return panel.scrollTop <= OLDER_LOAD_TOP_THRESHOLD;
}

export function normalizeWheelDelta(input = {}) {
  const deltaY = Number(input.deltaY || 0);
  const mode = Number(input.deltaMode || 0);
  const rootHeight = Number(input.rootHeight || 0);
  if (mode === 1) return deltaY * 40;
  if (mode === 2) return deltaY * rootHeight;
  return deltaY;
}

export function shouldMarkBoundaryGesture(input = {}) {
  const delta = Number(input.delta || 0);
  const scrollTop = Number(input.scrollTop || 0);
  const scrollHeight = Number(input.scrollHeight || 0);
  const clientHeight = Number(input.clientHeight || 0);
  const max = scrollHeight - clientHeight;
  if (max <= 1) return true;
  if (!delta) return false;
  if (delta < 0) return scrollTop + delta <= 0;
  return delta > max - scrollTop;
}

export function revealScrollIntent(input = {}) {
  const savedScrollTop = Number.isFinite(input.savedScrollTop) ? input.savedScrollTop : null;
  if (input.hasRenderedContent && savedScrollTop !== null) {
    return { mode: "restore", scrollTop: Math.max(0, savedScrollTop) };
  }
  return { mode: "bottom" };
}

export function nextAutoFollowDetachedState(input = {}) {
  const previousDetached = Boolean(input.previousDetached);
  const hasUserScrollIntent = Boolean(input.hasUserScrollIntent);
  const upwardUserScrollIntent = Boolean(input.upwardUserScrollIntent);
  const programmaticScroll = Boolean(input.programmaticScroll);
  const userScrolledUp = Boolean(input.userScrolledUp);
  const nearBottom = Boolean(input.nearBottom);

  if (upwardUserScrollIntent) return true;
  if (hasUserScrollIntent) return userScrolledUp || !nearBottom;
  if (programmaticScroll) return nearBottom ? false : previousDetached;
  return previousDetached;
}

/**
 * A delayed auto-follow request must yield to navigation that happened after it
 * was scheduled. This keeps queued layout callbacks from undoing the user's
 * first upward wheel/touch gesture while a live answer is still rendering.
 */
export function shouldRunScheduledAutoFollow(input = {}) {
  const scheduledVersion = Number(input.scheduledNavigationVersion || 0);
  const currentVersion = Number(input.currentNavigationVersion || 0);
  if (scheduledVersion !== currentVersion) return false;
  if (input.hasUserScrollIntent) return false;
  if (!input.detachedAtSchedule && input.detachedNow) return false;
  return true;
}

export function elementScrollTargetTop(input = {}) {
  const panelTop = Number(input?.panelTop || 0);
  const elementTop = Number(input?.elementTop || 0);
  const scrollTop = Number(input?.scrollTop || 0);
  const scrollHeight = Number(input?.scrollHeight || 0);
  const clientHeight = Number(input?.clientHeight || 0);
  const maxTop = Math.max(0, scrollHeight - clientHeight);
  const targetTop = Math.max(0, elementTop - panelTop + scrollTop - 12);
  return Math.min(targetTop, maxTop);
}
