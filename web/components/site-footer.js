import { headers } from "next/headers";
import Link from "next/link";
import { getI18n } from "../lib/i18n.mjs";
import { legalFooterFor } from "../lib/legal-content.mjs";

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

// Footer headings and the few labels the nav dictionary has no key for.
const FOOTER = {
  zh: { tagline: "为真实工作而生的 AI 桌面工作台。", product: "产品", support: "支持", legal: "法律", changelog: "更新日志", contact: "联系我们", rights: "保留所有权利。" },
  en: { tagline: "The AI desktop workbench built for real work.", product: "Product", support: "Support", legal: "Legal", changelog: "Changelog", contact: "Contact", rights: "All rights reserved." },
  ar: { tagline: "منضدة عمل ذكية على سطح المكتب مصممة للعمل الحقيقي.", product: "المنتج", support: "الدعم", legal: "قانوني", changelog: "سجل التغييرات", contact: "تواصل معنا", rights: "جميع الحقوق محفوظة." },
};

export async function SiteFooter() {
  const headerStore = await headers();
  const showChinaFiling = shouldShowChinaFiling(headerStore);
  const { locale, t } = await getI18n();
  const legal = legalFooterFor(locale);
  const f = FOOTER[locale] || FOOTER.zh;

  return (
    <footer className="site-footer">
      <div className="shell site-footer-grid">
        <div className="site-footer-brand">
          <Link href="/" className="site-footer-logo">
            <img src="/brand/icon.png" alt="" width="28" height="28" />
            <span>Lily Workbench</span>
          </Link>
          <p>{f.tagline}</p>
        </div>
        <nav className="site-footer-col" aria-label={f.product}>
          <p className="site-footer-heading">{f.product}</p>
          <Link href="/download">{t.nav.download}</Link>
          <Link href="/apps">{t.nav.apps}</Link>
          <Link href="/skills">{t.nav.skills}</Link>
          <Link href="/enterprise">{t.nav.enterprise}</Link>
          <Link href="/pricing">{t.nav.pricing}</Link>
          <Link href="/changelog">{f.changelog}</Link>
        </nav>
        <nav className="site-footer-col" aria-label={f.support}>
          <p className="site-footer-heading">{f.support}</p>
          <Link href="/docs">{t.nav.docs}</Link>
          <Link href="/contact">{f.contact}</Link>
          <Link href="/wishes">{t.nav.wishes}</Link>
          <Link href="/account">{t.nav.account}</Link>
        </nav>
        <nav className="site-footer-col" aria-label={f.legal}>
          <p className="site-footer-heading">{f.legal}</p>
          <Link href="/privacy">{legal.privacy}</Link>
          <Link href="/terms">{legal.terms}</Link>
          <Link href="/legal/data-and-third-parties">{legal.data}</Link>
          <Link href="/account-deletion">{legal.deletion}</Link>
        </nav>
      </div>
      <div className="shell site-footer-bottom">
        <span>© {new Date().getFullYear()} {COMPANY_NAME} · {f.rights}</span>
        {showChinaFiling ? (
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">{ICP_NUMBER}</a>
        ) : null}
      </div>
    </footer>
  );
}
