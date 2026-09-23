import Link from "next/link";

/**
 * How far through a list the reader is, and how to go further.
 *
 * Every admin list was a bare `.limit(300)`: past 300 rows the page showed a
 * truncated list and said nothing, so an operator could not tell 300 from
 * 30,000 and could not reach the rest. A list that cannot say "1–50 of 12,904"
 * is not a list, it is a sample presented as one.
 *
 * Cursor paging, so the links are stable while rows keep arriving.
 */
export function Pagination({ basePath, searchParams = {}, shown = 0, total = null, nextCursor = "", cursor = "", copy = {} }) {
  const label = total === null
    ? `${copy.shown || "已显示"} ${shown}`
    : `${copy.shown || "已显示"} ${shown} / ${total.toLocaleString()}`;
  const link = (nextValue) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (key === "cursor" || value === undefined || value === "") continue;
      params.set(key, String(value));
    }
    if (nextValue) params.set("cursor", nextValue);
    const query = params.toString();
    return query ? `${basePath}?${query}` : basePath;
  };
  const truncatedWithoutNext = !nextCursor && total !== null && shown < total;
  return (
    <div className="mt-4 flex items-center justify-between gap-4 text-sm text-slate-600">
      <span>
        {label}
        {truncatedWithoutNext ? <span className="ms-2 text-amber-700">{copy.filtered || "（其余需筛选后查看）"}</span> : null}
      </span>
      <span className="flex items-center gap-2">
        {cursor ? (
          <Link className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-50" href={link("")}>
            {copy.first || "回到第一页"}
          </Link>
        ) : null}
        {nextCursor ? (
          <Link className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-50" href={link(nextCursor)}>
            {copy.next || "下一页"}
          </Link>
        ) : (
          <span className="text-slate-400">{copy.end || "已到末尾"}</span>
        )}
      </span>
    </div>
  );
}
