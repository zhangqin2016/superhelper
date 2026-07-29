import { LegalDocument } from "../../components/legal-document";
import { getI18n } from "../../lib/i18n.mjs";
import { legalDocumentFor } from "../../lib/legal-content.mjs";

export const metadata = {
  title: "Account and Data Deletion",
  description: "How to delete Lily Workbench local data or request account and server-side data deletion.",
  alternates: { canonical: "/account-deletion" },
};

export default async function AccountDeletionPage() {
  const { locale } = await getI18n();
  return <LegalDocument locale={locale} document={legalDocumentFor(locale, "deletion")} />;
}
