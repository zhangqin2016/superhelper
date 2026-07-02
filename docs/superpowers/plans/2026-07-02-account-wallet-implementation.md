# Account Wallet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the account, wallet, website purchase, and client entitlement system in testable phases without breaking existing enterprise license activation.

**Architecture:** Personal accounts are separate from enterprise licenses. The server owns SMS login, user sessions, wallet grants, ledger entries, payment callbacks, and entitlement checks; Electron stores only account tokens and syncs entitlements; the website owns user purchase UX. Existing license activation remains a parallel entitlement path.

**Tech Stack:** Fastify + Kysely/Postgres server, Electron main/preload/renderer client, Next.js website, existing script-based Node tests.

---

### Phase 1: Account Login And Free Entitlements

**Files:**
- Create: `server/migrations/022_account_wallet.sql`
- Create: `server/src/services/account-auth.js`
- Create: `server/src/services/wallet.js`
- Create: `server/src/services/sms-provider-aliyun.js`
- Create: `server/src/routes/public/auth.js`
- Create: `server/src/routes/public/account.js`
- Modify: `server/src/routes/public.js`
- Modify: `server/src/config.js`
- Modify: `src/main/service-client.js`
- Create: `src/main/account-manager.js`
- Modify: `src/main/ipc-handlers.js`
- Modify: `src/preload.js`
- Test: `scripts/test-account-auth.mjs`

- [ ] **Step 1: Write failing account-auth tests**

Run: `node scripts/test-account-auth.mjs`
Expected before implementation: FAIL because `server/src/services/account-auth.js` is missing.

- [ ] **Step 2: Implement account-auth pure helpers**

Implement phone normalization, SMS code hashing, access token signing/verification, refresh token hashing, and SMS limit bucket evaluation.

- [ ] **Step 3: Run account-auth tests**

Run: `node scripts/test-account-auth.mjs`
Expected: PASS.

- [ ] **Step 4: Add wallet grant helpers and tests**

Extend `scripts/test-account-auth.mjs` to cover signup grants and entitlement summary. Implement `server/src/services/wallet.js`.

- [ ] **Step 5: Add migration and route registration**

Add account tables and register `/api/auth/*` plus `/api/account/*` public routes.

- [ ] **Step 6: Add Electron account manager plumbing**

Add main-process storage and IPC for account status, login, logout, entitlement refresh, and billing link creation. Keep renderer UI for a later focused UI task.

- [ ] **Step 7: Verify**

Run:

```bash
node scripts/test-account-auth.mjs
node scripts/test-server-api-docs.mjs
node scripts/test-license-update.mjs
```

### Phase 2: Website Account Purchase

**Files:**
- Create: `web/app/account/login/page.js`
- Create: `web/app/account/billing/page.js`
- Create: `web/app/account/orders/page.js`
- Create: `web/app/account/entitlements/page.js`
- Create: `web/app/account/actions.js`
- Create: `web/components/account-login-form.js`
- Create: `web/components/billing-products.js`
- Modify: `web/lib/api.js` or create `web/lib/user-api.js`
- Create: server billing/product routes and admin product configuration routes.

- [ ] Implement only after Phase 1 is verified.

- [ ] **Step 1: Build top-level website account shell**

Create `/account/login`, `/account/billing`, `/account/orders`, `/account/entitlements`, and `/account/settings`. The first visible account page after login must show current entitlements and available products, not a marketing hero.

- [ ] **Step 2: Keep user auth separate from admin auth**

Use `lily_user_session` for website users. Do not reuse `lily_admin_session`, `ADMIN_TOKEN`, or admin route guards.

- [ ] **Step 3: Wire website purchase to server products**

Render product groups from server data: membership, token packs, image packs, video packs. No hard-coded prices in React components.

- [ ] **Step 4: Wire client purchase button**

Electron creates `/api/account/billing-link`, opens the returned website URL, then polls entitlements after focus returns.

### Phase 3: Payment Providers

**Files:**
- Create: `server/src/services/billing-provider-alipay.js`
- Create: `server/src/services/billing-provider-wechat.js`
- Create: `server/src/routes/public/billing.js`

- [ ] Implement only after website purchase pages can create pending orders against fake providers in tests.

### Phase 4: Gateway Entitlement Enforcement

**Files:**
- Modify: `server/src/services/model-gateway.js`
- Modify: `server/src/services/media-gateway.js`
- Create: `server/src/services/feature-pricing.js`

- [ ] Implement model token deduction first, then image/video unit deduction.

### Phase 5: Renderer UI

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/license-update-settings.js`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`

- [ ] Add account status, login form, entitlement display, purchase link, and refresh button after backend and main-process IPC are verified.

### Phase 6: Complete Closed-Loop Acceptance

**Files:**
- Add E2E or integration scripts under `scripts/test-account-wallet-*.mjs`
- Add focused renderer tests under existing renderer test conventions

- [ ] **Step 1: User loop**

Verify: SMS login -> free entitlement grant -> client entitlement display -> website purchase -> payment callback -> client refresh -> gateway usage -> ledger deduction -> website entitlement history.

- [ ] **Step 2: Operator loop**

Verify: admin changes product price/free counts -> website reflects new values -> client reflects new product summary without app rebuild.

- [ ] **Step 3: Safety loop**

Verify: SMS high-risk request does not call provider, payment amount mismatch does not grant entitlement, insufficient balance does not call model/media upstream, duplicate usage event does not double charge.

- [ ] **Step 4: UI loop**

Verify desktop and mobile website pages render without overlap; Electron account page shows logged-out, logged-in, syncing, failed, enterprise-license-priority, and insufficient-entitlement states.

- [ ] **Step 5: Regression loop**

Verify existing activation-code license flow still passes `scripts/test-license-update.mjs`, and existing admin auth still passes `scripts/test-web-admin-auth.mjs`.
