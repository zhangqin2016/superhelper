import Link from "next/link";
import { ArrowRight, Database, FileCheck2, ShieldCheck, UserRoundX } from "lucide-react";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

const icons = [ShieldCheck, FileCheck2, Database, UserRoundX];

export function LegalIndex({ locale, content }) {
  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="legal-index" dir={locale === "ar" ? "rtl" : "ltr"}>
        <header className="shell legal-index-header">
          <p className="legal-eyebrow">{content.eyebrow}</p>
          <h1>{content.title}</h1>
          <p>{content.summary}</p>
        </header>
        <section className="legal-principles">
          <div className="shell legal-principles-grid">
            {content.principles.map(([title, body]) => (
              <div key={title}>
                <strong>{title}</strong>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="shell legal-index-links">
          {content.items.map((item, index) => {
            const Icon = icons[index];
            return (
              <Link href={item.href} key={item.href}>
                <Icon size={22} />
                <div><h2>{item.title}</h2><p>{item.body}</p></div>
                <ArrowRight className="legal-index-arrow" size={19} />
              </Link>
            );
          })}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
