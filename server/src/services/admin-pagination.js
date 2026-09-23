import { z } from "zod";

/**
 * Paging for admin lists, decided once.
 *
 * Every admin list was a bare `.limit(300)`: past 300 rows the console showed a
 * truncated list and said nothing, so an operator could not tell 300 from
 * 30,000 and could not reach the rest. Silent truncation is the same defect as
 * a swallowed error — the page looks complete.
 *
 * Keyset paging, not offset: the lists are ordered by time and an offset walk
 * both drifts as rows arrive and gets slower the further you go. The cursor is
 * the last row's (sort value, id), so a page is stable and every page costs the
 * same. `total` is a real count, so the reader knows what they are looking at.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export const pageQuerySchema = z.object({
  cursor: z.string().max(200).optional().default(""),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(DEFAULT_PAGE_SIZE),
});

/** Encode/decode is opaque to the client: it must not build one by hand. */
export function encodeCursor(sortValue, id) {
  const raw = JSON.stringify([sortValue instanceof Date ? sortValue.toISOString() : sortValue, String(id ?? "")]);
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [sortValue, id] = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (sortValue === undefined || id === undefined) return null;
    return { sortValue, id: String(id) };
  } catch {
    return null; // an unreadable cursor reads the first page, never an error page
  }
}

/**
 * The key a selected column comes back under. A joined list orders by
 * "devices.last_seen_at" but the row holds "last_seen_at"; reading the
 * qualified name gave an undefined cursor, and every "next page" came back
 * empty.
 */
export function rowKey(column) {
  return String(column).split(".").pop();
}

/**
 * Run one page of a keyset-ordered query.
 *
 * @param {object} input
 * @param {Function} input.query  () => kysely query builder, already filtered
 * @param {string} input.sortColumn  the ordered column (descending)
 * @param {string} [input.idColumn]  tiebreaker, default "id"
 * @param {string} [input.cursor]
 * @param {number} [input.limit]
 * @param {Function} [input.countQuery]  () => builder for the exact total
 * @returns {Promise<{items: object[], nextCursor: string, total: number|null, pageSize: number}>}
 */
export async function pageOf({ query, sortColumn, idColumn = "id", cursor = "", limit = DEFAULT_PAGE_SIZE, countQuery = null, direction = "desc" }) {
  const dir = direction === "asc" ? "asc" : "desc";
  const beyond = dir === "asc" ? ">" : "<";
  const size = Math.min(Math.max(Number(limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const anchor = decodeCursor(cursor);
  let builder = query();
  if (anchor) {
    // (sort, id) < (anchor.sort, anchor.id) in descending order.
    builder = builder.where((eb) =>
      eb.or([
        eb(sortColumn, beyond, anchor.sortValue),
        eb.and([eb(sortColumn, "=", anchor.sortValue), eb(idColumn, beyond, anchor.id)]),
      ]),
    );
  }
  const rows = await builder.orderBy(sortColumn, dir).orderBy(idColumn, dir).limit(size + 1).execute();
  const items = rows.slice(0, size);
  const last = items[items.length - 1];
  const nextCursor = rows.length > size && last ? encodeCursor(last[rowKey(sortColumn)], last[rowKey(idColumn)]) : "";
  let total = null;
  if (countQuery) {
    const row = await countQuery().executeTakeFirst();
    const value = Number(row?.count ?? row?.n ?? 0);
    total = Number.isFinite(value) ? value : null;
  }
  return { items, nextCursor, total, pageSize: size };
}

/** The response shape every admin list answers with. */
export function pageResponseSchema(itemsKey) {
  return {
    [itemsKey]: { type: "array", items: { type: "object", additionalProperties: true } },
    nextCursor: { type: "string" },
    total: { type: ["number", "null"] },
    pageSize: { type: "number" },
  };
}

/**
 * One admin list handler, start to finish.
 *
 * Reading the request, paging the query and shaping the response are the same
 * three steps on every list; doing them by hand is how one endpoint ends up
 * with a cursor and the next with a silent `.limit(300)`.
 *
 * @param {object} request fastify request
 * @param {{key: string, query: Function, countQuery?: Function, sortColumn: string, idColumn?: string}} spec
 */
export async function listPage(request, spec) {
  const { cursor, limit } = pageQuerySchema.parse(request?.query || {});
  const page = await pageOf({ ...spec, cursor, limit });
  return {
    ok: true,
    [spec.key]: page.items,
    nextCursor: page.nextCursor,
    total: page.total,
    pageSize: page.pageSize,
  };
}
