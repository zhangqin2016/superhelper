import Link from "next/link";

const nav = [
  ["愿望", "/account/wishes"],
  ["购买", "/account/billing"],
  ["权益", "/account/entitlements"],
  ["订单", "/account/orders"],
  ["企业", "/account/enterprise"],
  ["账号", "/account/settings"],
];

export default function AccountLayout({ children }) {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-4 sm:justify-between sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2 text-base font-semibold sm:text-lg">
            <img className="h-8 w-8 rounded-lg object-contain" src="/brand/icon.png" alt="" width="32" height="32" />
            <span className="sm:hidden">Lily</span>
            <span className="hidden sm:inline">Lily Workbench</span>
          </Link>
          <nav className="ml-auto flex min-w-0 gap-1 overflow-x-auto text-[13px] sm:gap-2 sm:text-sm">
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
