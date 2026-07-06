import { SiteNav } from "../../components/site-nav";
import { SiteFooter } from "../../components/site-footer";
import { getI18n } from "../../lib/i18n.mjs";

export default async function DocsPage() {
  const { locale, t } = await getI18n();
  const sections = [
    ["Install", "Download the macOS Apple Silicon or Windows x64 installer from the download page. The client stores workspaces, sessions, and device identity locally."],
    ["Connect service", "Open Settings, set the Service API URL, then use Test connection. When healthy, activation, updates, skill package sync, and usage reporting prefer the service API."],
    ["Activate", "Create a license in the admin console, copy the one-time key, and paste it into the desktop app. Seats are enforced by device binding."],
    ["Workspaces", "Each workspace maps to a local folder and owns its own chat sessions, history, skills, and working context."],
    ["Skill packages", "Skill packages are published through the admin console and synced by the desktop client like resource packs."],
    ["Updates", "Upload installers to Qiniu, create release metadata in the admin console, and clients will check the release API. Static Qiniu latest.json remains available as a fallback."],
  ];
  const faqs = [
    ["Do you store prompts?", "No. The usage API stores aggregate counts only: device id, license id, model, message count, image count, tool count, skill count, and token counts."],
    ["Can a disabled license keep working?", "The client refreshes server licenses on startup and when the service connection is tested. A disabled license or device binding is marked invalid."],
    ["Can this run without a server?", "Yes. Offline signed activation codes and static Qiniu update manifests still work when the service URL is empty."],
  ];
  const navItems = [...sections.map(([title]) => title), "FAQ"];
  const slug = (value) => value.toLowerCase().replaceAll(" ", "-");

  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="min-h-screen bg-slate-50 pt-28">
        <div className="shell grid gap-10 py-16 lg:grid-cols-[260px_1fr]">
          <aside className="docs-sidebar hidden rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 lg:block">
            <div className="mb-3 font-semibold text-slate-950">Docs</div>
            <nav className="grid gap-1">
              {navItems.map((item) => (
                <a key={item} href={`#${slug(item)}`} className="docs-nav-link rounded-lg px-3 py-2">
                  {item}
                </a>
              ))}
            </nav>
          </aside>
          <article className="docs-content max-w-3xl">
            <h1 className="text-5xl font-semibold text-slate-950">{t.pages.docsTitle}</h1>
            <p className="mt-4 text-lg text-slate-500">{t.pages.docsDesc}</p>
            <nav className="docs-top-nav mt-8 flex flex-wrap gap-2">
              {navItems.map((item) => (
                <a key={item} href={`#${slug(item)}`} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600">
                  {item}
                </a>
              ))}
            </nav>
            <section className="mt-10 space-y-5">
              {sections.map(([title, body]) => (
                <div id={slug(title)} key={title} className="docs-section table-card p-6">
                  <h2 className="text-2xl font-semibold text-slate-950">{title}</h2>
                  <p className="mt-3 leading-7 text-slate-600">{body}</p>
                </div>
              ))}
            </section>
            <section id="faq" className="docs-section mt-8 rounded-2xl bg-ink p-8 text-white">
              <h2 className="text-2xl font-semibold">FAQ</h2>
              <div className="mt-6 space-y-5">
                {faqs.map(([q, a]) => (
                  <div key={q} className="border-t border-white/10 pt-5">
                    <h3 className="font-semibold">{q}</h3>
                    <p className="mt-2 text-white/62">{a}</p>
                  </div>
                ))}
              </div>
            </section>
          </article>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
