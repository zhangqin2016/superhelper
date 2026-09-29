import Link from "next/link";
import { getLocale } from "../../lib/i18n.mjs";

// The account area's own nav, in the reader's language (it was hardcoded
// Chinese, so an en/ar page opened under a Chinese menu).
const NAV = [
  ["/account/wishes", { zh: "愿望", en: "Wishes", ar: "الأمنيات" }],
  ["/account/billing", { zh: "购买", en: "Buy", ar: "شراء" }],
  ["/account/entitlements", { zh: "权益", en: "Entitlements", ar: "الاستحقاقات" }],
  ["/account/orders", { zh: "订单", en: "Orders", ar: "الطلبات" }],
  ["/account/bills", { zh: "账单", en: "Statement", ar: "الكشف" }],
  ["/account/enterprise", { zh: "企业", en: "Organizations", ar: "المؤسسات" }],
  ["/account/settings", { zh: "账号", en: "Account", ar: "الحساب" }],
];

export default async function AccountLayout({ children }) {
  const locale = await getLocale();
  const nav = NAV.map(([href, labels]) => [labels[locale] || labels.zh, href]);
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-4 sm:justify-between sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2 text-base font-semibold sm:text-lg">
            <img className="h-8 w-8 rounded-lg object-contain" src="/brand/icon.png" alt="" width="32" height="32" />
            <span className="sm:hidden">Lily</span>
            <span className="hidden sm:inline">Lily Workbench</span>
          </Link>
          <nav className="ms-auto flex min-w-0 gap-1 overflow-x-auto text-[13px] sm:gap-2 sm:text-sm">
            {nav.map(([label, href]) => (
              <Link key={href} href={href} className="shrink-0 rounded-lg px-2 py-2 text-slate-600 hover:bg-slate-100 hover:text-slate-950 sm:px-3">
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-5 py-6 sm:px-6 sm:py-8">{children}</div>
    </main>
  );
}
