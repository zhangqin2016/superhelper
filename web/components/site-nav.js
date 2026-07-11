"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { LanguageSwitcher } from "./language-switcher";
import { useI18n } from "../lib/use-i18n";

export function SiteNav({ initialLocale }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n(initialLocale);
  const links = [
    ["/apps", t.nav.apps],
    ["/skills", t.nav.skills],
    ["/wishes", t.nav.wishes],
    ["/pricing", t.nav.pricing],
  ];
  return (
    <header className="site-nav fixed left-0 right-0 top-0 border-b backdrop-blur-xl">
      <div className="shell flex h-[72px] items-center justify-between gap-3 text-slate-900">
        <Link href="/" className="flex items-center gap-3 text-lg font-semibold">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#586ce8] font-mono text-sm text-white shadow-sm">
            LW
          </span>
          <span className="site-brand-text">Lily Workbench</span>
        </Link>
        <nav className="hidden items-center gap-7 text-sm text-slate-600 lg:flex">
          {links.map(([href, label]) => <Link key={href} href={href} className="site-nav-link">{label}</Link>)}
        </nav>
        <div className="flex items-center gap-2">
          <LanguageSwitcher compact initialLocale={initialLocale} />
          <Link href="/account" className="site-account hidden rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:text-[#586ce8] md:inline-flex">
            {t.nav.account}
          </Link>
          <Link href="/download" className="nav-download rounded-xl bg-[#586ce8] px-4 py-2 text-sm font-semibold text-white shadow-sm">
            {t.nav.download}
          </Link>
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-800 lg:hidden"
            aria-label={t.nav.open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
      {open ? (
        <div className="site-nav-menu border-t border-slate-200 px-6 py-4 text-slate-900 lg:hidden">
          <nav className="grid gap-3 text-sm text-slate-700">
            {links.map(([href, label]) => (
              <Link key={href} href={href} onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 hover:bg-slate-100">
                {label}
              </Link>
            ))}
            <Link href="/account" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 hover:bg-slate-100">
              {t.nav.account}
            </Link>
            <Link href="/download" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 hover:bg-slate-100">
              {t.nav.download}
            </Link>
          </nav>
        </div>
      ) : null}
    </header>
  );
}
