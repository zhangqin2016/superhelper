import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

function Section({ section }) {
  return (
    <section id={section.id} className="legal-section">
      <h2>{section.title}</h2>
      {(section.paragraphs || []).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      {section.bullets?.length ? (
        <ul>
          {section.bullets.map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : null}
      {section.rows?.length ? (
        <div className="legal-table-wrap">
          <table>
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.join("|")}>
                  {row.map((cell, index) => index === 0 ? <th key={cell} scope="row">{cell}</th> : <td key={`${index}-${cell}`}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function LegalDocument({ locale, document }) {
  const rtl = locale === "ar";
  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="legal-page" dir={rtl ? "rtl" : "ltr"}>
        <div className="shell legal-shell">
          <aside className="legal-nav" aria-label={document.labels.contents}>
            <Link href="/legal" className="legal-back"><ArrowLeft size={15} />{document.labels.home}</Link>
            <span>{document.labels.contents}</span>
            <nav>
              {document.sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
            </nav>
          </aside>
          <article className="legal-article">
            <header className="legal-header">
              <p className="legal-eyebrow">{document.eyebrow}</p>
              <h1>{document.title}</h1>
              <p className="legal-summary">{document.summary}</p>
              <p className="legal-updated">{document.labels.updated}: {document.updated}</p>
            </header>
            {document.notice ? <div className="legal-notice">{document.notice}</div> : null}
            {document.sections.map((section) => <Section key={section.id} section={section} />)}
            <div className="legal-contact">
              <div>
                <strong>{document.labels.contact}</strong>
                <span>{document.email}</span>
              </div>
              <a href={`mailto:${document.email}`}><Mail size={17} />{document.labels.email}</a>
            </div>
          </article>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
