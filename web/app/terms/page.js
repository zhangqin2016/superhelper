import { LegalDocument } from "../../components/legal-document";
import { getI18n } from "../../lib/i18n.mjs";
import { legalDocumentFor } from "../../lib/legal-content.mjs";

export const metadata = {
  title: "Terms of Service",
  description: "Terms governing the use of Lily Workbench and related services.",
  alternates: { canonical: "/terms" },
};

export default async function TermsPage() {
  const { locale } = await getI18n();
  return <LegalDocument locale={locale} document={legalDocumentFor(locale, "terms")} />;
}
