# Public Catalog and Wish Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add polished public application, skill, and wish pages that consume existing catalog contracts and the new moderated wish APIs without weakening entitlement or privacy boundaries.

**Architecture:** Fetch catalogs in Next.js server components through a small public API client, normalize API data with pure locale-aware helpers, and isolate interactive wish mutations in client components that use same-origin cookies. Catalog errors render explicit, recoverable states; homepage integration remains optional until the final phase.

**Tech Stack:** Next.js 16 App Router, React 19, existing Tailwind/CSS, Lily public APIs, Node assert source/pure-function tests.

---

### Task 1: Add safe public API and catalog normalization helpers

**Files:**
- Create: `web/lib/public-api.js`
- Create: `web/lib/public-catalog.mjs`
- Create: `scripts/test-web-public-catalog.mjs`

- [ ] **Step 1: Write failing helper tests**

Test `normalizeApps`, `normalizeSkills`, `featuredApps`, `featuredSkills`, locale fallback, `displayInCatalog === false`, and error result classification:

```js
assert.deepEqual(normalizeSkills({ skills: [hidden, englishSkill] }, "en").map((item) => item.id), ["research"]);
assert.equal(normalizeSkills({ skills: [englishSkill] }, "ar")[0].name, englishSkill.name);
assert.equal(featuredApps({ apps: [{ id: "a", featured: true }, { id: "b" }] }).length, 1);
assert.deepEqual(classifyPublicApiResult(null), { ok: false, code: "CATALOG_UNAVAILABLE", data: null });
```

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-web-public-catalog.mjs`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement helpers**

`publicApiGet(path, fallback)` uses `API_BASE_URL || NEXT_PUBLIC_API_BASE_URL || https://lilych.lilywb.cn`, `cache: "no-store"`, an `AbortSignal.timeout(5000)`, and returns a structured `{ ok, status, data, code }`. Catalog normalizers return new allow-listed objects and never mutate responses.

- [ ] **Step 4: Run test and confirm GREEN**

Run: `node scripts/test-web-public-catalog.mjs`

Expected: `web-public-catalog: ok`.

- [ ] **Step 5: Commit**

```bash
git add web/lib/public-api.js web/lib/public-catalog.mjs scripts/test-web-public-catalog.mjs
git commit -m "feat: add safe public catalog helpers"
```

### Task 2: Build application catalog and detail pages

**Files:**
- Create: `web/app/apps/page.js`
- Create: `web/app/apps/[id]/page.js`
- Create: `web/components/public-catalog-shell.js`
- Create: `web/components/app-catalog.js`
- Modify: `web/app/globals.css`
- Modify: `web/lib/i18n.mjs`
- Modify: `scripts/test-web-public-catalog.mjs`

- [ ] **Step 1: Add failing page-contract tests**

Assert `/apps` reads `/api/apps/catalog`, renders only normalized data, links each app to `/apps/[id]`, and the detail page never renders `downloadUrl`, `sha256`, or raw artifact metadata.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-web-public-catalog.mjs`

Expected: FAIL because app pages do not exist.

- [ ] **Step 3: Implement pages and catalog surface**

Use a server-rendered hero and category groups. `AppCatalog` receives normalized app objects. Detail CTA is always “在 Lily 中使用” linking to `/download`; it never calls gated download resolution from the browser. Empty catalog and fetch failure use different messages.

- [ ] **Step 4: Run test and web build**

Run: `node scripts/test-web-public-catalog.mjs && npm run web:build`

Expected: PASS and successful Next build.

- [ ] **Step 5: Commit**

```bash
git add web/app/apps web/components/public-catalog-shell.js web/components/app-catalog.js web/app/globals.css web/lib/i18n.mjs scripts/test-web-public-catalog.mjs
git commit -m "feat: publish the Lily app catalog"
```

### Task 3: Build the skill catalog

**Files:**
- Create: `web/app/skills/page.js`
- Create: `web/components/skill-catalog.js`
- Modify: `web/app/globals.css`
- Modify: `web/lib/i18n.mjs`
- Modify: `scripts/test-web-public-catalog.mjs`

- [ ] **Step 1: Add failing catalog tests**

Assert the page reads `/api/skills/registry`, filters hidden skills, uses i18n maps before base strings, groups by category, and does not foreground ZIP URLs, hashes, or raw capability contracts.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-web-public-catalog.mjs`

Expected: FAIL because skill page is missing.

- [ ] **Step 3: Implement the skill catalog**

Render a calm category-filtered catalog with name, localized description, category label, publisher, and a plain-language risk badge. Every use CTA links to `/download`. No browser-side install behavior is introduced.

- [ ] **Step 4: Run tests and build**

Run: `node scripts/test-web-public-catalog.mjs && npm run web:build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app/skills web/components/skill-catalog.js web/app/globals.css web/lib/i18n.mjs scripts/test-web-public-catalog.mjs
git commit -m "feat: publish the Lily skill catalog"
```

### Task 4: Add public wish normalization and board

**Files:**
- Create: `web/lib/public-wishes.mjs`
- Create: `web/app/wishes/page.js`
- Create: `web/components/wish-board.js`
- Create: `scripts/test-web-wish-pool.mjs`
- Modify: `web/app/globals.css`
- Modify: `web/lib/i18n.mjs`

- [ ] **Step 1: Write failing tests**

Test locale fallback, status-label mapping, safe field allow-listing, sort query construction, and distinct empty/error states. Assert the page loads `GET /api/wishes` and renders `WishBoard` with no submitter data.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-web-wish-pool.mjs`

Expected: FAIL because wish modules do not exist.

- [ ] **Step 3: Implement the server-rendered board**

The page includes hero, tabs for popular/recent/planned/building/shipped, and cards with title, summary, status, update, and shipped app/skill links. Exact support counts stay hidden. Anonymous browsing does not trigger account redirects.

- [ ] **Step 4: Run test and build**

Run: `node scripts/test-web-wish-pool.mjs && npm run web:build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/public-wishes.mjs web/app/wishes/page.js web/components/wish-board.js web/app/globals.css web/lib/i18n.mjs scripts/test-web-wish-pool.mjs
git commit -m "feat: add the public wish board"
```

### Task 5: Add login-preserving support and submission flows

**Files:**
- Create: `web/components/wish-support-button.js`
- Create: `web/components/wish-submit-form.js`
- Create: `web/app/account/wishes/page.js`
- Modify: `web/components/wish-board.js`
- Modify: `web/lib/user-api.js`
- Modify: `scripts/test-web-wish-pool.mjs`

- [ ] **Step 1: Add failing interaction-contract tests**

Assert both mutations use same-origin `/api/wishes` endpoints with credentials, convert `401` to `/account/login?next=/wishes`, preserve draft in `sessionStorage`, call similarity before create, and support existing similar wishes without duplicate submission.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-web-wish-pool.mjs`

Expected: FAIL because interactive components are missing.

- [ ] **Step 3: Implement support and submit components**

`WishSupportButton` is optimistic but rolls back on failure. `WishSubmitForm` keeps all fields on error, validates lengths before request, displays up to five similar wishes, and requires an explicit “仍然创建新愿望” action when similarities exist. The account page uses `userApiGet("/api/account/wishes")` and shows private states and submitter notes.

- [ ] **Step 4: Run tests and build**

Run: `node scripts/test-web-wish-pool.mjs && npm run web:build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/components/wish-support-button.js web/components/wish-submit-form.js web/components/wish-board.js web/app/account/wishes/page.js web/lib/user-api.js scripts/test-web-wish-pool.mjs
git commit -m "feat: close the wish submission loop"
```

### Task 6: Update public navigation and locale coverage

**Files:**
- Modify: `web/components/site-nav.js`
- Modify: `web/components/site-footer.js`
- Modify: `web/lib/i18n.mjs`
- Modify: `scripts/test-web-public-catalog.mjs`
- Modify: `scripts/test-web-wish-pool.mjs`

- [ ] **Step 1: Add failing locale/nav tests**

Assert links to `/apps`, `/skills`, `/wishes`, `/pricing`, `/account`, and `/download`; assert Chinese, English, and Arabic contain catalog/wish labels; assert mobile links close the menu.

- [ ] **Step 2: Run tests and confirm RED**

Run: `node scripts/test-web-public-catalog.mjs && node scripts/test-web-wish-pool.mjs`

Expected: FAIL on missing links/labels.

- [ ] **Step 3: Implement navigation**

Use the existing client nav and language switcher. Preserve fixed-header semantics and add a visible focus style. Footer retains regional ICP behavior and adds public product links only when the footer renders.

- [ ] **Step 4: Run tests and build**

Run: `node scripts/test-web-public-catalog.mjs && node scripts/test-web-wish-pool.mjs && npm run web:build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/components/site-nav.js web/components/site-footer.js web/lib/i18n.mjs scripts/test-web-public-catalog.mjs scripts/test-web-wish-pool.mjs
git commit -m "feat: connect the public Lily catalog"
```

### Task 7: Verify public catalog/wish phase

- [ ] Run: `node scripts/test-web-public-catalog.mjs`
- [ ] Run: `node scripts/test-web-wish-pool.mjs`
- [ ] Run: `npm run web:build`
- [ ] Browse `/apps`, one `/apps/[id]`, `/skills`, `/wishes`, and `/account/wishes` in Chinese, English, and Arabic.
- [ ] Verify catalog failures do not prevent `/download` navigation.
- [ ] Confirm no raw user, artifact, hash, or capability-contract fields appear in HTML.
