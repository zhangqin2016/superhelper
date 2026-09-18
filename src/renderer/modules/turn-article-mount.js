/**
 * One turn, one article. The single place an assistant turn enters the
 * conversation list.
 *
 * This is an invariant, not a decision. Before it, two independent paths put
 * articles in the list — `ensureLiveArticle` reused one per turnId through a
 * Map, while the committed path built a fresh article with
 * `createElement("article")` and appended it without ever looking at what was
 * already mounted. Whether the resulting pair collapsed depended on a separate
 * heuristic elsewhere deciding to remove the live one. When that heuristic said
 * anything else — or when the committed path simply ran twice (a re-render, a
 * pagination pass, a projection update) — the same turn stood in the list more
 * than once, each copy frozen at the moment it was built.
 *
 * That is what a user saw as an answer that had already ended still growing
 * extra blocks: three cards for one turn, the same to-do list at three
 * different stages. It vanished on restart because a reload builds exactly one
 * article per stored record — proof the duplicates were never in the data.
 *
 * Fixing that per-path is patching; the classes of producer are open-ended.
 * Here identity decides instead: an article carrying a turn id replaces the one
 * already standing for that turn, in place, so position is kept and no
 * producer can add a second.
 *
 * Precedence: a committed ("sealed") article outranks a live one. A sealed
 * article replaces a live one; a live shell is never mounted over a sealed
 * card, because the committed record is the finished answer and the live shell
 * would be a strictly emptier view of the same turn.
 *
 * Deliberately narrow: an article without a turn id — a notice, a scheduled
 * draft, a binding card — has no identity to reconcile and keeps the plain
 * append/insert behaviour. Reconciliation is also scoped to direct children of
 * one session's list, so two sessions showing the same turn never interfere.
 */

/** The article already standing for this turn, if any. */
function findMountedTurn(listEl, turnId, exclude) {
  if (!turnId) return null;
  // A scan rather than a selector: turn ids come from the engine and must never
  // need CSS escaping to be matched correctly.
  for (const child of listEl.children || []) {
    if (child === exclude) continue;
    if (child?.dataset?.turnId === turnId) return child;
  }
  return null;
}

function isSealed(article) {
  return Boolean(article?.classList?.contains("is-sealed"));
}

/**
 * @param {Element} listEl the session's conversation list
 * @param {Element} article the article to mount
 * @param {{ kind?: "live"|"sealed", beforeNode?: Node|null, liveArticles?: Map }} options
 * @returns {Element|null} the mounted article, or null when a live shell was
 *   refused because the committed card for that turn is already standing.
 */
export function mountTurnArticle(listEl, article, options = {}) {
  if (!listEl || !article) return null;
  const { kind = "sealed", beforeNode = null, liveArticles = null } = options;
  const turnId = article.dataset?.turnId || "";
  const existing = findMountedTurn(listEl, turnId, article);

  if (existing) {
    if (kind === "live" && isSealed(existing)) return null;
    listEl.replaceChild(article, existing);
    if (liveArticles?.get(turnId) === existing) liveArticles.delete(turnId);
    return article;
  }
  if (article.parentNode === listEl) return article;

  if (beforeNode && listEl.contains?.(beforeNode)) listEl.insertBefore(article, beforeNode);
  else listEl.appendChild(article);
  return article;
}

/**
 * The live-article set may only hold turns that are still live.
 *
 * `runtime.liveTurn` is a single slot, so at most one turn per session is live
 * at a time — yet the map that tracks live articles had no rule saying so, and
 * the only cleanup ran against whichever turn happened to occupy that slot when
 * a render pass fired. The real event order leaves no room for it:
 *
 *   assistant.final (turn A) → turn.completed (A) → user.committed (B)
 *   → turn.started (B), which overwrites the slot
 *
 * Miss that window and A's live article is orphaned in the DOM with nothing
 * left that will ever look at it again — standing under the NEXT user message,
 * because the new bubble is inserted before whatever article held the slot. It
 * survives until a reload, which is why quitting made it disappear.
 *
 * The test is one thing only: is a committed card for this same turn already
 * in the list? Whether the turn still holds the live slot is irrelevant — the
 * duplicate is just as visible at the moment a turn ENDS, when the committed
 * card lands while the live article is still the current one. And a running
 * turn has no committed card by definition, so this can never take down an
 * article that is still doing its job.
 *
 * Removal is therefore only ever a de-duplication: a turn whose live article is
 * its only copy is kept, answer intact, even though it is no longer live. A
 * duplicate is a display bug; a disappearing answer is a lost one.
 * [gate: one-turn-one-article]
 *
 * @returns {number} how many stale articles were dropped
 */
export function reconcileLiveArticles(listEl, liveArticles) {
  if (!listEl || !liveArticles?.forEach) return 0;
  let dropped = 0;
  for (const [turnId, article] of [...liveArticles]) {
    if (!article?.isConnected) { liveArticles.delete(turnId); continue; }
    const committed = findMountedTurn(listEl, turnId, article);
    if (!committed || !isSealed(committed)) continue; // its only copy — keep it
    article.remove();
    liveArticles.delete(turnId);
    dropped += 1;
  }
  return dropped;
}

export { findMountedTurn };
