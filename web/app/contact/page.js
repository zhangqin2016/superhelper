import Link from "next/link";
import { Mail, ShieldCheck, Sparkles } from "lucide-react";
import { SiteNav } from "../../components/site-nav";
import { ContactForm } from "../../components/contact-form";
import { getI18n } from "../../lib/i18n.mjs";

export default async function ContactPage() {
  const { locale, t } = await getI18n();
  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="min-h-screen bg-white pt-28">
        <section className="shell grid gap-12 py-16 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <p className="mb-3 font-mono text-sm uppercase text-brand">Team deployment</p>
            <h1 className="max-w-3xl text-5xl font-semibold leading-tight text-slate-950">
              {t.pages.contactTitle}
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-500">
              {t.pages.contactDesc}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="mailto:hello@lanrensoft.cn?subject=Lily%20Workbench%20Team%20License" className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-3 font-semibold text-white">
                <Mail size={18} />
                {t.nav.contact}
              </Link>
              <Link href="/admin/login" className="rounded-lg border border-slate-200 px-5 py-3 font-semibold text-slate-800">
                {t.admin.brand}
              </Link>
            </div>
          </div>
          <ContactForm labels={t.contactForm} source="contact" />
        </section>
        <section className="shell pb-20">
          <aside className="table-card p-6">
            <h2 className="text-xl font-semibold">{t.pages.contactPrepareTitle}</h2>
            <div className="mt-6 space-y-5">
              {t.pages.contactPrepareItems.map(([title, body], index) => {
                const Icon = [Sparkles, ShieldCheck, Mail][index];
                return (
                <div key={title} className="flex gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-brand">
                    <Icon size={18} />
                  </div>
                  <div>
                    <div className="font-semibold text-slate-950">{title}</div>
                    <div className="mt-1 text-sm leading-6 text-slate-500">{body}</div>
                  </div>
                </div>
              );})}
            </div>
          </aside>
        </section>
      </main>
    </>
  );
}
