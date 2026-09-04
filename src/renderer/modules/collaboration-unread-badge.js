/**
 * The collaboration unread badge: a dot on the rail's inbox tile and the exact
 * count on the panel toggle. Muted conversations never raise it — WeChat's
 * rule: they keep their own dot in the list but stay out of the global count.
 */
export function createUnreadBadge({ railUnread = null, unreadBadge = null, isMuted = () => false } = {}) {
  return (conversations = []) => {
    const total = (Array.isArray(conversations) ? conversations : [])
      .reduce((sum, row) => sum + (Number(row?.unreadCount) > 0 && !isMuted(row.id) ? Number(row.unreadCount) : 0), 0);
    if (railUnread) railUnread.hidden = total <= 0;
    if (!unreadBadge) return;
    unreadBadge.hidden = total <= 0;
    unreadBadge.textContent = total > 99 ? "99+" : String(total);
  };
}
