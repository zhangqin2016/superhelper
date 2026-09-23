import Link from "next/link";

/**
 * One way to narrow an admin list, decided once.
 *
 * A filter lives in the URL, so it survives a reload, can be shared, and the
 * pager carries it to the next page. Changing the filter drops the cursor: a
 * cursor belongs to the list it was cut from.
 */
export function ListFilter({ basePath, searchParams = {}, param, value, options = [], label = "" }) {
  const href = (next) => {
    const params = new URLSearchParams();
    for (const [key, v] of Object.entries(searchParams)) {
      if (key === "cursor" || key === param || v === undefined || v === "") continue;
      params.set(key, String(v));
    }
    params.set(param, next);
    return `${basePath}?${params.toString()}`;
  };
  return (
    <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2 text-sm">
      {label ? <span className="text-slate-500">{label}</span> : null}
      <span className="inline-flex overflow-hidden rounded-lg border border-slate-300">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Link
              key={option.value}
              href={href(option.value)}
              aria-current={active ? "true" : undefined}
              className={`border-s border-slate-300 px-3 py-1.5 first:border-s-0 ${active ? "bg-slate-900 font-medium text-white" : "text-slate-700 hover:bg-slate-50"}`}
            >
              {option.label}
            </Link>
          );
        })}
      </span>
    </div>
  );
}
