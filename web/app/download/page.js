import { SiteNav } from "../../components/site-nav";
import { SiteFooter } from "../../components/site-footer";
import { DownloadChooser } from "../../components/site/download-chooser";
import { DownloadGuide } from "../../components/site/download-guide";
import { getI18n } from "../../lib/i18n.mjs";
import { publicApiGet } from "../../lib/public-api";
import { DOWNLOAD_PLATFORMS, VERIFY_COMMANDS, downloadCopyFor, releaseView } from "../../lib/site-copy-download.mjs";
import "./download.css";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { locale } = await getI18n();
  const { meta } = downloadCopyFor(locale);
  return { title: meta.title, description: meta.description, alternates: { canonical: "/download" } };
}

// The same public endpoint the page always used: what a fresh install would be offered.
async function latest(platform) {
  const result = await publicApiGet(`/api/releases/latest?platform=${platform}&version=0.0.0`, { timeoutMs: 3000 });
  return result.ok ? result.data : null;
}

export default async function DownloadPage() {
  const { locale } = await getI18n();
  const copy = downloadCopyFor(locale);
  const [list, ...latests] = await Promise.all([
    // Only for the publish date of the offered version; optional.
    publicApiGet("/api/releases", { timeoutMs: 3000 }).then((result) => (result.ok && Array.isArray(result.data?.releases) ? result.data.releases : [])),
    ...DOWNLOAD_PLATFORMS.map(latest),
  ]);
  // Every string is formatted here, on the server, so the client never re-formats (no hydration drift).
  const items = DOWNLOAD_PLATFORMS.map((platform, index) => releaseView(platform, latests[index], list, locale));

  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="dl-page">
        <div className="shell">
          <header className="site-page-head dl-head">
            <p className="site-eyebrow">{copy.head.eyebrow}</p>
            <h1 className="site-h1">{copy.head.title}</h1>
            <p className="site-lead dl-head-lead">{copy.head.lead}</p>
          </header>
          <DownloadChooser items={items} copy={copy} commands={VERIFY_COMMANDS} />
          <DownloadGuide copy={copy} />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
