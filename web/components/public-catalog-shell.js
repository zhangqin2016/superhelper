import "../app/apps/catalog.css";
import { SiteNav } from "./site-nav";
import { SiteFooter } from "./site-footer";

// Shared frame for the public catalog pages (/apps, /skills, /wishes): the
// site page head (eyebrow, one headline, a lead) over a quiet paper surface.
export function PublicCatalogShell({ locale, eyebrow, title, description, children }) {
  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="pc-page">
        <header className="site-page-head pc-head">
          <div className="shell">
            {eyebrow ? <p className="site-eyebrow">{eyebrow}</p> : null}
            <h1 className="site-h1">{title}</h1>
            {description ? <p className="site-lead pc-lead">{description}</p> : null}
          </div>
        </header>
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
