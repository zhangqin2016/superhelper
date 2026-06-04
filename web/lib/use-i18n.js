"use client";

import { useEffect, useState } from "react";
import { dictionaries, dirForLocale, normalizeLocale } from "./i18n.mjs";

function cookieLocale() {
  if (typeof document === "undefined") return "zh";
  const value = document.cookie
    .split("; ")
    .find((item) => item.startsWith("lily_locale="))
    ?.split("=")[1];
  return normalizeLocale(value);
}

export function useI18n(initialLocale) {
  const [locale, setLocaleState] = useState(() => normalizeLocale(initialLocale || cookieLocale()));
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : locale;
    document.documentElement.dir = dirForLocale(locale);
  }, [locale]);
  return {
    locale,
    dir: dirForLocale(locale),
    t: dictionaries[locale],
    setLocale(nextLocale) {
      const normalized = normalizeLocale(nextLocale);
      document.cookie = `lily_locale=${normalized}; path=/; max-age=31536000; samesite=lax`;
      setLocaleState(normalized);
      window.location.reload();
    },
  };
}
