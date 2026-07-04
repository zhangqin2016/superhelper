import Link from "next/link";
import { BriefcaseBusiness, CheckCircle2, ClipboardList, Download, FileText, FolderOpen, GraduationCap, Image, MessageCircle, MousePointerClick, Scale, Search, ShieldCheck, Sparkles, TrendingUp, Users, Wand2, Wrench, Zap } from "lucide-react";
import { SiteNav } from "../components/site-nav";
import { ProductWindow } from "../components/product-window";
import { ContactForm } from "../components/contact-form";
import { getI18n } from "../lib/i18n.mjs";

export default async function HomePage() {
  const { locale, t } = await getI18n();
  const painIcons = [Image, FileText, Search, Wrench];
  const expertIcons = [Scale, TrendingUp, BriefcaseBusiness, Users, GraduationCap, Sparkles];
  const expertAccents = ["mint", "coral", "cyan", "mint", "coral", "cyan"];
  return (
    <>
      <SiteNav initialLocale={locale} />
      <main>
        <section className="kinetic-hero min-h-screen overflow-hidden pt-[112px] text-white">
          <div className="shell">
            <div className="grid gap-12 lg:grid-cols-[0.98fr_1.02fr] lg:items-center">
              <div>
                <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-mint/25 bg-mint/10 px-4 py-2 text-sm text-mint">
                  <Zap size={16} />
                  {t.home.badge}
                </div>
                <h1 className="hero-title max-w-4xl font-semibold leading-[1.05]">
                  {t.home.titleA}
                  <span className="block text-mint">{t.home.titleB}</span>
                </h1>
                <p className="mt-7 max-w-2xl text-xl leading-9 text-white/72">
                  {t.home.desc.map((line) => <span className="block" key={line}>{line}</span>)}
                </p>
                <div className="hero-actions mt-9 flex flex-wrap gap-3">
                  <Link href="/download" className="inline-flex items-center gap-2 rounded-lg bg-mint px-6 py-4 font-semibold text-ink shadow-[0_18px_48px_rgba(95,241,196,0.28)]">
                    <Download size={18} />
                    {t.home.start}
                  </Link>
                </div>
                <div className="mt-7 grid max-w-2xl gap-2 text-sm text-white/62 sm:grid-cols-3">
                  {t.home.promiseBullets.map((item) => (
                    <div key={item} className="flex items-center gap-2">
                      <CheckCircle2 size={15} className="shrink-0 text-mint" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="hero-machine">
                <div className="machine-toolbar">
                  <span />
                  <span />
                  <span />
                  <b>{t.home.os}</b>
                </div>
                <div className="hero-workflow">
                  <div className="workflow-scenes">
                    {t.home.scenes.map((scene, index) => (
                      <div className="workflow-scene-pill" style={{ animationDelay: `${index * 2.2}s` }} key={scene}>
                        {scene}
                      </div>
                    ))}
                  </div>
                  <div className="workflow-stage workflow-stage--files">
                    <div className="workflow-stage-head">
                      <FolderOpen size={18} />
                      <span>{t.home.filesTitle}</span>
                    </div>
                    <div className="workflow-file-stack">
                      {t.home.files.map((file, index) => (
                        <div className="workflow-file" style={{ animationDelay: `${index * 0.28}s` }} key={file}>
                          <FileText size={15} />
                          {file}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="workflow-lane">
                    <div className="workflow-pulse workflow-pulse--one" />
                    <div className="workflow-pulse workflow-pulse--two" />
                    <div className="workflow-pulse workflow-pulse--three" />
                  </div>
                  <div className="workflow-brain">
                    <div className="brain-ring" />
                    <div className="brain-core">
                      <Wand2 size={28} />
                      <strong>{t.home.brain}</strong>
                      <span>{t.home.brainDesc}</span>
                    </div>
                  </div>
                  <div className="workflow-question">
                    <MessageCircle size={17} />
                    {t.home.question}
                  </div>
                  <div className="workflow-evidence">
                    {t.home.evidence.map((item, index) => (
                      <div style={{ animationDelay: `${index * 0.35}s` }} key={item}>
                        <Search size={15} />
                        {item}
                      </div>
                    ))}
                  </div>
                  <div className="workflow-result">
                    <div className="workflow-result-title">{t.home.resultTitle}</div>
                    <div className="workflow-result-grid">
                      {t.home.outputs.map((item, index) => (
                        <div className="workflow-result-card" style={{ animationDelay: `${index * 0.2}s` }} key={item}>
                          <CheckCircle2 size={17} />
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-14">
              <ProductWindow labels={t.productWindow} />
            </div>
          </div>
        </section>

        <section id="scenarios" className="bg-white py-24">
          <div className="shell grid gap-12 lg:grid-cols-[380px_1fr]">
            <div>
              <p className="mb-3 font-mono text-sm uppercase text-brand">{t.home.scenariosLabel}</p>
              <h2 className="text-4xl font-semibold tracking-normal text-slate-950">{t.home.scenariosTitle}</h2>
              <p className="mt-4 leading-7 text-slate-500">
                {t.home.scenariosDesc}
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {t.home.pains.map(([title, desc], index) => {
                const Icon = painIcons[index];
                return (
                <div key={title} className="rounded-xl border border-slate-200 bg-slate-50 p-6">
                  <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-white text-brand shadow-sm">
                    <Icon size={22} />
                  </div>
                  <h3 className="text-lg font-semibold text-slate-950">{title}</h3>
                  <p className="mt-2 leading-7 text-slate-500">{desc}</p>
                </div>
              );})}
            </div>
          </div>
        </section>

        <section className="bg-[#f7f4ee] py-24">
          <div className="shell grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
            <div>
              <p className="mb-3 font-mono text-sm uppercase text-coral">{t.home.workspaceLabel}</p>
              <h2 className="text-4xl font-semibold text-slate-950 md:text-5xl">
                {t.home.workspaceTitleA}
                <span className="block text-brand">{t.home.workspaceTitleB}</span>
              </h2>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
                {t.home.workspaceDesc}
              </p>
            </div>
            <div className="workspace-demo">
              <div className="workspace-demo-head">
                <FolderOpen size={22} />
                <div>
                  <b>{t.home.workspaceDemo.title}</b>
                  <span>{t.home.workspaceDemo.path}</span>
                </div>
              </div>
              <div className="workspace-demo-grid">
                {t.home.workspaceDemo.items.map((item) => (
                  <div key={item} className="workspace-demo-item">{item}</div>
                ))}
              </div>
              <div className="workspace-demo-footer">
                <Wand2 size={18} />
                {t.home.workspaceDemo.footer}
              </div>
            </div>
          </div>
        </section>

        <section id="experts" className="expert-lab-section py-24 text-white">
          <div className="shell">
            <div className="mb-12 grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
              <div>
                <p className="mb-3 font-mono text-sm uppercase text-mint">{t.home.superLabel}</p>
                <h2 className="text-4xl font-semibold md:text-5xl">
                  {t.home.superTitle}
                </h2>
              </div>
              <p className="max-w-2xl text-lg leading-8 text-white/62">
                {t.home.superDesc}
              </p>
            </div>
            <div className="expert-grid">
              {t.home.experts.map(([title, folder, inputs, outputs], index) => {
                const Icon = expertIcons[index];
                const accent = expertAccents[index];
                return (
                <div className={`expert-card expert-card--${accent}`} style={{ animationDelay: `${index * 0.12}s` }} key={title}>
                  <div className="expert-card-head">
                    <div className="expert-icon"><Icon size={24} /></div>
                    <div>
                      <h3>{title}</h3>
                      <span>{folder}</span>
                    </div>
                  </div>
                  <div className="expert-feed">
                    {inputs.map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                  <div className="expert-arrow">
                    <span />
                    <Wand2 size={18} />
                    <span />
                  </div>
                  <div className="expert-output">
                    {outputs.map((item) => (
                      <div key={item}><CheckCircle2 size={16} />{item}</div>
                    ))}
                  </div>
                </div>
              );})}
            </div>
          </div>
        </section>

        <section id="different" className="bg-[#f3f0ea] py-24">
          <div className="shell">
            <div className="mb-10 max-w-3xl">
              <p className="mb-3 font-mono text-sm uppercase text-coral">{t.home.differentLabel}</p>
              <h2 className="text-4xl font-semibold text-slate-950 md:text-5xl">{t.home.differentTitle}</h2>
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              {t.home.comparisons.map(([title, desc], index) => (
                <div key={title} className={`compare-panel ${index === 0 ? "compare-plain" : "compare-shock"}`}>
                  <div className={`mb-5 flex h-12 w-12 items-center justify-center rounded-lg ${index === 0 ? "bg-slate-100 text-slate-600" : "bg-white/14 text-white"}`}>
                    {index === 0 ? <MessageCircle size={23} /> : <MousePointerClick size={23} />}
                  </div>
                  <h3 className="text-2xl font-semibold">{title}</h3>
                  <p className={`mt-4 leading-8 ${index === 0 ? "text-slate-500" : "text-white/76"}`}>{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-ink py-24 text-white">
          <div className="shell">
            <div className="mb-12 max-w-3xl">
              <p className="mb-3 font-mono text-sm uppercase text-mint">{t.home.magicLabel}</p>
              <h2 className="text-4xl font-semibold md:text-5xl">{t.home.magicTitle}</h2>
            </div>
            <div className="transform-line">
              {t.home.transformations.map(([title, desc], index) => (
                <div className="transform-card" key={title}>
                  <div className="transform-index">{String(index + 1).padStart(2, "0")}</div>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="product" className="bg-white py-24">
          <div className="shell">
            <div className="mb-10 max-w-3xl">
              <p className="mb-3 font-mono text-sm uppercase text-brand">{t.home.howLabel}</p>
              <h2 className="text-4xl font-semibold text-slate-950">{t.home.howTitle}</h2>
              <p className="mt-4 leading-7 text-slate-500">
                {t.home.howDesc}
              </p>
            </div>
            <div className="grid gap-5 md:grid-cols-4">
              {t.home.workflows.map(([step, title, desc]) => (
                <div key={step} className="table-card p-6">
                  <div className="mb-8 flex h-11 w-11 items-center justify-center rounded-lg bg-brand font-mono text-sm font-semibold text-white">
                    {step}
                  </div>
                  <h3 className="text-lg font-semibold text-slate-950">{title}</h3>
                  <p className="mt-3 leading-7 text-slate-500">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="plugins" className="bg-ink py-24 text-white">
          <div className="shell">
            <div className="mb-10 max-w-3xl">
              <p className="mb-3 font-mono text-sm uppercase text-cyan">{t.home.realOutcomesLabel}</p>
              <h2 className="text-4xl font-semibold">{t.home.realOutcomesTitle}</h2>
              <p className="mt-4 leading-7 text-white/58">
                {t.home.realOutcomesDesc}
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {t.home.outcomes.map(([title, desc]) => (
                <div key={title} className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
                  <Sparkles className="mb-5 text-cyan" size={22} />
                  <h3 className="font-semibold">{title}</h3>
                  <p className="mt-3 leading-7 text-white/58">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-white py-24">
          <div className="shell grid gap-10 lg:grid-cols-[1fr_420px]">
            <div>
              <p className="mb-3 font-mono text-sm uppercase text-brand">{t.home.teamLabel}</p>
              <h2 className="text-4xl font-semibold text-slate-950">{t.home.outcomesTitle}</h2>
              <p className="mt-4 max-w-2xl leading-7 text-slate-500">
                {t.home.outcomesDesc}
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/download" className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-3 font-semibold text-white">
                  <Download size={18} />
                  {t.nav.download}
                </Link>
                <Link href="/contact" className="rounded-lg border border-slate-200 px-5 py-3 font-semibold text-slate-700">
                  {t.nav.contact}
                </Link>
              </div>
            </div>
            <div className="table-card p-6">
              <h3 className="mb-5 text-xl font-semibold text-slate-950">{t.home.teamBoundaryTitle}</h3>
              {t.home.teamBoundaries.map(([title, desc]) => (
                <div key={title} className="mb-4 flex gap-3 last:mb-0">
                  <ShieldCheck className="mt-1 text-brand" size={18} />
                  <div>
                    <div className="font-semibold text-slate-950">{title}</div>
                    <div className="mt-1 text-sm text-slate-500">{desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[#eef3f7] py-24">
          <div className="shell grid gap-10 lg:grid-cols-[0.88fr_1.12fr] lg:items-start">
            <div>
              <p className="mb-3 font-mono text-sm uppercase text-brand">{t.home.contactLabel}</p>
              <h2 className="text-4xl font-semibold text-slate-950">{t.home.contactTitle}</h2>
              <p className="mt-4 max-w-2xl leading-7 text-slate-500">
                {t.home.contactDesc}
              </p>
              <div className="mt-8 grid gap-4">
                {t.home.contactPoints.map(([title, desc]) => (
                  <div key={title} className="flex gap-3">
                    <MessageCircle className="mt-1 text-brand" size={18} />
                    <div>
                      <div className="font-semibold text-slate-950">{title}</div>
                      <div className="mt-1 text-sm leading-6 text-slate-500">{desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <ContactForm labels={t.contactForm} source="home" />
          </div>
        </section>

        <section className="bg-[#eef3f7] py-20">
          <div className="shell">
            <div className="rounded-2xl bg-ink p-8 text-white md:p-12">
              <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-center">
                <div>
                  <ClipboardList className="mb-5 text-cyan" size={28} />
                  <h2 className="text-3xl font-semibold">{t.home.finalTitle}</h2>
                  <p className="mt-4 max-w-2xl leading-7 text-white/58">
                    {t.home.finalDesc}
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Link href="/download" className="inline-flex items-center justify-center gap-2 rounded-lg bg-white px-6 py-4 font-semibold text-ink">
                    {t.home.start}
                    <CheckCircle2 size={18} />
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
