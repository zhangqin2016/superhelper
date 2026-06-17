import Link from "next/link";
import { Download, ShieldCheck } from "lucide-react";
import { SiteNav } from "../../components/site-nav";
import { safeApiGet } from "../../lib/api";
import { getI18n } from "../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

async function release(platform) {
  return safeApiGet(`/api/releases/latest?platform=${platform}&version=0.0.0`, { hasUpdate: false });
}

function sizeLabel(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "";
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default async function DownloadPage() {
  const { locale, t } = await getI18n();
  const releases = await Promise.all([
    release("darwin-arm64"),
    release("darwin-x64"),
    release("win32-x64"),
  ]);
  const chipCopy = t.pages.downloadPlatforms;
  const cards = [
    ["macOS Apple Silicon", "darwin-arm64", chipCopy.macArm, releases[0]],
    ["macOS Intel", "darwin-x64", chipCopy.macIntel, releases[1]],
    ["Windows x64", "win32-x64", "Windows 10/11 · Installer", releases[2]],
  ];

  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="min-h-screen bg-slate-50 pt-28">
        <div className="shell py-16">
          <h1 className="text-5xl font-semibold text-slate-950">{t.pages.downloadTitle}</h1>
          <p className="mt-4 max-w-2xl text-lg text-slate-500">{t.pages.downloadDesc}</p>
          <div className="mt-10 grid gap-5 lg:grid-cols-3">
            {cards.map(([title, platform, file, item]) => (
              <div key={platform} className="table-card p-6">
                <h2 className="text-2xl font-semibold">{title}</h2>
                <p className="mt-2 font-mono text-sm text-slate-500">{platform} {item.version ? `· ${item.version}` : ""}</p>
                <Link
                  href={item.url || "/contact"}
                  className={`mt-6 inline-flex items-center gap-2 rounded-lg px-5 py-3 font-semibold text-white ${item.url ? "bg-brand" : "bg-slate-400"}`}
                >
                  <Download size={18} />
                  {item.url ? t.nav.download : t.nav.contact}
                </Link>
                <div className="mt-5 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">
                  <div>{file}</div>
                  {item.sizeBytes ? <div className="mt-2">Size {sizeLabel(item.sizeBytes)}</div> : null}
                  <div className="mt-2 flex items-center gap-2">
                    <ShieldCheck size={16} className="text-brand" />
                    {item.sha256 ? `SHA256 ${item.sha256}` : "SHA256 will be loaded from release metadata."}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
