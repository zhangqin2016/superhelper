import Link from "next/link";
import { Activity, BarChart3, Boxes, ClipboardList, DownloadCloud, Gauge, KeyRound, Laptop, LogOut, Mail, Plug, Radar, Settings, SlidersHorizontal } from "lucide-react";
import { logoutAction } from "../app/admin/actions";
import { LanguageSwitcher } from "./language-switcher";
import { getI18n } from "../lib/i18n.mjs";

export async function AdminShell({ children, title, subtitle }) {
  const { locale, t } = await getI18n();
  const items = [
    ["/admin", Gauge, t.admin.nav.dashboard],
    ["/admin/licenses", KeyRound, t.admin.nav.licenses],
    ["/admin/devices", Laptop, t.admin.nav.devices],
    ["/admin/usage", BarChart3, t.admin.nav.usage],
    ["/admin/contacts", Mail, t.admin.nav.contacts],
    ["/admin/releases", DownloadCloud, t.admin.nav.releases],
    ["/admin/document-packs", Boxes, t.admin.nav.documentPacks],
    ["/admin/plugins", Plug, t.admin.nav.plugins],
    ["/admin/config", SlidersHorizontal, t.admin.nav.config],
    ["/admin/health", Activity, t.admin.nav.health],
    ["/admin/diagnostics", Radar, t.admin.nav.diagnostics],
    ["/admin/settings", Settings, t.admin.nav.settings],
    ["/admin/audit", ClipboardList, t.admin.nav.audit],
  ];
  return (
    <div className="admin-layout">
      <aside className="admin-sidebar p-6">
        <div className="mb-9 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-sm font-bold text-ink">LW</div>
          <div>
            <div className="font-semibold">{t.admin.brand}</div>
            <div className="text-xs text-white/45">{t.admin.subtitle}</div>
          </div>
        </div>
        <div className="mb-5">
          <LanguageSwitcher initialLocale={locale} />
        </div>
        <nav className="space-y-1">
          {items.map(([href, Icon, label]) => (
            <Link key={href} href={href} className="flex items-center gap-3 rounded-lg px-3 py-3 text-sm text-white/68 hover:bg-white/8 hover:text-white">
              <Icon size={18} />
              {label}
            </Link>
          ))}
        </nav>
        <form action={logoutAction} className="mt-8">
          <button className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-white/45 hover:bg-white/8 hover:text-white">
            <LogOut size={18} />
            {t.admin.signOut}
          </button>
        </form>
      </aside>
      <main className="admin-main">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-slate-950">{title}</h1>
          {subtitle ? <p className="mt-2 text-slate-500">{subtitle}</p> : null}
        </div>
        {children}
      </main>
    </div>
  );
}
