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
 * Precedence: any committed representation of a turn outranks the live shell.
 * A committed article replaces a live one; a live shell is never mounted over a
 * committed card, because the stored record is the finished answer and the
 * shell would be a strictly emptier view of the same turn. "Committed" is
 * simply "not live" — a scheduled-draft card stands for its turn just as a
 * sealed answer does, and neither should have to be listed here by name.
 *
 * Deliberately narrow: an article without a turn id — a notice, a scheduled
 * draft, a binding card — has no identity to reconcile and keeps the plain
 * append/insert behaviour. Reconciliation is also scoped to direct children of
 * one session's list, so two sessions showing the same turn never interfere.
 */

const TURN_ARTICLE_CLASS = "assistant-turn-article";

/**
 * A turn id alone is NOT identity here.
 *
 * The user's own message carries the same turn id — it is stamped on the bubble
 * so the minimap can find the prompt — so matching on the id alone makes a
 * turn's question and its answer look like the same object. Measured
 * consequence: the answer's card replaces the question, or the live shell is
 * refused because "something for this turn is already there" and no assistant
 * card renders at all. Identity is (turn id AND this is a turn article).
 */
function isTurnArticle(node) {
  return Boolean(node?.classList?.contains(TURN_ARTICLE_CLASS));
}

/** The turn article already standing for this turn, if any. */
function findMountedTurn(listEl, turnId, exclude) {
  if (!turnId) return null;
  // A scan rather than a selector: turn ids come from the engine and must never
  // need CSS escaping to be matched correctly.
  for (const child of listEl.children || []) {
    if (child === exclude || !isTurnArticle(child)) continue;
    if (child?.dataset?.turnId === turnId) return child;
  }
  return null;
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
    if (isTurnArticle(child) && child.dataset?.turnId === turnId && isLive(child)) return child;
  }
  return null;
}

/** Whether any turn is still rendering live in this list. */
export function hasLiveArticle(listEl) {
  if (!listEl) return false;
  for (const child of listEl.children || []) {
    if (isTurnArticle(child) && isLive(child) && child.isConnected) return true;
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
    if (kind === "live" && !isLive(existing)) return null;
    listEl.replaceChild(article, existing);
    return article;
  }
  if (article.parentNode === listEl) return article;

  if (beforeNode && listEl.contains?.(beforeNode)) listEl.insertBefore(article, beforeNode);
  else listEl.appendChild(article);
  return article;
}

export { findMountedTurn };
