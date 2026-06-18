---
name: lily-web-system-learning
description: Use when the user wants Lily to learn a web/OA/ERP/CRM/admin system and turn it into a reusable workspace skill for natural-language operations. Covers read-only automatic exploration, page/action mapping, domain allowlists, credential safety, high-risk confirmation, and creating a reviewed skill draft.
---

# Lily Web System Learning

Use this skill when the user wants Lily to learn or automate a browser-based system such as OA, ERP, CRM, finance, HR, support portals, admin dashboards, vendor portals, or internal tools.

## Product Contract

The goal is not free-form clicking. The goal is a reviewable operating model:

1. Learn the system within an approved scope.
2. Build a page, action, and API map.
3. Generate a connector playbook with action contracts.
4. Prefer API-first execution when safe contracts exist; fall back to browser automation for UI-only or stale API paths.
5. Generate a workspace skill draft that references the playbook.
6. Let the user review and enable it before future use.

Never store passwords in a skill, prompt, log, or generated file. The user should log in through an interactive browser/profile, SSO, or existing session. Treat credentials, cookies, tokens, screenshots, exports, and personal data as sensitive.

## Learning Modes

- Read-only scan: default. Open pages, menus, lists, filters, and detail views. Do not submit forms or mutate data.
- Dry-run rehearsal: fill fields only when safe, then stop before submit.
- Authorized execution: perform writes only after the user explicitly approves the action and risk policy.
- Test-environment learning: when the user confirms the environment is safe, submit/create/update/delete flows may be explored to learn real APIs and validation behavior.

## Learning Flow

1. Confirm base URL, business scope, allowed domains, forbidden areas, and whether the environment is production or test.
2. Require a domain allowlist. Never follow links outside it.
3. Ask the user to log in interactively if no active session exists.
4. **Contract discovery first (authoritative > inferred).** Before scanning the
   UI, run `scripts/discover_contracts.cjs --base-url <url> --allow-domain <host>`
   (pass `--storage-state` to reuse the logged-in session) to probe for the
   system's own published OpenAPI/Swagger or GraphQL schema. A published contract
   is a complete, authoritative source of APIs and data structures — prefer it
   over DOM/HAR inference. Pass its `api-contracts.json` to
   `create_web_system_skill.cjs --contracts`. Fall back to the UI scan only for
   what the published contract does not cover.
5. Run a read-only dry run before deeper exploration.
5. Run every scanner/executor command in the foreground and wait for it to finish before claiming the scan is running, complete, failed, or waiting for analysis.
6. Explore navigation, menus, tabs, forms, filters, lists, details, exports, pagination, dialogs, and error states.
7. Capture stable selectors, accessibility labels, field names, validation messages, request methods, endpoint shapes, and response hints.
8. Classify actions by risk: read, export, draft, submit, update, delete, financial, identity/security, and bulk operations.
9. Build an action map and playbook. Each action needs inputs, preconditions, execution path, confirmation policy, success signal, rollback/recovery, and audit fields.
10. Generate a workspace skill draft and summary for user review.
11. On later use, execute through the learned playbook; if selectors/API change, mark stale and request re-learning.

## Runtime Lifecycle Rules

The chat UI can only show "running" while a real foreground tool is active. Keep the assistant state honest:

- Do not say "scan is running", "waiting for scan completion", or "I will analyze when it finishes" unless the scanner command is still executing as a foreground Bash/tool call in the same turn.
- Never start `scan_web_system.py`, `execute_web_playbook.cjs`, Playwright, browser learning, or skill generation with `&`, `nohup`, `setsid`, `disown`, a detached terminal, or a separate background shell.
- If a scan may take minutes, tell the user what will be scanned, then run the foreground command and wait for its JSON/output before summarizing.
- If the environment cannot keep a foreground tool alive, stop and explain the exact blocker instead of pretending a background scan is active.
- A follow-up such as "deeper scan" or "continue scanning" must either run another foreground scanner command or ask for the missing scope. It must not be treated as a separate idle chat while the previous scan is supposedly pending.
- After a scanner command finishes, read the output file before generating `system-profile.json`, `page-map.json`, `api-map.json`, `capability-map.json`, `action-playbook.json`, `health.json`, and `skill-draft/SKILL.md`.

## Output Artifacts

Place generated artifacts in the workspace learning area, using stable English directory names and localized display labels:

- system-profile.json: app name, domains, roles, navigation, risks.
- page-map.json: pages, routes, labels, selectors, forms, tables, actions.
- api-contracts.json: authoritative published contracts (OpenAPI/GraphQL) from discover_contracts.cjs, with real request/response JSON Schema (types, enums, required) and reusable data schemas. Persisted verbatim for review and re-learn diffing.
- api-map.json: merged endpoint catalog (authoritative contracts take precedence over observed/inferred), methods, request/response schemas, data schemas, auth hints, mutation flags.
- capability-map.json: natural-language capability routing, required parameters, confirmation gates, success signals, stale signals, and recovery policy.
- action-playbook.json: natural-language intents mapped to safe actions.
- health.json: learning coverage, API/browser fallback coverage, stale state, and recommended next steps.
- skill-draft/SKILL.md: workspace skill draft for review and enablement.
- audit-log.jsonl: learning actions, timestamps, scope, and redacted evidence.

## Safety Rules

- Production systems default to read-only learning.
- Mutating actions require explicit user approval and clear risk labels.
- High-risk actions always need confirmation at execution time: delete, submit, payment, payroll, permission, account, bulk update, external send, and irreversible actions.
- Do not store raw secrets or cookies in generated artifacts.
- If the system changes, detect stale selectors/API and trigger re-learning rather than guessing.

## Execution Rules

- Prefer learned API actions for speed and reliability when they are verified and safe.
- Use browser automation when an API is missing, UI-only, or must be visually confirmed.
- For ambiguous natural-language requests, ask one focused question instead of guessing a destructive action.
- Always show what will happen before a mutating action and record the result in audit logs.
