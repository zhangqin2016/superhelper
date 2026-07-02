"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity, BarChart3, Boxes, ClipboardList, CreditCard, DownloadCloud, Gauge,
  KeyRound, Laptop, Mail, PackageCheck, Radar, Settings, SlidersHorizontal, Store,
} from "lucide-react";

// href → icon, kept here so the server shell passes only plain (serializable)
// data. Active state needs the client-side pathname.
const ICONS = {
  "/admin": Gauge,
  "/admin/licenses": KeyRound,
  "/admin/devices": Laptop,
  "/admin/usage": BarChart3,
  "/admin/contacts": Mail,
  "/admin/billing": CreditCard,
  "/admin/releases": DownloadCloud,
  "/admin/library": Store,
  "/admin/apps": Store,
  "/admin/skill-packages": PackageCheck,
  "/admin/runtime-packs": Boxes,
  "/admin/config": SlidersHorizontal,
  "/admin/settings": Settings,
  "/admin/health": Activity,
  "/admin/diagnostics": Radar,
  "/admin/audit": ClipboardList,
};

function isActive(pathname, href) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

// groups: [{ title, items: [{ href, label }] }]
export function AdminNav({ groups }) {
  const pathname = usePathname() || "";
  return (
    <nav className="space-y-5">
      {groups.map((group) => (
        <div key={group.title}>
          <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-white/35">{group.title}</div>
          <div className="space-y-1">
            {group.items.map(({ href, label }) => {
              const Icon = ICONS[href] || Gauge;
              const active = isActive(pathname, href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
                    active ? "bg-white/12 text-white" : "text-white/68 hover:bg-white/8 hover:text-white"
                  }`}
                >
                  <Icon size={18} />
                  {label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
