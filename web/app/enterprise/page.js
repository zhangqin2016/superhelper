import "../../components/site/site-shared.css";
import "../../components/site/product-mock.css";
import "../enterprise.css";
import Link from "next/link";
import { ArrowRight, Building2, CalendarClock, ChartPie, History, KeyRound, Phone, Plus, Power, Wallet } from "lucide-react";
import { AddMembersMock, HistoryMock, IdentityMock, OrgConsoleMock } from "../../components/site/enterprise-mocks";
import { SectionHead } from "../../components/site/section-head";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getI18n } from "../../lib/i18n.mjs";
import { enterpriseContentFor } from "../../lib/site-copy-enterprise.mjs";

export const metadata = {
  title: "Enterprise",
  description: "Lily Workbench for organizations: a platform-funded quota pool, weekly member budgets, identity-based billing, usage by member and model, and a full change history.",
  alternates: { canonical: "/enterprise" },
};

const featureIcons = [Building2, Phone, KeyRound, Wallet, CalendarClock, ChartPie, History, Power];

function Actions({ primary, secondary }) {
  return (
    <div className="ent-actions">
      <Link href="/contact" className="site-btn site-btn--primary site-btn--lg">{primary}</Link>
      <Link href="/account/enterprise" className="site-btn site-btn--secondary site-btn--lg">{secondary}<ArrowRight className="site-flip" size={17} /></Link>
    </div>
  );
}

export default async function EnterprisePage() {
  const { locale } = await getI18n();
  const c = enterpriseContentFor(locale);

  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="ent">
        <section className="ent-hero">
          <div className="shell">
            <div className="ent-hero-copy">
              <p className="site-eyebrow">{c.hero.eyebrow}</p>
              <h1 className="site-display">{c.hero.title}</h1>
              <p className="site-lead ent-hero-lead">{c.hero.description}</p>
              <Actions primary={c.hero.primaryCta} secondary={c.hero.secondaryCta} />
              <p className="ent-note">{c.hero.note}</p>
            </div>
            <div className="ent-hero-visual">
              <OrgConsoleMock copy={c.mocks.org} label={c.hero.mockLabel} className="pm-frame--lifted" />
            </div>
          </div>
        </section>

        <section className="site-section ent-features">
          <div className="shell">
            <SectionHead eyebrow={c.features.eyebrow} title={c.features.title} />
            <div className="ent-feature-grid">
              {c.features.items.map(([title, description], index) => {
                const Icon = featureIcons[index % featureIcons.length];
                return (
                  <article key={title} className="ent-feature">
                    <span className="ent-icon"><Icon size={18} strokeWidth={1.8} /></span>
                    <h3 className="site-h3">{title}</h3>
                    <p className="site-body">{description}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="site-section site-section--sunken ent-billing">
          <div className="shell">
            <SectionHead eyebrow={c.billing.eyebrow} title={c.billing.title} description={c.billing.description} split />
            <div className="ent-billing-grid">
              <ol className="ent-steps">
                {c.billing.steps.map(([title, description], index) => (
                  <li key={title}>
                    <span className="ent-step-num site-num">{index + 1}</span>
                    <div><h3 className="site-h3">{title}</h3><p className="site-body">{description}</p></div>
                  </li>
                ))}
              </ol>
              <div className="ent-stage">
                <IdentityMock copy={c.mocks.identity} label={c.billing.title} />
              </div>
            </div>
            <div className="site-card ent-week">
              <div className="ent-week-copy">
                <h3 className="site-h3">{c.billing.weekTitle}</h3>
                <p className="site-body">{c.billing.weekBody}</p>
              </div>
              <div className="ent-week-line" aria-hidden="true">
                <div className="ent-week-track">
                  <span className="ent-week-dot" />
                  <span className="ent-week-span" />
                  <span className="ent-week-dot ent-week-dot--end" />
                </div>
                <div className="ent-week-marks">
                  {c.billing.weekMarks.map((mark) => <span key={mark}>{mark}</span>)}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="site-section ent-console">
          <div className="shell">
            <SectionHead eyebrow={c.console.eyebrow} title={c.console.title} description={c.console.description} split />
            <div className="ent-console-grid">
              <div className="ent-stage"><AddMembersMock copy={c.mocks.add} label={c.mocks.add.title} /></div>
              <div className="ent-stage"><HistoryMock copy={c.mocks.history} label={c.mocks.history.title} /></div>
            </div>
          </div>
        </section>

        <section className="site-section site-section--sunken ent-faq">
          <div className="shell ent-faq-inner">
            <SectionHead eyebrow={c.faq.eyebrow} title={c.faq.title} />
            <div className="ent-faq-list">
              {c.faq.items.map(([question, answer], index) => (
                <details key={question} className="ent-faq-item" open={index === 0}>
                  <summary><span>{question}</span><Plus className="ent-faq-icon" size={18} strokeWidth={1.8} /></summary>
                  <p className="site-body">{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="site-section ent-final">
          <div className="shell ent-final-inner">
            <h2 className="site-h1">{c.finalCta.title}</h2>
            <p className="site-lead">{c.finalCta.description}</p>
            <Actions primary={c.finalCta.primary} secondary={c.finalCta.secondary} />
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
