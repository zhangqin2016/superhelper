import { SiteNav } from "./site-nav";
import { SiteFooter } from "./site-footer";

export function PublicCatalogShell({ locale, eyebrow, title, description, children }) {
  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="public-page">
        <header className="catalog-hero">
          <div className="shell">
            <p className="catalog-eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
            <p className="catalog-lead">{description}</p>
          </div>
        </header>
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
