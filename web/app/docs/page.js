import "./docs.css";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SiteNav } from "../../components/site-nav";
import { SiteFooter } from "../../components/site-footer";
import { getI18n } from "../../lib/i18n.mjs";
import { docsCopyFor } from "../../lib/site-copy-docs.mjs";
import { DocsToc } from "./docs-toc";

export async function generateMetadata() {
  const { locale } = await getI18n();
  const copy = docsCopyFor(locale);
  return { title: copy.meta.title, description: copy.meta.description, alternates: { canonical: "/docs" } };
}

function Block({ block }) {
  if (block.type === "sub") return <h3 className="hd-sub">{block.text}</h3>;
  if (block.type === "p") return <p className="hd-p">{block.text}</p>;
  if (block.type === "note") return <p className="hd-note">{block.text}</p>;
  if (block.type === "steps") {
    return <ol className="hd-steps">{block.items.map((item) => <li key={item}>{item}</li>)}</ol>;
  }
  if (block.type === "list") {
    return <ul className="hd-list">{block.items.map((item) => <li key={item}>{item}</li>)}</ul>;
  }
  if (block.type === "faq") {
    return (
      <div className="hd-faq">
        {block.items.map(([question, answer]) => (
          <details key={question} className="hd-faq-item">
            <summary>{question}</summary>
            <p>{answer}</p>
          </details>
        ))}
      </div>
    );
  }
  return null;
}

export default async function DocsPage() {
  const { locale } = await getI18n();
  const copy = docsCopyFor(locale);
  const nav = copy.sections.map(({ id, title }) => ({ id, title }));

  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="hd-page">
        <header className="site-page-head hd-head">
          <div className="shell">
            <p className="site-eyebrow">{copy.eyebrow}</p>
            <h1 className="site-h1">{copy.title}</h1>
            <p className="site-lead hd-lead">{copy.lead}</p>
          </div>
        </header>
        <div className="shell hd-layout">
          <DocsToc items={nav} label={copy.navLabel} mobileLabel={copy.mobileNav} heading={copy.onThisPage} />
          <article className="hd-article">
            {copy.sections.map((section, index) => (
              <section key={section.id} id={section.id} className="hd-section" aria-labelledby={`${section.id}-title`}>
                <p className="hd-index site-num">{String(index + 1).padStart(2, "0")}</p>
                <h2 id={`${section.id}-title`} className="hd-title">{section.title}</h2>
                <p className="hd-summary">{section.summary}</p>
                {section.blocks.map((block, blockIndex) => <Block key={`${section.id}-${blockIndex}`} block={block} />)}
                {section.links.length ? (
                  <div className="hd-links">
                    {section.links.map((link) => (
                      <Link key={link.href} href={link.href} className="hd-link">
                        {link.label}
                        <ArrowUpRight size={15} aria-hidden="true" />
                      </Link>
                    ))}
                  </div>
                ) : null}
              </section>
            ))}
          </article>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
