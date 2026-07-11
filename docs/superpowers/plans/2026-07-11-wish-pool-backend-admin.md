# Wish Pool Backend and Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a moderated, account-backed wish pool with private submissions, public approved wishes, idempotent support, admin merge/status controls, and shipped app/skill links.

**Architecture:** Store wishes and supporters in dedicated PostgreSQL tables. Keep public serialization, status rules, similarity, and merge invariants in a focused service; public and admin Fastify routes call that service and reuse the existing Lily web-session and admin-audit boundaries. New wishes fail closed to private `pending` state.

**Tech Stack:** Node.js ESM, Fastify 5, Kysely, PostgreSQL migrations, Zod, existing Lily account sessions and admin audit log, Node assert test scripts.

---

### Task 1: Encode wish invariants in a pure service

**Files:**
- Create: `server/src/services/feature-wishes.js`
- Create: `scripts/test-feature-wishes.mjs`

- [ ] **Step 1: Write the failing service test**

Cover public-state allow-listing, private-field stripping, locale fallback, shipped-link requirements, deterministic similarity, status transitions, and merge supporter de-duplication:

```js
import assert from "node:assert/strict";
import {
  canTransitionWish,
  findSimilarWishes,
  mergeSupporterIds,
  normalizeWishInput,
  serializePublicWish,
  validateWishPublication,
} from "../server/src/services/feature-wishes.js";

const row = {
  id: "wish_invoice",
  submitter_user_id: "usr_private",
  title: "raw private title",
  problem: "private workflow details",
  public_title: "自动整理发票",
  public_title_i18n: { en: "Organize invoices automatically" },
  public_summary: "识别、去重并生成报销表。",
  public_summary_i18n: {},
  public_update: "正在验证票据去重。",
  public_update_i18n: {},
  category: "office",
  status: "building",
  linked_app_ids: [],
  linked_skill_ids: [],
  support_count: "4",
  created_at: "2026-07-11T00:00:00.000Z",
  updated_at: "2026-07-11T00:00:00.000Z",
};

assert.deepEqual(serializePublicWish(row, { locale: "en" }), {
  id: "wish_invoice",
  title: "Organize invoices automatically",
  summary: "识别、去重并生成报销表。",
  update: "正在验证票据去重。",
  originalLocale: "zh",
  category: "office",
  status: "building",
  linkedAppIds: [],
  linkedSkillIds: [],
  supportCount: 4,
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
});
assert.equal(JSON.stringify(serializePublicWish(row)).includes("usr_private"), false);
assert.equal(serializePublicWish({ ...row, status: "pending" }), null);
assert.equal(validateWishPublication({ ...row, status: "shipped" }).code, "WISH_SHIPPED_LINK_REQUIRED");
assert.equal(validateWishPublication({ ...row, status: "shipped", linked_app_ids: ["invoice-app"] }).ok, true);
assert.equal(canTransitionWish("pending", "published"), true);
assert.equal(canTransitionWish("declined", "building"), false);
assert.deepEqual(mergeSupporterIds(["usr_a", "usr_b"], ["usr_b", "usr_c"]), ["usr_a", "usr_b", "usr_c"]);
assert.equal(findSimilarWishes("自动整理报销发票", [{ id: "wish_invoice", public_title: "自动整理发票报销表" }])[0].id, "wish_invoice");
assert.equal(normalizeWishInput({ title: " x ", problem: "short", desiredOutcome: "short" }).ok, false);
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node scripts/test-feature-wishes.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `feature-wishes.js`.

- [ ] **Step 3: Implement the minimal pure service**

Implement exported constants and functions with explicit public field allow-lists:

```js
export const PUBLIC_WISH_STATUSES = new Set(["published", "planned", "building", "shipped"]);
export const WISH_CATEGORIES = new Set(["office", "research", "communication", "data", "creative", "developer", "other"]);

export function normalizeWishInput(input = {}) {
  const value = {
    title: String(input.title || "").trim(),
    problem: String(input.problem || "").trim(),
    desiredOutcome: String(input.desiredOutcome || "").trim(),
    category: WISH_CATEGORIES.has(input.category) ? input.category : "other",
  };
  if (value.title.length < 6 || value.title.length > 160) return { ok: false, code: "WISH_TITLE_INVALID" };
  if (value.problem.length < 12 || value.problem.length > 2000) return { ok: false, code: "WISH_PROBLEM_INVALID" };
  if (value.desiredOutcome.length < 12 || value.desiredOutcome.length > 2000) return { ok: false, code: "WISH_OUTCOME_INVALID" };
  return { ok: true, value };
}
```

Use Unicode word bigrams for deterministic similarity, sort by score descending, and return at most five results with score at least `0.3`. `serializePublicWish()` must return `null` for non-public status and never spread a database row.

- [ ] **Step 4: Run the service test and confirm GREEN**

Run: `node scripts/test-feature-wishes.mjs`

Expected: `feature-wishes: ok`.

- [ ] **Step 5: Commit the service unit**

```bash
git add server/src/services/feature-wishes.js scripts/test-feature-wishes.mjs
git commit -m "feat: define wish pool invariants"
```

### Task 2: Add zero-downtime wish tables

**Files:**
- Create: `server/migrations/023_feature_wishes.sql`
- Modify: `scripts/test-feature-wishes.mjs`

- [ ] **Step 1: Add failing migration-contract assertions**

Read the migration text and assert it creates `feature_wishes`, `feature_wish_supporters`, a unique `(wish_id, user_id)` constraint, public-list and submitter indexes, status checks, and `ON DELETE CASCADE` for supporters.

- [ ] **Step 2: Run the test and confirm RED**

Run: `node scripts/test-feature-wishes.mjs`

Expected: FAIL because `023_feature_wishes.sql` does not exist.

- [ ] **Step 3: Create the additive migration**

Use `CREATE TABLE IF NOT EXISTS`; do not modify existing tables. Store i18n maps and linked IDs as `jsonb NOT NULL DEFAULT '{}'/'[]'`, default status to `pending`, and add:

```sql
check (status in ('pending','reviewing','published','planned','building','shipped','declined','merged')),
check (category in ('office','research','communication','data','creative','developer','other'))
```

Add a self-reference `merged_into_id text references feature_wishes(id) on delete set null` and indexes on `(status, updated_at desc)`, `(category, status, updated_at desc)`, and `(submitter_user_id, created_at desc)`.

- [ ] **Step 4: Run contract test and migration when a database is configured**

Run: `node scripts/test-feature-wishes.mjs`

Expected: PASS.

Run: `npm run server:migrate`

Expected: `[migrate] applied 023_feature_wishes.sql` and `[migrate] done`. If `DATABASE_URL` is unavailable, record the skip and rely on the SQL contract test until integration verification.

- [ ] **Step 5: Commit the migration**

```bash
git add server/migrations/023_feature_wishes.sql scripts/test-feature-wishes.mjs
git commit -m "feat: add moderated wish pool storage"
```

### Task 3: Reuse a strict Web session resolver

**Files:**
- Create: `server/src/services/web-user-session.js`
- Test: `scripts/test-feature-wishes.mjs`

- [ ] **Step 1: Add failing session-result tests**

Test pure `classifyWebSession({ verified, session, now })` cases for invalid token, wrong user, revoked session, expired session, and valid session.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-feature-wishes.mjs`

Expected: FAIL because `classifyWebSession` is missing.

- [ ] **Step 3: Implement strict resolver**

`requireWebUser(request, reply)` reads only `lily_user_session`, calls existing `verifyWebSessionToken`, verifies the stored `user_sessions` row matches user/session IDs and is active, and returns `{ userId, sessionId }`. All failures send `401 { ok:false, code:"USER_LOGIN_REQUIRED" }`.

- [ ] **Step 4: Run test and confirm GREEN**

Run: `node scripts/test-feature-wishes.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the resolver**

```bash
git add server/src/services/web-user-session.js scripts/test-feature-wishes.mjs
git commit -m "refactor: centralize strict web user session checks"
```

### Task 4: Add public and account wish routes

**Files:**
- Create: `server/src/routes/public/wishes.js`
- Modify: `server/src/routes/public.js`
- Modify: `server/src/openapi.js`
- Modify: `scripts/test-feature-wishes.mjs`
- Test: `scripts/test-server-api-docs.mjs`

- [ ] **Step 1: Add failing route-contract assertions**

Assert route source registers:

```text
GET /api/wishes
GET /api/wishes/:id
POST /api/wishes/similar
POST /api/wishes
POST /api/wishes/:id/support
DELETE /api/wishes/:id/support
GET /api/account/wishes
```

Also assert every mutation calls `requireWebUser`, every list uses `serializePublicWish`, and the public route is registered in `public.js`.

- [ ] **Step 2: Run tests and confirm RED**

Run: `node scripts/test-feature-wishes.mjs && node scripts/test-server-api-docs.mjs`

Expected: FAIL because routes and OpenAPI tags do not exist.

- [ ] **Step 3: Implement documented routes**

Use Zod schemas with bounded values. `GET /api/wishes` accepts only public status/category plus `sort=popular|recent`, calculates exact support counts for sorting but returns the approved serializer. `POST /api/wishes` always writes `pending`. Support uses `ON CONFLICT DO NOTHING`; delete is scoped by both `wish_id` and current `user_id`. `/api/account/wishes` returns only the current user's rows and a safe submitter serializer.

Add per-user action buckets on top of the existing global IP limiter: 30 similarity checks per minute, 5 new wishes per hour, and 60 support changes per minute. Exceeding a bucket returns `429 { ok:false, code:"RATE_LIMITED" }`; the limiter key is the verified user ID and never a caller-provided value.

Before `shipped` results are returned, the service must validate linked outcomes. Route schemas include tags and summaries declared in `OPENAPI_TAGS`.

- [ ] **Step 4: Run route and API-doc tests**

Run: `node scripts/test-feature-wishes.mjs && node scripts/test-server-api-docs.mjs`

Expected: both PASS.

- [ ] **Step 5: Commit public routes**

```bash
git add server/src/routes/public/wishes.js server/src/routes/public.js server/src/openapi.js scripts/test-feature-wishes.mjs
git commit -m "feat: expose moderated wish pool APIs"
```

### Task 5: Add audited admin review and merge routes

**Files:**
- Create: `server/src/routes/admin/wishes.js`
- Modify: `server/src/routes/admin.js`
- Modify: `scripts/test-feature-wishes.mjs`

- [ ] **Step 1: Add failing admin-contract tests**

Assert registration of `GET /api/admin/wishes`, `PATCH /api/admin/wishes/:id`, and `POST /api/admin/wishes/:id/merge`; validate that patch rejects invalid transitions and shipped rows without enabled linked output; validate merge is transactional and writes `wish.merge` audit metadata.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-feature-wishes.mjs`

Expected: FAIL because admin routes do not exist.

- [ ] **Step 3: Implement admin routes**

The patch route accepts public title/summary/update plus i18n maps, category, status, submitter note, and linked IDs. Resolve linked app IDs against enabled `workspace_apps` and skill IDs against enabled, catalog-visible `skill_packages`. The merge transaction:

1. reads source and target with row locks;
2. inserts source supporters into target with `ON CONFLICT DO NOTHING`;
3. deletes source supporter rows;
4. marks source `merged` and sets `merged_into_id`;
5. commits before audit logging.

- [ ] **Step 4: Run unit and API documentation tests**

Run: `node scripts/test-feature-wishes.mjs && node scripts/test-server-api-docs.mjs`

Expected: PASS.

- [ ] **Step 5: Commit admin routes**

```bash
git add server/src/routes/admin/wishes.js server/src/routes/admin.js scripts/test-feature-wishes.mjs
git commit -m "feat: add audited wish review workflow"
```

### Task 6: Add the existing-style admin UI

**Files:**
- Create: `web/app/admin/wishes/page.js`
- Create: `web/app/admin/wishes/[id]/page.js`
- Create: `web/components/wish-admin-form.js`
- Modify: `web/app/admin/actions.js`
- Modify: `web/components/admin-shell.js`
- Modify: `web/components/admin-nav.js`
- Modify: `web/lib/i18n.mjs`
- Create: `scripts/test-web-wish-admin.mjs`

- [ ] **Step 1: Write failing source-contract test**

Assert the list loads `/api/admin/wishes`, the detail page loads apps and skills for validated linking, the action posts patch/merge calls, the nav contains `/admin/wishes`, and all three locales define wish-admin labels.

- [ ] **Step 2: Run test and confirm RED**

Run: `node scripts/test-web-wish-admin.mjs`

Expected: FAIL because pages and labels are missing.

- [ ] **Step 3: Implement minimal admin screens**

Reuse `AdminShell`, `AdminDataTable`, `Badge`, `Field`, `SelectField`, and server actions. The list supports query filters through search params. The detail form exposes only approved fields and uses controlled select options. Merge requires explicit browser confirmation and target wish ID.

- [ ] **Step 4: Run admin test and web build**

Run: `node scripts/test-web-wish-admin.mjs && npm run web:build`

Expected: test PASS and Next.js production build succeeds.

- [ ] **Step 5: Commit the admin UI**

```bash
git add web/app/admin/wishes web/components/wish-admin-form.js web/app/admin/actions.js web/components/admin-shell.js web/components/admin-nav.js web/lib/i18n.mjs scripts/test-web-wish-admin.mjs
git commit -m "feat: add wish moderation console"
```

### Task 7: Verify backend/admin phase

- [ ] Run: `node scripts/test-feature-wishes.mjs`
- [ ] Run: `node scripts/test-web-wish-admin.mjs`
- [ ] Run: `node scripts/test-server-api-docs.mjs`
- [ ] Run: `npm run web:build`
- [ ] Run: `npm run test:service`
- [ ] Record whether `npm run server:migrate` was run against a configured database.
- [ ] Confirm `git status --short` contains no unintended files.
