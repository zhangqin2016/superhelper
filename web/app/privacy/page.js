import { LegalDocument } from "../../components/legal-document";
import { getI18n } from "../../lib/i18n.mjs";
import { legalDocumentFor } from "../../lib/legal-content.mjs";

export const metadata = {
  title: "Privacy Policy",
  description: "How Lily Workbench processes and protects personal information.",
  alternates: { canonical: "/privacy" },
};

export default async function PrivacyPage() {
  const { locale } = await getI18n();
  return <LegalDocument locale={locale} document={legalDocumentFor(locale, "privacy")} />;
}
