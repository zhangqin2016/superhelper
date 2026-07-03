#!/usr/bin/env node
import assert from "node:assert/strict";

const adminUsers = await import("../server/src/services/admin-users.js");

assert.equal(adminUsers.maskPhoneE164("+8613800000000"), "138****0000");
assert.equal(adminUsers.maskPhoneE164("14155550100"), "141****0100");

assert.deepEqual(adminUsers.normalizeAdminUserListQuery({
  q: "  +86138  ",
  status: "active",
  limit: "999",
}), {
  q: "+86138",
  status: "active",
  limit: 300,
});

assert.deepEqual(adminUsers.normalizeAdminUserListQuery({
  status: "deleted",
  limit: "-1",
}), {
  q: "",
  status: "",
  limit: 1,
});

assert.deepEqual(adminUsers.normalizeAdminUserStats({
  total_users: "10",
  active_users: "9",
  users_today: "2",
  paid_users: "3",
  paid_orders: "4",
  revenue_cents: "9900",
}), {
  totalUsers: 10,
  activeUsers: 9,
  usersToday: 2,
  paidUsers: 3,
  paidOrders: 4,
  revenueCents: 9900,
});

assert.deepEqual(adminUsers.normalizeAdminUserListRow({
  id: "usr_1",
  phone_e164: "+8613800000000",
  status: "active",
  created_at: "2026-07-03T00:00:00.000Z",
  last_login_at: null,
  order_count: "2",
  paid_order_count: "1",
  total_paid_cents: "990",
  token_remaining: "1000",
  image_remaining: "3",
  video_remaining: "1",
  active_session_count: "2",
}), {
  id: "usr_1",
  phoneE164: "+8613800000000",
  phoneMasked: "138****0000",
  status: "active",
  createdAt: "2026-07-03T00:00:00.000Z",
  lastLoginAt: null,
  orderCount: 2,
  paidOrderCount: 1,
  totalPaidCents: 990,
  tokenRemaining: 1000,
  imageRemaining: 3,
  videoRemaining: 1,
  activeSessionCount: 2,
});

console.log("admin users helpers ok");
