# Enterprise Organizations

Date: 2026-08-03

Enterprise org support: orgs, members, org quota pools, per-member quotas, and
platform-admin governance. Full design: `docs/enterprise-organizations-design.md`.

## Why this shape

- The system was designed around INDIVIDUAL users (personal wallet_grants /
  usage_events). Enterprises needed a first-class org entity without breaking
  that: every new column is nullable / `add column if not exists`, personal
  grants keep `organization_id IS NULL`, and the personal consumption path is
  byte-for-byte unchanged.
- Consumption order is **personal first, then org pool for the WHOLE request**
  (no mixed debits) — `selectGrantsForConsumption` is a pure function that
  returns no partial debits on failure, so mixing would require changing its
  signature (violates the "keep the pure selector untouched" rule).

## Key invariants (do not break)

1. `wallet_grants.organization_id IS NULL` == personal grant. `fetchUserGrants`
   filters `organization_id IS NULL`; org grants are only reached via
   `consumeEntitlement({ organizationId })`.
2. Org grant rows reuse `wallet_grants` whose `user_id` is NOT NULL FK ->
   users. **Org grant `user_id` = the org's first active OWNER id** (see
   `routes/admin/enterprise.js` adjust-grants). `wallet_ledger.user_id` is
   ALWAYS the actual consuming member.
3. Per-member quota lives on `organization_members.quota` (units, null = no
   cap), NOT on the grant. It limits a single request against the org pool.
4. Org-context on consumption flows through the **`x-lily-organization-id`**
   request header (model-gateway.js / media-gateway.js). Header absent = personal
   path unchanged (fail-open). Header present but user not an active member of
   an active org = 403 ORG_* (fail-closed, no bypass).
5. Enterprise API auth is DUAL: web session cookie (browser) **or** Bearer
   account access token (desktop client). See `routes/public/enterprise.js`
   preHandler.
6. Platform admin governance (`/api/admin/enterprise/*`) = switch/quota/audit
   ONLY. Membership and roles stay with org owner/admin.

## Where things live

| Surface | Location |
|---|---|
| Org API | `server/src/routes/public/enterprise.js` |
| Admin governance API | `server/src/routes/admin/enterprise.js` |
| Pure logic | `server/src/services/enterprise.js` |
| Consumption | `server/src/services/wallet.js` (`fetchUserGrants`/`fetchOrgGrants`/`resolveOrgForConsumption`/`consumeEntitlement`) |
| Migration | `server/migrations/028_enterprise_organizations.sql` |
| Tests | `scripts/test-enterprise-orgs.mjs` (pure, no DB) |
| Desktop client | `src/main/{service-client,account-manager}.js`, `src/main/runtime/opencode-model-config.js`, `src/renderer/modules/account-settings.js`, `src/main/ipc-handlers.js`, `src/preload.js` |
| Web org workbench | `web/app/account/enterprise/` (5 pages + actions) |
| Web admin governance | `web/app/admin/enterprise/` (list + detail + actions) |

## Notes / gotchas

- 2026-09-05 closure: detail endpoints return `{ ok, organization }`; web pages must unwrap it. Public detail includes the caller's membership role. Next server-action redirects are control flow and must escape error catches. Same-page account issuance/reset returns credential rows to the action form so a mounted page can display each batch.
- Enterprise-issued password accounts can sign in at the overseas enterprise workbench; personal purchasing restrictions remain. First login is blocked from enterprise/gateway operations until password change. Password reset revokes existing sessions, and account-backed gateways check live user/session state; license/trial/static authentication paths remain available.
- Enterprise pool grants remain platform-funded. Member quota means a **single debit limit**, not a cumulative employee budget. Display spendable Token separately from other resource types and exclude expired/future/disabled grants. Grant selection locks rows during debit; idempotent retries serialize before receipt lookup.
- Regression: `scripts/test-enterprise-web-flow.mjs` executes pages/actions with boundary stubs; `server/scripts/admin-enterprise-create-integration.mjs` uses real migrations in an isolated schema, role/reset/session checks, concurrent wallet debits, and actual gateway HTTP against a local upstream. Production UI acceptance remains a separate step.

- Enterprise API returns `{ ok: ... }` style responses; errors use `{ ok: false,
  code }` with 401/403/404/409. Gateway consumption errors keep the gateway's
  `{ error: { type } }` shape (402 payment_required / 403 org_forbidden).
- `routes/public/enterprise.js` validates session liveness against
  `user_sessions` (revoked/expired -> 401) for BOTH auth surfaces.
- `POST /api/enterprise/organizations/:id/grants` (self-recharge) is a
  SECOND-PHASE endpoint; this phase only supports platform-admin transfers
  (`/api/admin/enterprise/.../grants`, source_type = admin_adjustment).
- Add-member by `phoneE164` requires the user to ALREADY exist (returns
  404 USER_NOT_FOUND). We deliberately do NOT auto-provision ghost accounts;
  the design doc's "create user on add" wording was adjusted to match.
- `npm` is not on the default PATH in this dev shell; use
  `~/.nvm/versions/node/v20.11.1/bin` (web needs Node >= 20.9; system node 16
  breaks `next dev`).
