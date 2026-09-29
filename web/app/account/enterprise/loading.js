import { getI18n } from "../../../lib/i18n.mjs";
import { enterpriseConsoleText } from "../../../lib/enterprise-console-i18n.mjs";

export default async function EnterpriseLoading() {
  const { locale } = await getI18n();
  const T = enterpriseConsoleText(locale).common;
  return (
    <div role="status" aria-busy="true" className="space-y-4">
      <span className="sr-only">{T.loading}</span>
      <div className="h-7 w-48 animate-pulse rounded bg-slate-200" />
      <div className="h-24 animate-pulse rounded-lg bg-white" />
      <div className="h-48 animate-pulse rounded-lg bg-white" />
    </div>
  );
}
