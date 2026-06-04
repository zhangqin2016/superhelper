# Contact Form Server Action Deploy Mismatch

Date: 2026-06-04

## Symptom

After a hot deployment, `https://lily.lanrensoft.cn/contact` could show a browser-level "This page couldn't load" state or the contact form could fail.

## Root Cause

The public contact form used a Next Server Action through `useActionState`. Server Action IDs are tied to the exact Next build. During deployment, a user can keep an older page open while the server starts serving the newer build. Submitting that stale form sends an old action ID, and Next logs:

```text
Failed to find Server Action "...". This request might be from an older or newer deployment.
```

This is an architectural mismatch for a public lead form because the endpoint should remain stable across deployments.

## Fix

The public contact form now uses client-side `fetch("/api/contact-requests")` instead of a Server Action. The API remains stable across deployments. The server also keeps `/api/contact` as a compatibility alias.

## Verification

- `npm --prefix web run build`
- `npm --prefix server run smoke`
- Online `/contact` HTML no longer contains `$ACTION` markers.
- Online `POST /api/contact-requests` returns `201`.
- Deployed images:
  - `lily-workbench-api:0.1.6-contact-client-fix`
  - `lily-workbench-web:0.1.6-contact-client-fix`
