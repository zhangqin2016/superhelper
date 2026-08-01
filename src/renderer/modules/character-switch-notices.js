/**
 * Character switch notices (Character Worlds Phase 2B, §8).
 *
 * A committed binding change becomes a quiet conversation-timeline notice
 * ("switched to character X" / "returned to native Lily"). The main process
 * projects the durable binding events into whitelisted notices (display names
 * resolved from the pinned revisions — never raw card data); this module
 * stores them per session and renders them between turns.
 *
 * Extracted from session-runtime-store.js / message.js (hotspot ratchets).
 */

import { getRuntimeSession, notify } from "./session-runtime-store.js";
import { t } from "../i18n/index.js";

/**
 * Per-session notices window: the newest N by bindingVersion. Older notices
 * are evicted on apply — they would fall outside the committed render window
 * anyway, and the fetch cursor (below) means they are never re-requested.
 */
export const SWITCH_NOTICE_LIMIT = 200;

/**
 * Max binding-event version the renderer has consumed for a session. This is
 * an EVENT cursor, not a notice cursor: repository.getBindingEvents pages
 * ASC LIMIT 200, so a page of non-switch events (revision bumps) must still
 * advance the cursor or every later fetch would repeat the same page and a
 * switch behind it would never appear.
 */
export function getSwitchNoticeCursor(sessionId) {
  if (!sessionId) return 0;
  const runtime = getRuntimeSession(sessionId);
  const last = runtime.switchNotices.at(-1);
  return Math.max(runtime.switchNoticeCursor || 0, last?.bindingVersion || 0);
}

/**
 * Apply main-projected switch notices to a session. Notices are deduped by
 * bindingVersion and kept in binding version order, so replaying the durable
 * events after a renderer reload (or an overlapping after-version fetch during
 * rapid switches) adds each notice exactly once and never loses a version.
 * The committed history is never touched — a switch never injects a greeting
 * or any message. `eventCursor` is the max bindingVersion of the raw events
 * page the notices were projected from (see getSwitchNoticeCursor).
 */
export function applyCharacterSwitchNotices(sessionId, notices = [], eventCursor = 0) {
  if (!sessionId || !Array.isArray(notices)) return;
  const runtime = getRuntimeSession(sessionId);
  const seen = new Set(runtime.switchNotices.map((notice) => notice.bindingVersion));
  let added = false;
  let maxApplied = 0;
  for (const notice of notices) {
    const bindingVersion = Number(notice?.bindingVersion);
    if (!Number.isInteger(bindingVersion) || bindingVersion <= 0 || seen.has(bindingVersion)) continue;
    seen.add(bindingVersion);
    runtime.switchNotices.push({
      bindingVersion,
      mode: notice?.mode === "character" ? "character" : "native",
      characterName: String(notice?.characterName ?? ""),
      ts: Number.isFinite(Date.parse(notice?.createdAt)) ? Date.parse(notice.createdAt) : Date.now(),
    });
    maxApplied = Math.max(maxApplied, bindingVersion);
    added = true;
  }
  if (added) runtime.switchNotices.sort((a, b) => a.bindingVersion - b.bindingVersion);
  if (runtime.switchNotices.length > SWITCH_NOTICE_LIMIT) {
    runtime.switchNotices = runtime.switchNotices.slice(-SWITCH_NOTICE_LIMIT);
  }
  runtime.switchNoticeCursor = Math.max(runtime.switchNoticeCursor || 0, Number(eventCursor) || 0, maxApplied);
  if (added) notify();
}

/**
 * Render one switch notice pseudo-message (see mergeSwitchNotices) as a quiet
 * centered line between turns. The display name was resolved main-side; a
 * native return has no name.
 */
export function appendSwitchNoticeArticle(listEl, message, beforeNode = null, key = "") {
  if (!listEl) return;
  const article = document.createElement("article");
  article.className = "character-switch-notice";
  if (key) article.dataset.messageKey = key;
  const switchMeta = message.meta?.characterSwitch || {};
  article.textContent = switchMeta.mode === "character"
    ? t("character.switchNotice.character", { name: switchMeta.characterName || t("character.unnamed") })
    : t("character.switchNotice.native");
  if (beforeNode) listEl.insertBefore(article, beforeNode);
  else listEl.appendChild(article);
}
