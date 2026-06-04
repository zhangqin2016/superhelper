"use client";

import { localeLabels, locales } from "../lib/i18n.mjs";
import { useI18n } from "../lib/use-i18n";

export function LanguageSwitcher({ compact = false, initialLocale }) {
  const { locale, setLocale } = useI18n(initialLocale);

  return (
    <label className={compact ? "language-switcher language-switcher--compact" : "language-switcher"}>
      <span className="sr-only">Language</span>
      <select value={locale} onChange={(event) => setLocale(event.target.value)} aria-label="Language">
        {locales.map((item) => (
          <option key={item} value={item}>
            {compact ? item.toUpperCase() : localeLabels[item]}
          </option>
        ))}
      </select>
    </label>
  );
}
