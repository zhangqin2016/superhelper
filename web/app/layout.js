import "./globals.css";
import { getI18n } from "../lib/i18n.mjs";

export const metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://lilywb.cn"),
  title: { default: "Lily Workbench", template: "%s · Lily Workbench" },
  description: "A personal AI desktop workbench that keeps project files, context, skills, and outcomes together.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Lily Workbench",
    description: "A personal AI desktop workbench for turning scattered project material into finished work.",
    type: "website",
  },
};

export default async function RootLayout({ children }) {
  const { locale, dir } = await getI18n();
  return (
    <html lang={locale === "zh" ? "zh-CN" : locale} dir={dir}>
      <body>{children}</body>
    </html>
  );
}
