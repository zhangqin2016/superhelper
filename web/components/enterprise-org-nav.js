"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The organization's tabs. Labels arrive translated; only the active state is decided here. */
export default function EnterpriseOrgNav({ items = [], base = "" }) {
  const pathname = usePathname() || "";
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto border-b border-slate-200" aria-label="organization">
      {items.map((item) => {
        const active = item.href === base ? pathname === base : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 border-b-2 px-3 py-2 text-sm ${active ? "border-slate-900 font-medium text-slate-950" : "border-transparent text-slate-500 hover:text-slate-900"}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
