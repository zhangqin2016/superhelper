#!/usr/bin/env node
// Public pricing and download pages (2026-09-30 redesign).
//
// Intent, not surface:
// - Pricing shows only what the server said. With no products (production
//   today), a failed fetch, or a regional 403 the page must never produce a
//   price — it falls back to an honest panel. At most one product is featured.
// - Prices format by currency and locale with whole amounts kept whole.
// - Download recommends the visitor's platform from what a browser can tell,
//   and every release field degrades on its own when data is missing.
// - zh / en / ar copy have exactly the same keys, and the zh page carries no
//   stray English labels (it used to show "Personal / 1 seat", "Size",
//   "Installer" on the Chinese page).
// Run: node scripts/test-site-pricing-download.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  formatCount,
  formatPrice,
  groupProducts,
  featuredProductId,
  pricingCopy,
  pricingState,
  productView,
} from "../web/lib/site-copy-pricing.mjs";
import {
  DOWNLOAD_PLATFORMS,
  detectPlatform,
  downloadCopy,
  fileExtension,
  formatBytes,
  formatReleaseDate,
  orderForRecommendation,
  releaseView,
  shortSha,
} from "../web/lib/site-copy-download.mjs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// --- copy shape -----------------------------------------------------------------
function shape(value) {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]));
  return typeof value;
}
function strings(value, prefix = "") {
  if (typeof value === "string") return [[prefix, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${prefix}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, nested]) => strings(nested, prefix ? `${prefix}.${key}` : key));
  return [];
}
for (const [name, copy] of [["pricing", pricingCopy], ["download", downloadCopy]]) {
  assert.deepEqual(Object.keys(copy).sort(), ["ar", "en", "zh"], `${name} copy has zh/en/ar`);
  for (const locale of ["en", "ar"]) {
    assert.deepEqual(shape(copy[locale]), shape(copy.zh), `${name} ${locale} copy has the same keys and shape as zh`);
  }
  for (const locale of ["en", "ar"]) {
    const han = strings(copy[locale]).filter(([, text]) => /[㐀-鿿]/.test(text));
    assert.deepEqual(han, [], `${name} ${locale} copy carries no Chinese`);
  }
  // zh: Latin words allowed only as proper nouns, units and file types.
  const ALLOWED = new Set(["Lily", "macOS", "Mac", "Windows", "Apple", "Intel", "M", "token", "Token", "SHA256", "Python", "LibreOffice", "Office", "PDF", "OCR", "PowerShell", "MB", "GB"]);
  const stray = strings(copy.zh)
    .filter(([key]) => !/(^|\.)href$/.test(key))
    .flatMap(([key, text]) => (text.replace(/\{\w+\}/g, "").match(/[A-Za-z][A-Za-z0-9]*/g) || []).filter((word) => !ALLOWED.has(word)).map((word) => `${key}: ${word}`));
  assert.deepEqual(stray, [], `${name} zh copy has no stray English`);
}
for (const banned of ["Personal", "seat", "Desktop client", "Size", "Installer", "Recommended"]) {
  assert.ok(!strings(pricingCopy.zh).some(([, t]) => t.includes(banned)) && !strings(downloadCopy.zh).some(([, t]) => t.includes(banned)), `zh copy has no "${banned}"`);
}

// --- price formatting -----------------------------------------------------------
assert.equal(formatPrice(2900, "CNY", "zh"), "¥29");
assert.equal(formatPrice(2990, "CNY", "zh"), "¥29.90");
assert.equal(formatPrice(2900, "CNY", "en"), "¥29");
assert.equal(formatPrice(1999, "USD", "en"), "$19.99");
assert.match(formatPrice(2900, "CNY", "ar"), /29/, "ar keeps Latin digits");
assert.doesNotMatch(formatPrice(2900, "CNY", "ar"), /[٠-٩]/, "no Arabic-Indic digits in prices");
assert.equal(formatPrice(2900, "bogus", "zh"), "¥29", "an invalid currency code falls back to CNY, never throws");
assert.equal(formatPrice("x", "CNY", "zh"), "¥0");
assert.equal(formatCount(1000000, "zh"), "100万");
assert.equal(formatCount(1000000, "en"), "1M");
assert.equal(formatCount(500, "en"), "500");

// --- product grouping and state -----------------------------------------------
const products = [
  { id: "tok_s", name: "对话额度 · 小", priceCents: 990, currency: "CNY", resourceType: "token", unitAmount: 1000000, grantExpiresDays: 365, metadata: {} },
  { id: "img_10", name: "图片 10 次", priceCents: 1900, currency: "CNY", resourceType: "image_generation", unitAmount: 10, metadata: { featured: true } },
  { id: "vip_m", name: "月度会员", priceCents: 4900, currency: "CNY", resourceType: "membership", durationSeconds: 30 * 86400, metadata: { featured: true } },
  { id: "odd", name: "其他", priceCents: 100, currency: "CNY", resourceType: "something_new", unitAmount: 5, metadata: {} },
  { id: "", name: "broken", priceCents: 100 },
  { id: "neg", name: "negative", priceCents: -5 },
];
const groups = groupProducts(products);
assert.deepEqual(groups.map((g) => g.key), ["membership", "token", "image_generation", "other"], "fixed group order, empty groups dropped, unknown types in other");
assert.equal(groups.flatMap((g) => g.items).length, 4, "malformed products are dropped");
assert.equal(featuredProductId(products), "img_10", "the first marked product is the one featured");

const ok = pricingState({ ok: true, status: 200, data: { products, paymentProviders: [{ id: "alipay" }] } }, "zh");
assert.equal(ok.status, "products");
assert.equal(ok.purchasable, true);
const allItems = ok.groups.flatMap((g) => g.items);
assert.equal(allItems.filter((item) => item.featured).length, 1, "at most one product is highlighted");
const tok = allItems.find((item) => item.id === "tok_s");
assert.equal(tok.price, "¥9.90");
assert.equal(tok.unit, "100万 token 对话额度");
assert.equal(tok.validity, "有效期 365 天");
assert.equal(allItems.find((item) => item.id === "vip_m").validity, "会员 30 天");
assert.equal(productView(products[0], "en").unit, "1M tokens of chat");

const noProvider = pricingState({ ok: true, status: 200, data: { products, paymentProviders: [], fakePaymentsEnabled: false } }, "zh");
assert.equal(noProvider.purchasable, false, "products without a live payment method are shown but not sold");

for (const [label, result, expected] of [
  ["no products (production today)", { ok: true, status: 200, data: { products: [], paymentProviders: [] } }, "empty"],
  ["only malformed products", { ok: true, status: 200, data: { products: [{ id: "", name: "" }] } }, "empty"],
  ["regional 403", { ok: false, status: 403, code: "REGION_FEATURE_DISABLED", data: null }, "region"],
  ["timeout", { ok: false, status: 0, code: "CATALOG_TIMEOUT", data: null }, "unavailable"],
  ["server error", { ok: false, status: 500, code: "CATALOG_UNAVAILABLE", data: null }, "unavailable"],
  ["nothing at all", undefined, "unavailable"],
]) {
  const state = pricingState(result, "zh");
  assert.equal(state.status, expected, label);
  assert.deepEqual(state.groups, [], `${label}: no prices are produced`);
  assert.equal(state.purchasable, false, `${label}: nothing is purchasable`);
}

// The fallback copy never invents a number: no digits and no currency sign.
for (const locale of ["zh", "en", "ar"]) {
  const c = pricingCopy[locale];
  for (const text of [c.personal.price, c.personal.priceNote, ...c.personal.points, c.packs.emptyTitle, c.packs.emptyDesc, c.packs.regionDesc, c.packs.unavailableDesc]) {
    assert.doesNotMatch(text, /[0-9¥$€]/, `${locale} fallback copy states no amount: ${text}`);
  }
}

// --- download data --------------------------------------------------------------
const sha = "a".repeat(10) + "0123456789abcdef".repeat(3) + "b".repeat(6);
assert.equal(sha.length, 64);
assert.equal(shortSha(sha), `${"a".repeat(10)}…${"b".repeat(6)}`);
assert.equal(formatBytes(0), "");
assert.equal(formatBytes(191234567, "en"), "182.4 MB");
assert.equal(formatBytes(3 * 1024 ** 3, "en"), "3 GB");
assert.equal(fileExtension("https://cdn.example.com/Lily%20Workbench-0.1.189-arm64.dmg"), ".dmg");
assert.equal(fileExtension("not a url"), "");
assert.equal(formatReleaseDate("2026-09-28T02:00:00Z", "zh"), "2026年9月28日");
assert.equal(formatReleaseDate("2026-09-28T02:00:00Z", "en"), "September 28, 2026");
assert.equal(formatReleaseDate("garbage", "en"), "");

const full = releaseView("darwin-arm64", { url: "https://cdn.example.com/Lily-0.1.189-arm64.dmg", version: "0.1.189", sha256: sha.toUpperCase(), sizeBytes: 191234567 }, [{ platform: "darwin-arm64", version: "0.1.189", createdAt: "2026-09-28T02:00:00Z" }, { platform: "win32-x64", version: "0.1.189", createdAt: "2020-01-01T00:00:00Z" }], "zh");
assert.equal(full.available, true);
assert.equal(full.sha, sha, "sha normalised to lower case");
assert.equal(full.released, "2026年9月28日", "publish date from the same platform and version");
assert.equal(full.ext, ".dmg");
const missing = releaseView("win32-x64", { hasUpdate: false }, [], "zh");
assert.deepEqual([missing.available, missing.version, missing.size, missing.sha, missing.released], [false, "", "", "", ""], "no release: every field empty");
assert.equal(releaseView("win32-x64", null, null, "en").available, false, "a failed fetch is just unavailable");
assert.equal(releaseView("win32-x64", { url: "javascript:alert(1)", version: "1" }, [], "en").available, false, "only http(s) download links");
assert.equal(releaseView("darwin-x64", { url: "https://x.example/a.dmg", sha256: "not-a-sha" }, [], "en").sha, "", "a malformed checksum is not shown");

// --- OS detection -------------------------------------------------------------
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
assert.deepEqual(detectPlatform({ uaPlatform: "macOS", architecture: "arm", userAgent: MAC_UA }), { kind: "mac", platform: "darwin-arm64", certain: true });
assert.deepEqual(detectPlatform({ uaPlatform: "macOS", architecture: "x86", userAgent: MAC_UA }), { kind: "mac", platform: "darwin-x64", certain: true });
assert.deepEqual(detectPlatform({ userAgent: MAC_UA, gpuRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro)" }), { kind: "mac", platform: "darwin-arm64", certain: true });
assert.deepEqual(detectPlatform({ userAgent: MAC_UA, gpuRenderer: "Intel(R) Iris(TM) Plus Graphics" }), { kind: "mac", platform: "darwin-x64", certain: true });
assert.deepEqual(detectPlatform({ userAgent: MAC_UA, gpuRenderer: "Apple GPU" }), { kind: "mac", platform: "darwin-arm64", certain: false }, "Safari: Apple silicon, flagged uncertain");
assert.deepEqual(detectPlatform({ userAgent: MAC_UA, maxTouchPoints: 5 }).kind, "mobile", "an iPad claiming Macintosh is not a Mac");
assert.deepEqual(detectPlatform({ uaPlatform: "Windows", userAgent: WIN_UA }), { kind: "windows", platform: "win32-x64", certain: true });
assert.equal(detectPlatform({ userAgent: WIN_UA }).platform, "win32-x64");
assert.equal(detectPlatform({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" }).kind, "mobile");
assert.equal(detectPlatform({ userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile" }).kind, "mobile");
assert.equal(detectPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }).kind, "other");
assert.deepEqual(detectPlatform({}), { kind: "unknown", platform: null, certain: false });

const views = DOWNLOAD_PLATFORMS.map((platform) => ({ platform }));
const rec = orderForRecommendation(views, "win32-x64");
assert.equal(rec.featured.platform, "win32-x64");
assert.deepEqual(rec.others.map((v) => v.platform), ["darwin-arm64", "darwin-x64"], "the rest keep the page order");
assert.equal(orderForRecommendation(views, null).others.length, 3, "no detection: everything listed, nothing featured");

// --- wiring ---------------------------------------------------------------------
const pricingPage = read("web/app/pricing/page.js");
assert.match(pricingPage, /publicApiGet\("\/api\/billing\/products", \{ timeoutMs: \d+ \}\)/, "pricing reads real products with a short timeout");
assert.match(pricingPage, /import "\.\/pricing\.css"/);
assert.match(pricingPage, /generateMetadata/);
const downloadPage = read("web/app/download/page.js");
assert.match(downloadPage, /\/api\/releases\/latest\?platform=\$\{platform\}&version=0\.0\.0/, "download keeps its release source");
assert.match(downloadPage, /import "\.\/download\.css"/);
const chooser = read("web/components/site/download-chooser.js");
assert.match(chooser, /^"use client";/);
assert.match(chooser, /useState\(null\)/, "the first client render matches the server (nothing recommended)");
assert.match(chooser, /useEffect\(/, "detection only after hydration");
assert.match(read("web/components/site/download-sha.js"), /<details/, "the full checksum sits in a <details>");
assert.match(read("web/components/site/pricing-packs.js"), /href="\/account\/billing"/, "buy goes to the signed-in purchase page");
for (const file of ["web/app/pricing/pricing.css", "web/app/download/download.css"]) {
  const css = read(file);
  const hex = css.match(/#[0-9a-f]{3,8}\b/gi) || [];
  assert.deepEqual(hex, [], `${file} uses tokens, not raw colors`);
  assert.doesNotMatch(css, /indigo|teal/i, `${file} has one accent`);
  assert.doesNotMatch(css, /margin-left|margin-right|padding-left|padding-right|text-align:\s*(left|right)/, `${file} uses logical properties for RTL`);
}

console.log("site pricing/download: ok");
