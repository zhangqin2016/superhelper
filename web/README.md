# Lily Workbench Web

Next.js website and admin console for Lily Workbench.

## Setup

```bash
cd web
npm install
npm run dev
```

Environment:

```env
NEXT_PUBLIC_API_BASE_URL=https://lily.lanrensoft.cn
ADMIN_TOKEN=change-me
RELEASE_CDN_BASE_URL=https://qny.lanrensoft.cn
RELEASE_CDN_PREFIX=app/updates
```

Admin access:

- If `ADMIN_TOKEN` is set in the web process, admin pages use it as the server-side API token.
- If `ADMIN_TOKEN` is not set, open `/admin/login` and enter the API admin token. The web app stores it in an HttpOnly cookie after validating it against the server API.
- The API server must be running before login, otherwise the login page will show an API unavailable error.

Routes:

```text
/             Marketing website
/download     Download page
/pricing      Pricing page
/docs         Documentation
/changelog    Release notes
/admin        Admin dashboard
/admin/login  Admin token login
```

Release admin:

- `/admin/releases` can calculate SHA256 and file size from a selected installer file in the browser.
- The download URL is prefilled as `{RELEASE_CDN_BASE_URL}/{RELEASE_CDN_PREFIX}/{platform}/{version}/{filename}`.
- The file still needs to be uploaded to CDN/Qiniu before the release is enabled.

Plugin marketplace:

- Admin `/admin/plugins` can publish plugin metadata.
- Enabled `type=skill` entries with package URL and SHA256 are exposed at `/api/plugins/registry` by the API server.
- The desktop client can use that registry URL in Settings -> Skills to check, install, update, and enable skills.
