import "./changelog.css";
import { SiteNav } from "../../components/site-nav";
import { SiteFooter } from "../../components/site-footer";
import { publicApiGet } from "../../lib/public-api";
import { getI18n } from "../../lib/i18n.mjs";
import { catalogCopyFor, formatCount, groupReleases } from "../../lib/site-copy-catalog.mjs";

export const metadata = { title: "Changelog", description: "What each Lily Workbench version brought, newest first.", alternates: { canonical: "/changelog" } };
export const dynamic = "force-dynamic";

const VISIBLE_VERSIONS = 8;
const VISIBLE_HIGHLIGHTS = 4;

function formatDate(value, locale) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const tag = locale === "zh" ? "zh-CN" : locale === "ar" ? "ar-u-nu-latn" : "en-US";
  return new Intl.DateTimeFormat(tag, { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Shanghai" }).format(date);
}

function Entry({ entry, copy, locale, latest }) {
  const shown = entry.highlights.slice(0, VISIBLE_HIGHLIGHTS);
  const rest = entry.highlights.slice(VISIBLE_HIGHLIGHTS);
  return (
    <li className="cl-entry">
      <div className="cl-when">
        <time className="site-num" dateTime={entry.createdAt || undefined}>{formatDate(entry.createdAt, locale)}</time>
      </div>
      <article className="cl-body">
        <div className="cl-heading">
          <h2 className="cl-version site-num">{entry.version}</h2>
          {latest ? <span className="site-chip site-chip--brand">{copy.latest}</span> : null}
          {entry.force ? <span className="site-chip cl-required">{copy.required}</span> : null}
        </div>
        {entry.highlights.length ? (
          <ul className="cl-highlights">{shown.map((line) => <li key={line}>{line}</li>)}</ul>
        ) : <p className="cl-plain">{copy.noNotes}</p>}
        {rest.length ? (
          <details className="cl-more">
            <summary>{formatCount(copy.showAll, entry.highlights.length)}</summary>
            <ul className="cl-highlights">{rest.map((line) => <li key={line}>{line}</li>)}</ul>
          </details>
        ) : null}
        {entry.platforms.length ? (
          <p className="cl-platforms">{entry.platforms.map((platform) => copy.platforms[platform] || platform).join(" · ")}</p>
        ) : null}
      </article>
    </li>
  );
}

export default async function ChangelogPage() {
  const { locale } = await getI18n();
  const copy = catalogCopyFor(locale).changelog;
  const result = await publicApiGet("/api/releases");
  const entries = result.ok ? groupReleases(result.data?.releases) : [];
  const recent = entries.slice(0, VISIBLE_VERSIONS);
  const older = entries.slice(VISIBLE_VERSIONS);
  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="cl-page">
        <header className="site-page-head cl-head">
          <div className="shell cl-shell">
            <p className="site-eyebrow">{copy.eyebrow}</p>
            <h1 className="site-h1">{copy.title}</h1>
            <p className="site-lead cl-lead">{copy.description}</p>
            {copy.notesLanguage && entries.length ? <p className="cl-language">{copy.notesLanguage}</p> : null}
          </div>
        </header>
        <section className="shell cl-shell cl-section">
          {!result.ok ? (
            <div className="cl-state site-card"><h2 className="site-h3">{copy.errorTitle}</h2><p>{copy.errorBody}</p></div>
          ) : !entries.length ? (
            <div className="cl-state site-card"><h2 className="site-h3">{copy.emptyTitle}</h2><p>{copy.emptyBody}</p></div>
          ) : (
            <>
              <ol className="cl-timeline">
                {recent.map((entry, index) => <Entry key={entry.version} entry={entry} copy={copy} locale={locale} latest={index === 0} />)}
              </ol>
              {older.length ? (
                <details className="cl-older">
                  <summary>{formatCount(copy.older, older.length)}</summary>
                  <ol className="cl-timeline">
                    {older.map((entry) => <Entry key={entry.version} entry={entry} copy={copy} locale={locale} latest={false} />)}
                  </ol>
                </details>
              ) : null}
            </>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
