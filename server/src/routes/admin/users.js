import { sql } from "kysely";
import { db } from "../../db.js";
import { okResponse } from "../../openapi.js";
import { normalizeAdminUserListQuery, normalizeAdminUserListRow, normalizeAdminUserStats } from "../../services/admin-users.js";
import { fetchEntitlementSummary } from "../../services/wallet.js";

function publicUser(user) {
  return {
    id: user.id,
    phoneE164: user.phone_e164,
    status: user.status,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  };
}

export function registerAdminUserRoutes(app) {
  app.get(
    "/api/admin/users",
    {
      schema: {
        tags: ["admin:users"],
        summary: "List registered account users",
        description: "Returns registered users with order, payment, entitlement and session summaries for operations.",
        response: { 200: okResponse({ users: { type: "array" }, stats: { type: "object" } }) },
      },
    },
    async (request) => {
      const filters = normalizeAdminUserListQuery(request.query || {});
      let query = db
        .selectFrom("users")
        .select([
          "users.id",
          "users.phone_e164",
          "users.status",
          "users.created_at",
          "users.last_login_at",
          (eb) => eb
            .selectFrom("orders")
            .select((orderEb) => orderEb.fn.count("orders.id").as("count"))
            .whereRef("orders.user_id", "=", "users.id")
            .as("order_count"),
          (eb) => eb
            .selectFrom("orders")
            .select((orderEb) => orderEb.fn.count("orders.id").as("count"))
            .whereRef("orders.user_id", "=", "users.id")
            .where("orders.status", "=", "paid")
            .as("paid_order_count"),
          (eb) => eb
            .selectFrom("orders")
            .select(() => sql`coalesce(sum(orders.amount_cents), 0)`.as("sum"))
            .whereRef("orders.user_id", "=", "users.id")
            .where("orders.status", "=", "paid")
            .as("total_paid_cents"),
          (eb) => eb
            .selectFrom("wallet_grants")
            .select(() => sql`coalesce(sum(wallet_grants.token_remaining), 0)`.as("sum"))
            .whereRef("wallet_grants.user_id", "=", "users.id")
            .where("wallet_grants.status", "=", "active")
            .where("wallet_grants.expires_at", ">", new Date())
            .as("token_remaining"),
          (eb) => eb
            .selectFrom("wallet_grants")
            .select(() => sql`coalesce(sum(wallet_grants.unit_remaining), 0)`.as("sum"))
            .whereRef("wallet_grants.user_id", "=", "users.id")
            .where("wallet_grants.resource_type", "=", "image_generation")
            .where("wallet_grants.status", "=", "active")
            .where("wallet_grants.expires_at", ">", new Date())
            .as("image_remaining"),
          (eb) => eb
            .selectFrom("wallet_grants")
            .select(() => sql`coalesce(sum(wallet_grants.unit_remaining), 0)`.as("sum"))
            .whereRef("wallet_grants.user_id", "=", "users.id")
            .where("wallet_grants.resource_type", "=", "video_generation")
            .where("wallet_grants.status", "=", "active")
            .where("wallet_grants.expires_at", ">", new Date())
            .as("video_remaining"),
          (eb) => eb
            .selectFrom("user_sessions")
            .select((sessionEb) => sessionEb.fn.count("user_sessions.id").as("count"))
            .whereRef("user_sessions.user_id", "=", "users.id")
            .where("user_sessions.revoked_at", "is", null)
            .where("user_sessions.expires_at", ">", new Date())
            .as("active_session_count"),
        ])
        .orderBy("users.created_at", "desc")
        .limit(filters.limit);

      if (filters.status) query = query.where("users.status", "=", filters.status);
      if (filters.q) {
        query = query.where((eb) => eb.or([
          eb("users.id", "ilike", `%${filters.q}%`),
          eb("users.phone_e164", "ilike", `%${filters.q}%`),
        ]));
      }

      const [users, stats] = await Promise.all([
        query.execute(),
        db
          .selectFrom("users")
          .select([
            () => sql`count(distinct users.id)`.as("total_users"),
            () => sql`count(distinct users.id) filter (where users.status = 'active')`.as("active_users"),
            () => sql`count(distinct users.id) filter (where users.created_at >= current_date)`.as("users_today"),
            () => sql`count(distinct orders.user_id) filter (where orders.status = 'paid')`.as("paid_users"),
            () => sql`count(orders.id) filter (where orders.status = 'paid')`.as("paid_orders"),
            () => sql`coalesce(sum(orders.amount_cents) filter (where orders.status = 'paid'), 0)`.as("revenue_cents"),
          ])
          .leftJoin("orders", "orders.user_id", "users.id")
          .executeTakeFirst(),
      ]);

      return {
        ok: true,
        filters,
        stats: normalizeAdminUserStats(stats),
        users: users.map(normalizeAdminUserListRow),
      };
    },
  );

  app.get(
    "/api/admin/users/:id",
    {
      schema: {
        tags: ["admin:users"],
        summary: "Get a registered account user detail",
        description: "Returns one user with entitlements, orders, grants, ledger rows, sessions, devices, SMS risk history and usage events.",
        response: { 200: okResponse({ user: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const user = await db.selectFrom("users").selectAll().where("id", "=", request.params.id).executeTakeFirst();
      if (!user) return reply.code(404).send({ ok: false, code: "USER_NOT_FOUND" });

      const [
        entitlements,
        orders,
        grants,
        ledger,
        sessions,
        devices,
        smsCodes,
        usageEvents,
      ] = await Promise.all([
        fetchEntitlementSummary(user.id),
        db
          .selectFrom("orders")
          .leftJoin("products", "products.id", "orders.product_id")
          .select([
            "orders.id",
            "orders.product_id",
            "orders.provider",
            "orders.provider_order_id",
            "orders.amount_cents",
            "orders.currency",
            "orders.status",
            "orders.paid_at",
            "orders.created_at",
            "orders.updated_at",
            "products.name as product_name",
            "products.kind as product_kind",
            "products.resource_type",
            "products.unit_amount",
          ])
          .where("orders.user_id", "=", user.id)
          .orderBy("orders.created_at", "desc")
          .limit(100)
          .execute(),
        db.selectFrom("wallet_grants").selectAll().where("user_id", "=", user.id).orderBy("created_at", "desc").limit(100).execute(),
        db.selectFrom("wallet_ledger").selectAll().where("user_id", "=", user.id).orderBy("created_at", "desc").limit(120).execute(),
        db
          .selectFrom("user_sessions")
          .select([
            "id",
            "user_id",
            "device_id",
            "expires_at",
            "revoked_at",
            "revoked_reason",
            "created_at",
            "last_seen_at",
          ])
          .where("user_id", "=", user.id)
          .orderBy("created_at", "desc")
          .limit(50)
          .execute(),
        db
          .selectFrom("user_devices")
          .leftJoin("devices", "devices.id", "user_devices.device_id")
          .select([
            "user_devices.device_id",
            "user_devices.first_seen_at",
            "user_devices.last_seen_at",
            "user_devices.status",
            "devices.platform",
            "devices.arch",
            "devices.app_version",
          ])
          .where("user_devices.user_id", "=", user.id)
          .orderBy("user_devices.last_seen_at", "desc")
          .limit(50)
          .execute(),
        db
          .selectFrom("sms_codes")
          .select([
            "id",
            "phone_e164",
            "purpose",
            "expires_at",
            "attempt_count",
            "consumed_at",
            "ip",
            "device_id",
            "risk_level",
            "risk_reason",
            "send_provider",
            "send_status",
            "created_at",
          ])
          .where("phone_e164", "=", user.phone_e164)
          .orderBy("created_at", "desc")
          .limit(50)
          .execute(),
        db
          .selectFrom("usage_events")
          .selectAll()
          .where("user_id", "=", user.id)
          .orderBy("created_at", "desc")
          .limit(100)
          .execute(),
      ]);

      return {
        ok: true,
        user: publicUser(user),
        entitlements,
        orders,
        grants,
        ledger,
        sessions,
        devices,
        smsCodes,
        usageEvents,
      };
    },
  );
}
