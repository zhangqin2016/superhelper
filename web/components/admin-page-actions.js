import Link from "next/link";

export function AdminPageActions({ actions = [], children }) {
  const items = children ? [{ node: children }, ...actions] : actions;
  if (!items.length) return null;

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      {items.map((action, index) => action.node || (
        <Link
          key={action.href || index}
          href={action.href}
          className={action.variant === "primary"
            ? "inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            : "inline-flex rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50"
          }
        >
          {action.label}
        </Link>
      ))}
    </div>
  );
}
