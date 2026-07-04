# Admin Web Env Token Bypass

Date: 2026-06-05

## Symptom

Opening the old transition-domain admin URL without an admin login still rendered the admin UI.

## Root Cause

The API layer correctly rejected unauthenticated admin requests, but the Next.js web layer received `ADMIN_TOKEN` through Docker environment variables. `web/proxy.js` and `web/lib/api.js` used `process.env.ADMIN_TOKEN` as a fallback credential, so every browser request was effectively authenticated by the web server itself.

This conflated two different trust boundaries:

- API service secret: server-to-server credential.
- Browser login state: per-user cookie/session credential.

## Fix

- Removed `process.env.ADMIN_TOKEN` fallback from web route guard and server-side admin API helper.
- Added `adminCredentialHeaders()` so the web layer only builds credentials from request cookies.
- Removed `ADMIN_TOKEN` from all web service Docker compose environments.
- Updated Web README to stop recommending `ADMIN_TOKEN` for the web process.
- Added regression assertions in `scripts/test-web-admin-auth.mjs`.

## Verification

- `node scripts/test-web-admin-auth.mjs`
- `npm --prefix web run build`
- Production no-cookie checks:
  - `/admin` returns `307` to `/admin/login`.
  - `/admin/releases` returns `307` to `/admin/login`.
  - `/admin/login` returns `200`.
  - `/api/admin/health` returns `401` without credentials.
