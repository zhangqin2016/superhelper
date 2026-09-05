# Enterprise account and Token pool closure

**Goal:** Fix and deploy the existing enterprise flow, then verify a dedicated production acceptance organization through the UI and a real employee gateway request.

**Architecture:** Preserve platform-funded organization grants, owner/admin member management, personal-first consumption and explicit organization authorization. Repair the web/API boundary and session flow; do not introduce a second wallet or give company administrators unlimited minting rights.

**Authorization:** User requested all repairs, deployment, online enterprise/account creation and employee consumption. Use a clearly named acceptance organization and a small test pool. Preserve the existing customer organization and unrelated working-tree changes.

## Execution

- [x] Reproduce response-envelope, redirect, credentials-display and role issues with executable page/action tests.
- [x] Unwrap organization responses on admin and account pages; return the authenticated membership role; display action errors and successful operations. Show issued credentials on the successful detail page.
- [x] Add enterprise password login and first-password-change web flow using existing password/session primitives; preserve SMS login. Reject disabled or initial-password accounts from enterprise operations until changed.
- [x] Verify platform grant configuration, owner pool visibility, member quota editing and usage counts. Keep resource types separate and explain member quota semantics accurately.
- [x] Run unit/page/action checks, a production web build, and isolated-schema integration tests for create → login → change → provision → grant → employee consume, including authorization and insufficient balance.
- [x] Review the bounded diff; build an artifact containing only server/web/deploy sources; upload to Qiniu and deploy on the current 101 host with previous images retained for rollback.
- [x] Verify health, the original organization's detail page, and production UI create/login/provision/pool/usage. Use a real low-cost employee request and reconcile grants, ledger and usage. Record IDs and non-secret evidence in a report: `docs/enterprise-closure-acceptance-2026-09-05.md`.

## Success criteria

No false missing-organization screen; no swallowed navigation; initial credentials visible once; browser owner can change initial password and manage employees; pool is visible and employee usage debits it; cross-organization/member management is denied. Never claim an API-only check is UI acceptance. Do not commit passwords, cookies or provider secrets.
