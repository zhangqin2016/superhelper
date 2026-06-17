# Connector Platform

Lily external systems use one platform contract instead of one-off skills.

## Layers

```text
Natural language
  -> skill decides intent
  -> connector playbook declares actions
  -> policy decides confirmation
  -> connector executes or prepares work
  -> audit/result returns to the same turn
```

## Core Files

- `src/main/connector-protocol.js`: validates connector manifests, action specs,
  playbooks, and redacts secrets.
- `src/main/connector-store.js`: local playbook persistence with public redacted
  views.
- `src/main/mail-accounts.js`: local account persistence. Secrets are encrypted
  with Electron safeStorage when available and are never returned to renderer
  list APIs.
- `src/main/mail-imap-smtp-executor.js`: IMAP/SMTP execution layer. IMAP can
  test/login/search/fetch message envelopes and message text. SMTP send requires explicit
  confirmation at the API boundary.
- `src/main/mail-oauth-executor.js`: Gmail and Microsoft OAuth authorization
  with PKCE and local loopback callback.
- `src/main/mail-oauth-api.js`: Gmail API and Microsoft Graph mail
  search/read/send execution.
- `src/main/connector-bridge.js`: localhost-only bridge used by skills to call
  account actions without receiving credentials.
- `src/main/ipc-connectors.js`: renderer-facing connector and mail-account IPC.
- `resources/skills-catalog/lily-web-system-learning`: learns browser systems
  and generates `web-system-playbook.json` plus a local execution helper.
- `resources/skills-catalog/lily-mail-assistant`: defines the mail connector
  contract and generates mail playbooks.

## Risk Model

| Risk | Meaning | Confirmation |
|---|---|---|
| `read` | search, read, summarize, export non-mutating metadata | `none` allowed |
| `prepare` | draft or fill safe fields without submission | `review` required |
| `submit` | send, create, upload, comment, submit form | `review` or `explicit`; mail send uses `explicit` |
| `destructive` | delete, approve/reject, pay, permission changes, bulk mailbox state changes | `explicit` required |

## Secret Policy

Credentials are never stored in skills, playbooks, prompts, or logs. Playbooks
carry `secretRefs` only. The actual value belongs in the app/keychain/provider
session. Public views must call `redactConnectorSecrets()`.

Agent skills execute connector actions through `connector-bridge.js`. The bridge
binds to `127.0.0.1`, uses a per-process bearer token injected into the agent
environment, and performs all secret decryption inside the Electron main
process. This keeps connector credentials out of model context and generated
files while still allowing natural-language workflows to call real systems.

## Product Route

| Phase | Status | Notes |
|---|---|---|
| Generic connector protocol | Implemented | Manifest/action/playbook schema, risk model, redaction, local playbook store. |
| Mail minimum loop | Implemented | IMAP/SMTP account settings, encrypted secret storage, test/search/read, SMTP explicit-confirm send, and skill bridge script. Summarize/draft are handled by the assistant over fetched structured results. |
| Gmail OAuth | Implemented | OAuth app details are configured locally, authorization uses PKCE loopback, Gmail API supports search/read/send. |
| Microsoft Graph | Implemented | Microsoft 365/Outlook accounts authorize through Graph OAuth and support search/read/send. Tenant/admin consent remains an organization setup concern. |
| Marketplace distribution | Implemented for first-party connectors | Skill packages are in the registry, and workspace apps now support `connector` as a first-class app type/category. Connector account configuration remains local and must not be shipped in skill packages. |
| Web/OA connector | Minimal execution loop implemented | `lily-web-system-learning` emits a connector playbook and copies a local plan-driven executor. The executor validates domain allowlists, action risk, and confirmation before browser execution. Real browser execution requires a Playwright/browser runtime; login remains an interactive browser-session boundary. |
