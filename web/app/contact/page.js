import "./contact.css";
import Link from "next/link";
import { ArrowUpRight, Mail } from "lucide-react";
import { SiteNav } from "../../components/site-nav";
import { SiteFooter } from "../../components/site-footer";
import { ContactForm } from "../../components/contact-form";
import { getI18n } from "../../lib/i18n.mjs";
import { catalogCopyFor } from "../../lib/site-copy-catalog.mjs";

const EMAIL = "felix@lilywb.cn";

export const metadata = { title: "Contact", description: "Questions about Lily Workbench, organization setup, or partnerships.", alternates: { canonical: "/contact" } };

export default async function ContactPage({ searchParams }) {
  const { locale, t } = await getI18n();
  const params = await searchParams;
  const copy = catalogCopyFor(locale).contact;
  const topic = typeof params?.topic === "string" && copy.topics[params.topic] ? params.topic : "general";
  const labels = { ...t.contactForm, ...copy.form };
  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="ct-page">
        <header className="site-page-head ct-head">
          <div className="shell">
            <p className="site-eyebrow">{copy.eyebrow}</p>
            <h1 className="site-h1 ct-title">{copy.title}</h1>
            <p className="site-lead ct-lead">{copy.description}</p>
          </div>
        </header>
        <section className="shell ct-layout">
          <ContactForm labels={labels} source="contact" topics={copy.topics} topicLabel={copy.topicLabel} initialTopic={topic} />
          <aside className="ct-aside">
            <div>
              <h2 className="site-h3">{copy.asideTitle}</h2>
              <ol className="ct-tips">
                {copy.asideItems.map(([title, body]) => (
                  <li key={title}><strong>{title}</strong><span>{body}</span></li>
                ))}
              </ol>
            </div>
            <div className="ct-aside-card site-card">
              <p className="ct-aside-label">{copy.emailTitle}</p>
              <a href={`mailto:${EMAIL}`} className="ct-email"><Mail size={16} aria-hidden="true" />{EMAIL}</a>
            </div>
            <div className="ct-aside-card site-card">
              <p className="ct-aside-label">{copy.helpTitle}</p>
              <p className="ct-aside-body">{copy.helpBody}</p>
              <Link href="/docs" className="site-link ct-help">{copy.helpCta}<ArrowUpRight size={15} aria-hidden="true" /></Link>
            </div>
          </aside>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
