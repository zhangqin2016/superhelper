import { sql } from "kysely";
import { db } from "../db.js";

/**
 * What the token spend actually looks like.
 *
 * The console showed sums: today's messages, today's tokens, a 30-day line. A
 * sum answers "how much" and nothing else — it cannot say whether a hundred
 * devices each spent a little or one device spent 743 million tokens in a day,
 * which is what the production data actually contains. So this reports the
 * shape: percentiles, concentration, and the same window against the one before
 * it.
 *
 * Grain is what the data really has: `usage_daily` is (date, device, model),
 * reported by the client's telemetry. Per-turn distribution is NOT derivable
 * today — usage_events carried no token counts until 2026-09-23 — and this
 * module says so rather than drawing a line through zeros.
 */

const DAY = "86400";

function windowStart(days) {
  return sql`now() - (${String(days)} || ' days')::interval`;
}

/** Percentiles over daily (device, model) token spend — the real distribution. */
async function distribution(days) {
  const row = await db
    .selectFrom("usage_daily")
    .select([
      sql`count(*)`.as("rows"),
      sql`count(*) filter (where input_tokens + output_tokens > 0)`.as("rows_with_tokens"),
      sql`coalesce(sum(input_tokens + output_tokens), 0)`.as("total_tokens"),
      sql`coalesce(sum(input_tokens), 0)`.as("input_tokens"),
      sql`coalesce(sum(output_tokens), 0)`.as("output_tokens"),
      sql`coalesce(percentile_disc(0.5) within group (order by input_tokens + output_tokens), 0)`.as("p50"),
      sql`coalesce(percentile_disc(0.9) within group (order by input_tokens + output_tokens), 0)`.as("p90"),
      sql`coalesce(percentile_disc(0.99) within group (order by input_tokens + output_tokens), 0)`.as("p99"),
      sql`coalesce(max(input_tokens + output_tokens), 0)`.as("max"),
    ])
    .where(sql`usage_date`, ">=", windowStart(days))
    .executeTakeFirst();
  return {
    rows: Number(row?.rows || 0),
    rowsWithTokens: Number(row?.rows_with_tokens || 0),
    totalTokens: Number(row?.total_tokens || 0),
    inputTokens: Number(row?.input_tokens || 0),
    outputTokens: Number(row?.output_tokens || 0),
    p50: Number(row?.p50 || 0),
    p90: Number(row?.p90 || 0),
    p99: Number(row?.p99 || 0),
    max: Number(row?.max || 0),
  };
}

/** Who the tokens went to, and what share the heaviest few are. */
async function concentration(days, column, limit = 10) {
  const rows = await db
    .selectFrom("usage_daily")
    .select([
      sql.ref(column).as("key"),
      sql`sum(input_tokens + output_tokens)`.as("tokens"),
      sql`sum(message_count)`.as("messages"),
    ])
    .where(sql`usage_date`, ">=", windowStart(days))
    .groupBy(sql.ref(column))
    .orderBy(sql`sum(input_tokens + output_tokens)`, "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    key: String(row.key ?? "(未记录)"),
    tokens: Number(row.tokens || 0),
    messages: Number(row.messages || 0),
  }));
}

/**
 * @param {{days?: number, previous?: boolean}} [input]
 */
export async function usageAnalytics({ days = 30 } = {}) {
  const window = Math.min(Math.max(Number(days) || 30, 1), 365);
  const [current, byModel, byDevice, byLicense, events] = await Promise.all([
    distribution(window),
    concentration(window, "model"),
    concentration(window, "device_id"),
    concentration(window, "license_id"),
    db
      .selectFrom("usage_events")
      .select([
        sql`coalesce(nullif(feature, ''), '(未记录)')`.as("feature"),
        sql`count(*)`.as("events"),
        sql`count(*) filter (where input_tokens + output_tokens + billable_tokens > 0)`.as("events_with_tokens"),
      ])
      .where("created_at", ">=", windowStart(window))
      .groupBy(sql`coalesce(nullif(feature, ''), '(未记录)')`)
      .orderBy(sql`count(*)`, "desc")
      .execute(),
  ]);

  const total = current.totalTokens || 0;
  const share = (list) => list.map((item) => ({ ...item, share: total ? item.tokens / total : 0 }));
  const topShare = (list, n) => (total ? list.slice(0, n).reduce((sum, item) => sum + item.tokens, 0) / total : 0);

  return {
    window: { days: window, grain: "daily per device and model" },
    // Honesty, not decoration: the reader is told how much of the window this
    // is actually computed from before they read a single number.
    coverage: {
      rows: current.rows,
      rowsWithTokens: current.rowsWithTokens,
      tokenRowShare: current.rows ? current.rowsWithTokens / current.rows : 0,
      perTurnAvailable: false,
      perTurnNote: "usage_events carried no token counts before 2026-09-23; per-turn distribution starts from events recorded after that.",
    },
    tokens: {
      total,
      input: current.inputTokens,
      output: current.outputTokens,
      p50: current.p50,
      p90: current.p90,
      p99: current.p99,
      max: current.max,
    },
    concentration: {
      top1DeviceShare: topShare(byDevice, 1),
      top5DeviceShare: topShare(byDevice, 5),
      byDevice: share(byDevice),
      byLicense: share(byLicense),
      byModel: share(byModel),
    },
    features: events.map((row) => ({
      feature: String(row.feature),
      events: Number(row.events || 0),
      eventsWithTokens: Number(row.events_with_tokens || 0),
    })),
  };
}
