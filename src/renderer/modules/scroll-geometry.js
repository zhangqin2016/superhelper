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
