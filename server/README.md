# Lily Workbench Server

Lightweight API for license activation, device registration, usage reporting,
release metadata, plugin metadata, and admin dashboards.

## Setup

```bash
cd server
npm install
cp .env.example .env
npm run migrate
npm run integration
npm run dev
```

Required:

```env
DATABASE_URL=postgres://user:pass@host:5432/lily_workbench
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me
ADMIN_TOKEN=change-me
SESSION_SECRET=change-me-at-least-32-chars
```

For production license signing, set:

```env
LICENSE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----..."
ALLOW_UNSIGNED_LICENSES=false
```

## API

Public:

```text
POST /api/devices/register
POST /api/licenses/activate
POST /api/licenses/verify
POST /api/usage/report
POST /api/plugins/events
GET  /api/releases/latest
GET  /api/releases
GET  /api/plugins
GET  /api/plugins/registry
```

`/api/plugins/registry` emits the existing desktop client's skill registry format.
Only enabled `type=skill` entries with both package URL and SHA256 are installable.
`/api/plugins/events` records install, update, uninstall, enable, and disable
actions so operations can be monitored without exposing chat content or model
API keys.

Admin:

```text
POST /api/admin/login
GET  /api/admin/summary
GET  /api/admin/licenses
GET  /api/admin/licenses/:id
POST /api/admin/licenses
PATCH /api/admin/licenses/:id
GET  /api/admin/devices
GET  /api/admin/usage
GET  /api/admin/releases
POST /api/admin/releases
GET  /api/admin/plugins
POST /api/admin/plugins
GET  /api/admin/audit-logs
```

Integration verification:

```bash
DATABASE_URL=postgres://user:pass@host:5432/lily_workbench \
ADMIN_TOKEN=change-me \
ALLOW_UNSIGNED_LICENSES=true \
npm run integration
```

## Desktop client connection

The desktop app no longer lets end users configure the service URL in the UI.
Set `LILY_SERVICE_API_BASE_URL` at build/runtime, or ship a non-empty built-in
service URL in `src/main/service-client.js`.

After the service URL is configured:

- Activation uses `POST /api/licenses/activate`.
- Update checks prefer `GET /api/releases/latest`.
- The skill market uses `GET /api/plugins/registry`.
- Skill operations report to `POST /api/plugins/events`.
- Usage reports use `POST /api/usage/report`.
- Startup registers the device with `POST /api/devices/register`.

If the service URL is empty, the client keeps using the static Qiniu update
manifest, offline signed activation codes, and the bundled skill catalog. This
is only a fallback; production builds should include a real service URL.

## Deployment

Minimal PM2 deployment:

```bash
cd server
npm ci --omit=dev
npm run migrate
pm2 start src/index.js --name lily-workbench-api
```

Minimal Docker image:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "src/index.js"]
```

Put Nginx/Caddy in front for HTTPS. Keep installer files and plugin packages on
Qiniu; the API stores only metadata and hashes.
