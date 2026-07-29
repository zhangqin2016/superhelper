# Lily Website Legal Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete, localized legal center and stable privacy/deletion URLs to the Lily website.

**Architecture:** Keep legal copy in one locale-aware content module and render it through shared article and index components. Public App Router pages remain thin route entry points, while a source contract test prevents missing links and inaccurate absolute claims.

**Tech Stack:** Next.js 16 App Router, React 19, existing Lily i18n utilities, CSS, Node test scripts.

---

### Task 1: Legal Contract

**Files:**
- Create: `scripts/test-web-legal-center.mjs`

- [ ] Write a source contract test for the five routes, footer links, disclosure
  categories, rights channel, company identity, and prohibited absolute claims.
- [ ] Run `node scripts/test-web-legal-center.mjs` and confirm it fails because
  the legal routes do not exist.

### Task 2: Shared Legal Content And Rendering

**Files:**
- Create: `web/lib/legal-content.mjs`
- Create: `web/components/legal-document.js`
- Create: `web/components/legal-index.js`
- Modify: `web/app/globals.css`

- [ ] Add complete `zh`, `en`, and `ar` legal content with stable section IDs.
- [ ] Render headings, paragraphs, lists, disclosure tables, notices, and
  contact actions through shared components.
- [ ] Add restrained responsive article styles and right-to-left support.

### Task 3: Public Routes And Footer

**Files:**
- Create: `web/app/legal/page.js`
- Create: `web/app/privacy/page.js`
- Create: `web/app/terms/page.js`
- Create: `web/app/legal/data-and-third-parties/page.js`
- Create: `web/app/account-deletion/page.js`
- Modify: `web/components/site-footer.js`

- [ ] Add route metadata and canonical URLs.
- [ ] Add privacy, terms, data disclosure, and deletion links to the footer.
- [ ] Run `node scripts/test-web-legal-center.mjs` and confirm it passes.

### Task 4: Verification

**Files:**
- Verify only

- [ ] Run `npm --prefix web run build`.
- [ ] Run `npm run test:unit`.
- [ ] Start the website and inspect `/legal`, `/privacy`, and
  `/account-deletion` at desktop and mobile sizes.
- [ ] Review `git diff --check`, the final diff, and every design requirement.
