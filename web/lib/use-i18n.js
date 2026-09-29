"use client";

import { createContext, createElement, useContext, useEffect, useState } from "react";
import { dictionaries, dirForLocale, normalizeLocale } from "./i18n.mjs";

function cookieLocale() {
  if (typeof document === "undefined") return "zh";
  const value = document.cookie
    .split("; ")
    .find((item) => item.startsWith("lily_locale="))
    ?.split("=")[1];
  return normalizeLocale(value);
}

// The locale the SERVER rendered with (the root layout reads the cookie there).
// Without it a client component's first render guessed: the server has no
// document, so it rendered zh, while the browser read lily_locale=en — every
// en/ar page with a translated client component failed hydration (React #418).
const LocaleContext = createContext(null);

export function LocaleProvider({ locale, children }) {
  return createElement(LocaleContext.Provider, { value: normalizeLocale(locale) }, children);
}

export function useI18n(initialLocale) {
  const serverLocale = useContext(LocaleContext);
  const [locale, setLocaleState] = useState(() => normalizeLocale(initialLocale || serverLocale || cookieLocale()));
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
