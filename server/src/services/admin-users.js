export function maskPhoneE164(phoneE164) {
  const text = String(phoneE164 || "").trim();
  if (text.startsWith("+86") && text.length >= 14) return `${text.slice(3, 6)}****${text.slice(-4)}`;
  if (text.length <= 6) return text;
  return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

export function normalizeAdminUserListQuery(query = {}) {
  const limit = Math.min(Math.max(Number(query.limit || 100), 1), 300);
  const status = String(query.status || "").trim();
  return {
    limit,
    q: String(query.q || "").trim(),
    status: ["active", "disabled"].includes(status) ? status : "",
  };
}

export function normalizeAdminUserListRow(row = {}) {
  return {
    id: String(row.id || ""),
    phoneE164: String(row.phone_e164 || ""),
    phoneMasked: maskPhoneE164(row.phone_e164),
    status: String(row.status || ""),
    createdAt: row.created_at || null,
    lastLoginAt: row.last_login_at || null,
    orderCount: Number(row.order_count || 0),
    paidOrderCount: Number(row.paid_order_count || 0),
    totalPaidCents: Number(row.total_paid_cents || 0),
    tokenRemaining: Number(row.token_remaining || 0),
    imageRemaining: Number(row.image_remaining || 0),
    videoRemaining: Number(row.video_remaining || 0),
    activeSessionCount: Number(row.active_session_count || 0),
  };
}

export function normalizeAdminUserStats(row = {}) {
  return {
    totalUsers: Number(row.total_users || 0),
    activeUsers: Number(row.active_users || 0),
    usersToday: Number(row.users_today || 0),
    paidUsers: Number(row.paid_users || 0),
    paidOrders: Number(row.paid_orders || 0),
    revenueCents: Number(row.revenue_cents || 0),
  };
}
