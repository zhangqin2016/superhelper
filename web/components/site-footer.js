import { headers } from "next/headers";
import Link from "next/link";
import { getI18n } from "../lib/i18n.mjs";

const ICP_NUMBER = "京ICP备2026001588号-2";
const COMPANY_NAME = "北京科瑞普投艺术科技有限公司";

function headerValue(headerStore, names) {
  for (const name of names) {
    const value = String(headerStore.get(name) || "").trim();
    if (value) return value.split(",")[0].trim();
  }
  return "";
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function isChinaTimezone(value) {
  return [
    "asia/shanghai",
    "asia/chongqing",
    "asia/harbin",
    "asia/urumqi",
    "asia/hong_kong",
    "asia/macau",
    "asia/taipei",
  ].includes(normalize(value));
}

function shouldShowChinaFiling(headerStore) {
  const region = normalize(headerValue(headerStore, ["x-lily-region", "x-client-region"]));
  if (["cn", "china", "domestic"].includes(region)) return true;
  if (["uae", "ae", "are", "overseas"].includes(region)) return false;

  const host = normalize(headerValue(headerStore, ["x-forwarded-host", "host", ":authority"])).split(":")[0];
  if (host === "lilyxinjiapo.lilywb.cn" || host === "lilyuae.lilywb.cn") return false;

  const country = normalize(headerValue(headerStore, [
    "cf-ipcountry",
    "x-vercel-ip-country",
    "x-country-code",
    "x-client-country",
  ]));
  if (["cn", "chn", "china"].includes(country)) return true;
  if (country) return false;

  const timezone = headerValue(headerStore, ["x-lily-timezone", "x-client-timezone", "sec-ch-timezone"]);
  if (isChinaTimezone(timezone)) return true;
  if (timezone.includes("/")) return false;

  const language = normalize(headerValue(headerStore, ["accept-language"]));
  return language.startsWith("zh");
}

export async function SiteFooter() {
  const headerStore = await headers();
  const showChinaFiling = shouldShowChinaFiling(headerStore);
  const { t } = await getI18n();

  return (
    <footer className="site-footer">
      <div className="shell site-footer-inner">
        <nav className="site-footer-links" aria-label={t.nav.open}>
          <Link href="/apps">{t.nav.apps}</Link>
          <Link href="/skills">{t.nav.skills}</Link>
          <Link href="/wishes">{t.nav.wishes}</Link>
          <Link href="/pricing">{t.nav.pricing}</Link>
          <Link href="/download">{t.nav.download}</Link>
        </nav>
        {showChinaFiling ? (
          <div className="site-footer-filing">
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
              {ICP_NUMBER}
            </a>
            <span>{COMPANY_NAME}</span>
          </div>
        ) : null}
      </div>
    </footer>
  );
}
