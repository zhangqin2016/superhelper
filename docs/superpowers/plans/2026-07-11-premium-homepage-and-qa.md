# Premium Homepage and End-to-End QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the demo-like homepage with the approved premium consumer design, integrate real catalogs and wish progress, and verify the complete website across breakpoints, locales, failures, accessibility, and reduced motion.

**Architecture:** Keep the homepage server-rendered and split only major responsibilities into focused components. Fetch featured catalogs and wishes independently with fail-open omission; the hero, download CTA, and core value proposition never depend on those services. Use a sanitized screenshot from a clean Lily profile as the product visual, with responsive image fallbacks.

**Tech Stack:** Next.js 16, React 19, Tailwind/global CSS, optimized WebP asset, existing public API helpers, Node assert tests, browser QA.

---

### Task 1: Lock homepage content and fail-open contracts

**Files:**
- Create: `scripts/test-premium-homepage.mjs`
- Create: `web/lib/homepage-content.mjs`

- [ ] **Step 1: Write failing content tests**

Assert all three locales define hero, problem, workflows, trust, catalog, wishes, and final CTA copy; assert the Chinese hero equals “你的项目，终于有人记得。”; assert no copy promises complete offline operation or that files are never sent; assert catalog failure returns empty optional sections while core content remains present.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-premium-homepage.mjs`

Expected: FAIL because homepage content helper does not exist.

- [ ] **Step 3: Implement locale-aware content selection**

Export `homeContentFor(t)` and `buildHomeOptionalSections({ appsResult, skillsResult, wishesResult, locale })`. Optional sections return normalized arrays with fixed maxima 3/6/3 and never throw.

- [ ] **Step 4: Run test and confirm GREEN**

Run: `node scripts/test-premium-homepage.mjs`

Expected: `premium-homepage: ok`.

- [ ] **Step 5: Commit**

```bash
git add web/lib/homepage-content.mjs scripts/test-premium-homepage.mjs
git commit -m "test: lock premium homepage contracts"
```

### Task 2: Capture and prepare a truthful product visual

**Files:**
- Create: `web/public/product/lily-workbench-home.webp`
- Create: `web/public/product/lily-workbench-home-fallback.svg`
- Modify: `scripts/test-premium-homepage.mjs`

- [ ] **Step 1: Add failing asset assertions**

Assert the WebP and fallback exist, the WebP is below 500 KB, and the SVG contains no base64, external URL, placeholder path, or user-identifying text.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-premium-homepage.mjs`

Expected: FAIL because product assets are absent.

- [ ] **Step 3: Capture from a clean profile and optimize**

Launch Lily with a temporary clean user-data directory and create only synthetic project names/files. Capture the Lily window itself, not the desktop. Verify the image contains no real chat history, file paths, phone numbers, email addresses, tokens, or device IDs. Crop to the application window and convert to WebP at approximately 1600px width and quality 82. Create a simple branded fallback SVG that says “Lily Workbench” and shows neutral window chrome without inventing capabilities.

- [ ] **Step 4: Verify asset contract**

Run: `node scripts/test-premium-homepage.mjs`

Expected: PASS.

- [ ] **Step 5: Commit assets**

```bash
git add web/public/product scripts/test-premium-homepage.mjs
git commit -m "feat: add a sanitized Lily product visual"
```

### Task 3: Build the new homepage composition

**Files:**
- Create: `web/components/home/home-hero.js`
- Create: `web/components/home/home-workflows.js`
- Create: `web/components/home/featured-catalog.js`
- Create: `web/components/home/home-trust.js`
- Create: `web/components/home/wish-pool-preview.js`
- Create: `web/components/home/home-final-cta.js`
- Rewrite: `web/app/page.js`
- Modify: `web/lib/i18n.mjs`
- Modify: `scripts/test-premium-homepage.mjs`

- [ ] **Step 1: Add failing composition tests**

Assert the page imports exactly the five major home components, fetches apps/skills/wishes independently, keeps `/download` as the primary CTA, uses `#product-demo` for the secondary CTA, and never imports the old `ProductWindow` component.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-premium-homepage.mjs`

Expected: FAIL against the current page.

- [ ] **Step 3: Implement the server homepage**

`HomePage` calls `getI18n`, starts three safe public fetches in parallel, normalizes the results, and composes:

```jsx
<SiteNav initialLocale={locale} />
<main>
  <HomeHero copy={copy.hero} />
  <HomeWorkflows copy={copy.workflows} />
  <FeaturedCatalog apps={apps} skills={skills} copy={copy.catalog} />
  <HomeTrust copy={copy.trust} />
  <WishPoolPreview wishes={wishes} copy={copy.wishes} />
  <HomeFinalCta copy={copy.finalCta} />
</main>
<SiteFooter />
```

Optional components return `null` only when their data is unavailable or empty. The hero and workflow content are unconditional.

- [ ] **Step 4: Run test and build**

Run: `node scripts/test-premium-homepage.mjs && npm run web:build`

Expected: PASS.

- [ ] **Step 5: Commit composition**

```bash
git add web/app/page.js web/components/home web/lib/i18n.mjs scripts/test-premium-homepage.mjs
git commit -m "feat: rebuild the Lily homepage around real work"
```

### Task 4: Replace demo styling with the approved visual system

**Files:**
- Modify: `web/app/globals.css`
- Modify: `web/tailwind.config.js`
- Modify: `web/app/layout.js`
- Modify: `web/components/site-nav.js`
- Modify: `scripts/test-premium-homepage.mjs`

- [ ] **Step 1: Add failing visual-token tests**

Assert tokens `--lily-ink:#121827`, `--lily-blue:#586ce8`, `--lily-lavender:#dce3ff`, `--lily-pearl:#f6f8fd`, and `--lily-success:#35a47a`; assert a `prefers-reduced-motion: reduce` block; assert removed infinite animation names and old `.kinetic-hero`, `.workflow-brain`, `.expert-card` styles are absent.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-premium-homepage.mjs`

Expected: FAIL against current CSS.

- [ ] **Step 3: Implement the visual system**

Use a 1200px shell, generous vertical rhythm, white/pearl sections, 18–24px surface radii, restrained shadows, visible focus rings, and responsive typography. Animation is one-shot opacity/translate only; disable transforms and transitions under reduced motion. Preserve admin, account, docs, and form selectors while removing only unused old-home selectors.

- [ ] **Step 4: Run test and build**

Run: `node scripts/test-premium-homepage.mjs && npm run web:build`

Expected: PASS.

- [ ] **Step 5: Commit styling**

```bash
git add web/app/globals.css web/tailwind.config.js web/app/layout.js web/components/site-nav.js scripts/test-premium-homepage.mjs
git commit -m "style: apply the premium Lily visual system"
```

### Task 5: Update metadata and remove obsolete demo component

**Files:**
- Delete: `web/components/product-window.js`
- Modify: `web/app/layout.js`
- Modify: `web/app/apps/page.js`
- Modify: `web/app/apps/[id]/page.js`
- Modify: `web/app/skills/page.js`
- Modify: `web/app/wishes/page.js`
- Modify: `scripts/test-premium-homepage.mjs`

- [ ] **Step 1: Add failing metadata tests**

Assert the home metadata describes a personal AI desktop workbench; every public page exports distinct metadata; canonical URLs are relative-safe; and no file imports `product-window.js`.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-premium-homepage.mjs`

Expected: FAIL until metadata is updated.

- [ ] **Step 3: Implement metadata and delete obsolete component**

Use accurate product descriptions without unsupported claims. Keep locale-neutral base metadata in layout and page-specific metadata in each route. Delete the old fake product window only after `rg "product-window" web` shows no imports.

- [ ] **Step 4: Run test and build**

Run: `node scripts/test-premium-homepage.mjs && npm run web:build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app web/components/product-window.js scripts/test-premium-homepage.mjs
git commit -m "chore: remove the demo homepage surface"
```

### Task 6: Browser QA and iterative visual fixes

**Files:**
- Modify only files implicated by observed defects.

- [ ] Start the web server on a free local port with the production build.
- [ ] Capture desktop screenshots at 1440×1000 and 1280×800 for `/`, `/apps`, `/skills`, `/wishes`.
- [ ] Capture mobile screenshots at 390×844 for the same routes.
- [ ] Verify Chinese, English, and Arabic; explicitly inspect RTL alignment and menu order.
- [ ] Verify keyboard navigation, visible focus, mobile menu, download CTA, account login return, wish submit/support, and reduced motion.
- [ ] Simulate catalog and wish API failures; confirm the homepage download path still works and page copy remains readable.
- [ ] Fix each observed issue surgically and rerun the relevant automated test plus web build.
- [ ] Save final screenshots under `.lily-work/website-qa/` only; do not commit QA screenshots unless the user asks.

### Task 7: Full verification

- [ ] Run: `node scripts/test-feature-wishes.mjs`
- [ ] Run: `node scripts/test-web-wish-admin.mjs`
- [ ] Run: `node scripts/test-web-public-catalog.mjs`
- [ ] Run: `node scripts/test-web-wish-pool.mjs`
- [ ] Run: `node scripts/test-premium-homepage.mjs`
- [ ] Run: `node scripts/test-server-api-docs.mjs`
- [ ] Run: `npm run web:build`
- [ ] Run: `npm run test:service`
- [ ] Run the migration against the configured server database before deployment.
- [ ] Confirm `git diff --check` and `git status --short` show only intentional changes.
