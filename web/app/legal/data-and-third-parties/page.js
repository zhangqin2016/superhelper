import { LegalDocument } from "../../../components/legal-document";
import { getI18n } from "../../../lib/i18n.mjs";
import { legalDocumentFor } from "../../../lib/legal-content.mjs";

export const metadata = {
  title: "Personal Information and Third-Party List",
  description: "Lily Workbench data processing scenarios and third-party service categories.",
  alternates: { canonical: "/legal/data-and-third-parties" },
};

export default async function DataAndThirdPartiesPage() {
  const { locale } = await getI18n();
  return <LegalDocument locale={locale} document={legalDocumentFor(locale, "data")} />;
}
