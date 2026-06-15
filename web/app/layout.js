import "./globals.css";
import { getI18n } from "../lib/i18n.mjs";

export const metadata = {
  title: "Lily Workbench",
  description: "An AI desktop workbench for teams, skill packages, releases, and licensed deployment.",
};

export default async function RootLayout({ children }) {
  const { locale, dir } = await getI18n();
  return (
    <html lang={locale === "zh" ? "zh-CN" : locale} dir={dir}>
      <body>{children}</body>
    </html>
  );
}
