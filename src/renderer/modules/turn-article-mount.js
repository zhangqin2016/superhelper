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

function isLive(article) {
  return Boolean(article?.classList?.contains("is-live"));
}

/**
 * The live article for a turn, read from the list itself.
 *
 * There is deliberately no second index of these. A Map of live articles kept
 * beside the DOM is a copy of state the DOM already holds, and the two drift:
 * the reported empty cards were exactly that drift — entries that outlived the
 * node they described, or nodes no entry pointed at any more. `is-live` and
 * `is-sealed` are toggled from the view model on every render, so the list is
 * both the display and the record of what is live.
 */
export function findLiveArticle(listEl, turnId) {
  if (!listEl || !turnId) return null;
  for (const child of listEl.children || []) {
    if (child?.dataset?.turnId === turnId && isLive(child)) return child;
  }
  return null;
}

/** Whether any turn is still rendering live in this list. */
export function hasLiveArticle(listEl) {
  if (!listEl) return false;
  for (const child of listEl.children || []) {
    if (isLive(child) && child.isConnected) return true;
  }
  return false;
}

/**
 * @param {Element} listEl the session's conversation list
 * @param {Element} article the article to mount
 * @param {{ kind?: "live"|"sealed", beforeNode?: Node|null }} options
 * @returns {Element|null} the mounted article, or null when a live shell was
 *   refused because the committed card for that turn is already standing.
 */
export function mountTurnArticle(listEl, article, options = {}) {
  if (!listEl || !article) return null;
  const { kind = "sealed", beforeNode = null } = options;
  const turnId = article.dataset?.turnId || "";
  const existing = findMountedTurn(listEl, turnId, article);

  if (existing) {
    if (kind === "live" && isSealed(existing)) return null;
    listEl.replaceChild(article, existing);
    return article;
  }
  if (article.parentNode === listEl) return article;

  if (beforeNode && listEl.contains?.(beforeNode)) listEl.insertBefore(article, beforeNode);
  else listEl.appendChild(article);
  return article;
}

/**
 * A live article is only ever a duplicate once the same turn has a committed
 * card in the list.
 *
 * `runtime.liveTurn` is a single slot, and the old cleanup ran against whichever
 * turn happened to occupy it when a render pass fired. The real event order
 * leaves no room for that:
 *
 *   assistant.final (A) → turn.completed (A) → user.committed (B)
 *   → turn.started (B), which overwrites the slot
 *
 * Miss the window and A's live article is orphaned with nothing left that will
 * ever look at it again — standing under the NEXT user message, because a new
 * bubble is inserted before whatever article holds the slot. The same gap shows
 * at the END of a turn, when the committed card lands while the live article is
 * still the current one. Both disappeared on restart, because a reload builds no
 * live articles at all.
 *
 * So the test is one thing, independent of the slot and of any bookkeeping: is a
 * committed card for this same turn already in the list? A running turn has no
 * committed card by definition, so this can only ever de-duplicate — never take
 * down an article still doing its job, and never make an answer disappear when
 * the live article is its only copy. A duplicate is a display bug; a
 * disappearing answer is a lost one. [gate: one-turn-one-article]
 *
 * @returns {number} how many duplicate live articles were dropped
 */
export function reconcileLiveArticles(listEl) {
  if (!listEl?.children) return 0;
  let dropped = 0;
  for (const article of [...listEl.children]) {
    if (!isLive(article)) continue;
    const turnId = article.dataset?.turnId || "";
    if (!turnId) continue;
    const committed = findMountedTurn(listEl, turnId, article);
    if (!committed || !isSealed(committed)) continue; // its only copy — keep it
    article.remove();
    dropped += 1;
  }
  return dropped;
}

export { findMountedTurn };
