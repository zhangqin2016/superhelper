# Admin Auth Root Cause - 2026-06-03

## Symptom

The web admin login appeared to accept arbitrary input and allowed users to see the admin console.

## Root Cause

The web app defaulted `API_BASE_URL` to `http://localhost:3000`. On the local machine, port 3000 was occupied by Open WebUI, not the Lily server. Open WebUI returned HTTP 200 HTML for `/api/admin/summary`.

The login action only checked `response.ok`, so a 200 HTML page from the wrong service was treated as a valid admin API response. Admin pages also used `safeApiGet` fallbacks, which rendered an empty admin console when API calls failed.

## Fix

- Added strict admin summary response validation in `web/lib/admin-auth-shared.mjs`.
- Updated login action to require a JSON admin summary payload, not just HTTP 200.
- Added `web/proxy.js` to protect `/admin/*` routes before rendering and clear invalid cookies.
- Added `scripts/test-web-admin-auth.mjs` regression coverage.

## Verification

- `node scripts/test-web-admin-auth.mjs`
- `npm --prefix web run build`
- `npm run test:unit`
- Runtime checks:
  - `GET /admin` with no cookie redirects to `/admin/login`.
  - `GET /admin` with an invalid `lily_admin_token` redirects to `/admin/login` and clears the cookie.
  - Browser login with an invalid token stays on `/admin/login` and shows rejection.

## Status

DONE
