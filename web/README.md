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
NEXT_PUBLIC_API_BASE_URL=https://lilych.lilywb.cn
RELEASE_CDN_BASE_URL=https://qny.lanrensoft.cn
RELEASE_CDN_PREFIX=app/updates
```

Admin access:

- Admin pages only trust the browser login cookie. Do not inject `ADMIN_TOKEN` into the web process.
- Open `/admin/login` and sign in with the configured admin account. The web app stores a validated HttpOnly session cookie.
- The API server must be running before login, otherwise the login page will show an API unavailable error.

Routes:

```text
/             Marketing website
/download     Download page
/pricing      Pricing page
/docs         Documentation
/changelog    Release notes
/admin        Admin dashboard
/admin/login  Admin login
```

Release admin:

- `/admin/releases` can calculate SHA256 and file size from a selected installer file in the browser.
- The download URL is prefilled as `{RELEASE_CDN_BASE_URL}/{RELEASE_CDN_PREFIX}/{platform}/{version}/{filename}`.
- The file still needs to be uploaded to CDN/Qiniu before the release is enabled.

Skill package marketplace:

- Admin `/admin/skill-packages` publishes skill package metadata.
- Enabled skill package entries with package URL and SHA256 are exposed at `/api/skills/registry` by the API server.
- The desktop client can use that registry URL in Settings -> Skills to check, install, update, and enable skills.
