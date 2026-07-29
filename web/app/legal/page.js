import { LegalIndex } from "../../components/legal-index";
import { getI18n } from "../../lib/i18n.mjs";
import { legalContentFor } from "../../lib/legal-content.mjs";

export const metadata = {
  title: "Legal and Privacy Center",
  description: "Lily Workbench privacy, terms, data disclosures, and account deletion information.",
  alternates: { canonical: "/legal" },
};

export default async function LegalPage() {
  const { locale } = await getI18n();
  return <LegalIndex locale={locale} content={legalContentFor(locale).index} />;
}
