import { LogOut } from "lucide-react";
import { logoutAction } from "../app/admin/actions";
import { LanguageSwitcher } from "./language-switcher";
import { AdminNav } from "./admin-nav";
import { getI18n } from "../lib/i18n.mjs";

export async function AdminShell({ children, title, subtitle }) {
  const { locale, t } = await getI18n();
  const nav = t.admin.nav;
  // Task-based grouping for non-technical operators. Routes here are the
  // existing ones; later phases merge overlapping pages and update this map.
  const groups = [
    {
      title: t.admin.navGroups.operations,
      items: [
        { href: "/admin", label: nav.dashboard },
        { href: "/admin/users", label: nav.users || "Users" },
        { href: "/admin/licenses", label: nav.licenses },
        { href: "/admin/devices", label: nav.devices },
        { href: "/admin/usage", label: nav.usage },
        { href: "/admin/billing", label: nav.billing || "Billing" },
        { href: "/admin/contacts", label: nav.contacts },
      ],
    },
    {
      title: t.admin.navGroups.distribution,
      items: [
        { href: "/admin/releases", label: nav.releases },
        { href: "/admin/library", label: t.admin.library.title },
      ],
    },
    {
      title: t.admin.navGroups.configuration,
      items: [
        { href: "/admin/config", label: nav.config },
      ],
    },
    {
      title: t.admin.navGroups.monitoring,
      items: [
        { href: "/admin/health", label: nav.health },
        { href: "/admin/diagnostics", label: nav.diagnostics },
        { href: "/admin/audit", label: nav.audit },
      ],
    },
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
        <AdminNav groups={groups} />
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
