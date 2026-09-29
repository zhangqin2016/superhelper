"use client";

import Link from "next/link";
import { useI18n } from "../../../lib/use-i18n";
import { enterpriseConsoleText } from "../../../lib/enterprise-console-i18n.mjs";

export default function EnterpriseError({ reset }) {
  const { locale } = useI18n();
  const T = enterpriseConsoleText(locale).errorPage;
  return (
    <section role="alert" className="space-y-4 rounded-lg border border-slate-200 bg-white p-6">
      <h1 className="text-xl font-semibold">{T.title}</h1>
      <p className="text-sm leading-6 text-slate-600">{T.body}</p>
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" onClick={reset} className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">{T.retry}</button>
        <Link href="/account/login" className="text-sm underline">{T.switchAccount}</Link>
      </div>
    </section>
  );
}
