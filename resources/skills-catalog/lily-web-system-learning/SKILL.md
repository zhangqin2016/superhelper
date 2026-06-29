---
name: lily-web-system-learning
description: Use when the user wants Lily to learn a web/OA/ERP/CRM/admin system and turn it into a reusable workspace skill for natural-language operations. Covers read-only automatic exploration, page/action mapping, domain allowlists, credential safety, high-risk confirmation, and creating a workspace skill the user can enable.
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
6. Let the user enable it before future use.

Never store passwords in a skill, prompt, log, or generated file. The user may save a site login in the platform's encrypted credential vault (Settings → Connectors → Website logins); that password is held only by the Electron main process and is used there to log in on the user's behalf — it is never passed to this skill, the executor, or any log. Otherwise the user logs in through an interactive browser/profile, SSO, or existing session. Treat credentials, cookies, tokens, screenshots, exports, and personal data as sensitive.

## Learning Modes

- Read-only scan: default. Open pages, menus, lists, filters, and detail views. Do not submit forms or mutate data.
- Dry-run rehearsal: fill fields only when safe, then stop before submit.
- Authorized execution: perform writes only after the user explicitly approves the action and risk policy.
- Test-environment learning: when the user confirms the environment is safe, submit/create/update/delete flows may be explored to learn real APIs and validation behavior.

## Learning Flow

1. Confirm base URL, business scope, allowed domains, forbidden areas, and whether the environment is production or test.
2. Require a domain allowlist. Never follow links outside it.
3. Capture the login ONCE. If no saved session exists for this system, run
   `node scripts/capture_session.cjs --base-url <url> --system-id <id>
   --allow-domain <host>`. If the user has saved a credential for this site, the
   script auto-logs-in via the main process and writes the session with NO manual
   step (the result has `mode:"credential"`); otherwise it opens one real browser
   window with a persistent Lily browser profile for this system, so later manual
   recaptures reuse the same local browser state. Either way it saves the session
   to a local, per-system file (printed as `sessionPath`, stored 0600 under
   userData, never exported) and prints the local `profilePath`. Pass that
   `sessionPath` as `--storage-state` to every later scan/discover/execute call.
   Re-run capture only when a call reports `stale`/`relearnRecommended` (401/403).
   Never ask the user to paste cookies, tokens, OAuth codes, CSRF values, or
   credential headers; if a token is dynamic, learn it from authenticated browser
   traffic or re-capture/re-learn the flow.
   The capture script is the only login-capture path: do not write ad-hoc Python
   or JavaScript login scripts, do not call `input()`/stdin prompts, and do not
   install Playwright at runtime. If the bundled browser runtime is missing,
   report that exact blocker instead of improvising.
4. **Contract discovery first (authoritative > inferred).** Before scanning the
   UI, run `scripts/discover_contracts.cjs --base-url <url> --allow-domain <host>`
   (pass `--storage-state` to reuse the logged-in session) to probe for the
   system's own published OpenAPI/Swagger or GraphQL schema. A published contract
   is a complete, authoritative source of APIs and data structures — prefer it
   over DOM/HAR inference. Pass its `api-contracts.json` to
   `create_web_system_skill.cjs --contracts`. Fall back to the UI scan only for
   what the published contract does not cover.
5. **Learn APIs from real traffic (for systems without a published contract, and
   for write paths).** Run the scan with `--har-path scan.har` to record traffic,
   then `node scripts/har_to_contracts.cjs --har scan.har --base-url <url>
   --allow-domain <host> --merge api-contracts.json --out api-contracts.json` to
   infer request/response schemas from observed requests and merge them in
   (authoritative published contracts are never overridden). Write-path APIs
   (POST/PUT/DELETE) are only captured when those flows actually run — exercise
   them only in a confirmed test environment.
   Also run `node scripts/frontend_source_intelligence.cjs --har scan.har
   --base-url <url> --allow-domain <host> --out frontend-source-map.json`.
   This is a bounded, read-only SPA source pass: it analyzes only same-allowlist
   JavaScript assets captured in the HAR, extracts route/API-client hints, and
   persists only structured metadata. It must not save raw bundle source,
   secrets, cookies, tokens, or large source text.
   For SPAs (Vue/React/Angular): ALWAYS pass `--storage-state <sessionPath>` so the
   scan runs authenticated, and use `--interactive-readonly`. The scanner waits for
   the app to render before snapshotting (so it no longer captures only an empty
   shell) and follows nav/menus/tabs to depth (default `--max-pages 40`). If the
   scan `warnings` include `AUTH_NOT_RESTORED`, the session expired or wasn't
   applied (common for localStorage-token SPAs) — re-capture the login and rerun
   before trusting the result. A scan that finds only the landing page on an SPA
   almost always ran unauthenticated or before the app rendered; do not present it
   as a complete learning.
6. **Learn auth injection from the logged-in session.** After HAR capture, run
   `node scripts/learn_auth_recipe.cjs --storage-state <sessionPath> --har scan.har
   --base-url <url> --allow-domain <host>`. The output stores only sources and
   formats (for example, `Authorization` from `localStorage.access_token` as
   `Bearer {{value}}`), never raw token values.
7. **Special browser-context boundary.** Some enterprise systems bind the
   session to the exact interactive browser, SSO/device posture, TLS/client
   hints, QR-code login, or anti-automation controls. If a captured
   `storageState` or headless scan cannot replay after one successful capture
   attempt and one bounded scan attempt, do not try stealth, webdriver patching,
   user-agent spoofing, TLS/client-hint spoofing, native-Chrome retry loops, or
   ad-hoc Playwright/Python/JavaScript scripts. Stop the automated path with
   `SPECIAL_BROWSER_CONTEXT_REQUIRED`, include the last concrete evidence, and
   switch to an approved path: same interactive browser/profile capture,
   optional accessibility-tree/MCP observation in the user-controlled browser, or
   a partial draft from contracts/HAR/source hints with gaps recorded in
   `health.json`. Do not promise unattended headless automation for these
   systems unless a learned API contract or verified compiled browser flow
   exists.
8. Run a read-only dry run before deeper exploration.
9. Run every scanner/executor command in the foreground and wait for it to finish before claiming the scan is running, complete, failed, or waiting for analysis.
10. Explore navigation, menus, tabs, forms, filters, lists, details, exports, pagination, dialogs, and error states.
11. Capture stable selectors, accessibility labels, field names, validation messages, request methods, endpoint shapes, and response hints.
12. Classify actions by risk: read, export, draft, submit, update, delete, financial, identity/security, and bulk operations.
13. Build an action map and playbook. Each action needs inputs, preconditions, execution path, confirmation policy, success signal, rollback/recovery, and audit fields.
14. Finish with the deterministic finalizer:
   `node scripts/finalize_web_system_learning.cjs --scan <scan.json>
   --contracts <api-contracts.json> --frontend-source <frontend-source-map.json>
   --system-id <id> --name <name>`.
   This derives `web-system-spec.json` from scan/contracts/source hints and calls
   `create_web_system_skill.cjs`. Do not hand-write the final spec in chat, and
   do not end the learning turn before the finalizer returns `ok: true` or a
   concrete error.
15. Tell the user exactly where the generated workspace skill draft was written
   and that they can enable it.
16. On later use, execute through the learned playbook; if selectors/API change, mark stale and request re-learning.

## Autonomous Self-Run Learning (no human recording)

Instead of asking the user to record a demonstration, the platform can drive the
site ITSELF to learn a flow, then distill its own successful run into a reusable
natural-language procedure card. Use this to learn UI-only flows the scanner/HAR
can't capture, without a human in the loop.

- Runner: `node scripts/autorun_web_task.cjs` reads `{ instruction, baseUrl,
  mode, allowedDomains?, maxSteps?, completionCriteria?, storageState? }` from
  stdin. At each step it observes the page, enumerates the interactive elements,
  asks the in-loop model to pick ONE action from that menu, runs it through the
  safety controller, executes it, and records the step. On success it emits a
  `trajectory` and a distilled `card`.
- Safety modes (default the safest that can still learn the flow):
  - `read-only` (DEFAULT): only reads/navigations/menu clicks run; any write
    (fill/submit/save/delete) is refused. Safe on production — learns read flows.
  - `dry-run`: fills fields but stops before the final submit (learns the form
    shape without mutating).
  - `authorized`: writes run; destructive actions (delete/pay/cancel) still need
    explicit confirmation via `confirmedDestructive`. Use ONLY in a test
    environment or with the user's explicit go-ahead.
- Guardrails are enforced by `autorun_controller.cjs` (pure, unit-tested):
  domain allowlist (no off-site navigation), risk classification, a hard step cap
  AND a no-progress bound so a run always terminates, and a deterministic
  completion backstop. A password field stops the run with `needs-auth` —
  credentials come from a pre-seeded `storageState`/the credential vault, never
  typed by the model or written into the trajectory.
- Provenance: a card from a self-run carries `provenance.source` and `runs`;
  feed it to `procedure_graph.cjs` (`mergeCardIntoGraph`) to dedupe/merge/
  specialize against previously learned cards. Repeated successful self-runs of
  the same intent accumulate `runs` and strengthen the card.
- Degrades to today's behavior: if Playwright or the in-loop model is
  unavailable, the runner fails loud with a code (`PLAYWRIGHT_NODE_MISSING` /
  `MODEL_UNAVAILABLE`) and changes nothing — fall back to read-only scanning.
- Same foreground rule as the scanner: run it as a foreground tool and wait for
  its JSON; never background it.

## Runtime Lifecycle Rules

The chat UI can only show "running" while a real foreground tool is active. Keep the assistant state honest:

- Do not say "scan is running", "waiting for scan completion", or "I will analyze when it finishes" unless the scanner command is still executing as a foreground Bash/tool call in the same turn.
- Never start `scan_web_system.py`, `execute_web_playbook.cjs`, Playwright, browser learning, or skill generation with `&`, `nohup`, `setsid`, `disown`, a detached terminal, or a separate background shell.
- Never run ad-hoc `python3 -c`, here-doc, inline Playwright, stealth, webdriver-patching, user-agent spoofing, or native-Chrome retry scripts as a substitute for the approved scanners/executors. If the approved path cannot handle the system, stop with `SPECIAL_BROWSER_CONTEXT_REQUIRED` and produce a reviewable partial result or ask for same-browser capture.
- If a scan may take minutes, tell the user what will be scanned, then run the foreground command and wait for its JSON/output before summarizing.
- If the environment cannot keep a foreground tool alive, stop and explain the exact blocker instead of pretending a background scan is active.
- A follow-up such as "deeper scan" or "continue scanning" must either run another foreground scanner command or ask for the missing scope. It must not be treated as a separate idle chat while the previous scan is supposedly pending.
- After a scanner command finishes, read the output file before generating `system-profile.json`, `page-map.json`, `api-map.json`, `capability-map.json`, `action-playbook.json`, `health.json`, and the workspace skill `SKILL.md`.
- A partial scan is still a valid reviewable draft. If coverage is low, run the
  deterministic finalizer anyway and mark gaps in `health.json`; do not stop at
  "I will continue scanning" unless another foreground scanner command is
  actually running.

## Output Artifacts

Place generated artifacts in the workspace learning area, using stable English directory names and localized display labels:

- system-profile.json: app name, domains, roles, navigation, risks.
- page-map.json: pages, routes, labels, selectors, forms, tables, actions.
- api-contracts.json: authoritative published contracts (OpenAPI/GraphQL) from discover_contracts.cjs, with real request/response JSON Schema (types, enums, required) and reusable data schemas. Persisted verbatim for review and re-learn diffing.
- frontend-source-map.json: bounded same-domain JavaScript intelligence from frontend_source_intelligence.cjs: route hints, API-client path hints, asset counts, truncation flags, and warnings. Never raw source.
- api-map.json: merged endpoint catalog (authoritative contracts take precedence over observed/inferred), methods, request/response schemas, data schemas, auth hints, mutation flags.
- capability-map.json: natural-language capability routing, required parameters, confirmation gates, success signals, stale signals, and recovery policy.
- action-playbook.json: natural-language intents mapped to safe actions.
- health.json: learning coverage, API/browser fallback coverage, stale state, and recommended next steps.
- SKILL.md: workspace skill instructions for enablement, written under the generated system id directory such as `<learned-skills-inbox>/<system-id>/`.
- audit-log.jsonl: learning actions, timestamps, scope, and redacted evidence.

## Safety Rules

- Production systems default to read-only learning.
- Mutating actions require explicit user approval and clear risk labels.
- High-risk actions always need confirmation at execution time: delete, submit, payment, payroll, permission, account, bulk update, external send, and irreversible actions.
- Do not store raw secrets or cookies in generated artifacts.
- If the system changes, detect stale selectors/API and trigger re-learning rather than guessing.

## Execution Rules

- Log in ONCE, then reuse the session. Capture the logged-in session to a
  storageState file (e.g. `web-session.json`) and pass `--storage-state` to every
  scan/discover/execute call. Do not reopen a browser to log in for each action;
  only re-capture when the session actually expires (a run reports
  `stale`/`relearnRecommended` from a 401/403).
- If a page or API requires a token/cookie/header, do not ask the user how to
  obtain it. Use the captured session, or re-run authenticated learning so the
  platform observes the required dynamic token flow.
- Captured sessions can contain cookies, localStorage, and sessionStorage. Treat
  all three as local secrets; reuse them through `--storage-state` and
  `--auth-recipe`, never by copying values into plans, prompts, generated code,
  logs, or skill files.
- Pass the local auth recipe as `--auth-recipe <authRecipePath>` for API
  execution when HAR observed Authorization/CSRF headers. The recipe resolves
  values from storageState at runtime and must not contain raw token values.
- Prefer learned API actions: an all-API plan runs over plain HTTP with the
  reused session cookies and launches NO browser (fast, no flicker, no repeated
  windows). Asking a question that maps to a learned API = one HTTP call.
- Normal user execution must use the learned flow graph in `capability-map.json`
  and `web-system-playbook.json`. Do not generate ad-hoc Playwright,
  JavaScript, Python, selectors, or operation plans while answering a normal user
  request.
- Use browser automation during learning, discovery, and login only through the
  approved foreground capture/scanner/executor scripts or the same interactive
  browser/profile. Do not switch to ad-hoc headless fallback scripts after login.
  If no captured API or compiled browser flow exists for a capability, mark it
  as needing re-learning instead of improvising.
- When an action has both an API path and a captured browser path, store the
  browser path during learning as `fallbackOperations`; the executor runs the
  fallback automatically if the API path fails or goes stale
  (401/403/404/status-mismatch/locator-not-found).
- For write actions, capture `rollbackOperations` during learning when a safe
  compensating path exists; the executor runs them best-effort if a write fails
  after mutating state.
- Always pass `--audit-log <file>` so every step is appended to a durable JSONL
  trail (inputs redacted). A failed run reports `stale`/`staleSignal`/
  `relearnRecommended` — when `relearnRecommended` is true, re-run learning
  rather than blindly retrying.

Executor reliability capabilities (all OPT-IN per operation except the automatic
ones; every one fails safe — if a hint is wrong or missing, the executor behaves
as if it were absent, never worse):
- Automatic, no config: (1) session refresh — on 401/403 the executor calls a
  refresh endpoint learned into `auth-recipe.json.refreshCandidates` and retries
  once before declaring the session stale; (2) cookie/CSRF freshness — it merges
  every response's `Set-Cookie` back into the session, so rotated session and
  double-submit CSRF tokens (e.g. XSRF-TOKEN → X-XSRF-Token via the auth recipe)
  stay valid across a multi-step write.
- Pagination: for a list/query endpoint that returns one page, set
  `op.pagination = { mode: "page"|"offset"|"cursor", param, itemsPath, nextPath?,
  start?, size?, maxPages? }`. The executor fetches and aggregates all pages
  (capped by `maxPages`, default 20) and returns the combined items. `itemsPath`
  and `nextPath` are dot-paths into the JSON response. Use this whenever the user
  asks for "all"/"every"/a full export rather than just the first page. Learning
  may attach a `pagination` hint to a contract (mode/param/itemsPath/nextPath
  detected from captured traffic) — copy it into `op.pagination` instead of
  guessing; for a single-page read, omit pagination so it does not over-fetch.
- Idempotent writes: for a non-idempotent write (create/submit/pay) set
  `op.idempotent: true` (optionally `op.idempotencyHeader`). The executor injects a
  stable `Idempotency-Key` and safely retries ONCE on a network drop with the same
  key, so the server can dedupe. Do NOT set it blindly on every write — only when
  the action genuinely must not double-submit.
- Reusable / chained operations: any `op.url`/`op.body`/`op.headers` may contain
  `{{name}}`. Names resolve from the plan's `params` object and from values
  EXTRACTED out of an earlier API response via `op.bind = { name: "dot.path" }`.
  This is how you chain steps — e.g. POST create with `bind: { id: "data.id" }`,
  then `DELETE /items/{{id}}`. A resolved URL is re-checked against the domain
  allowlist, so a binding can never send a request off-site.
- For ambiguous natural-language requests, ask one focused question instead of guessing a destructive action.
- Always show what will happen before a mutating action and record the result in audit logs.
- Locator resilience is built in: the executor tries selector → testId → role →
  label → placeholder → text candidates before failing, so a single brittle
  selector does not break a step. On a hard failure it reports
  `relearnRecommended` rather than guessing.
- For a frequently-repeated, verified flow, compile it during learning to a
  deterministic script with `node scripts/compile_playbook.cjs --playbook
  web-system-playbook.json --action web.x --plan plan.json --out flows/x.cjs`.
  The compiled script replays without the model (faster, cheaper, reproducible)
  and keeps the domain allowlist + no-credential rules inlined. Re-compile after
  a re-learn.

## Browser Engine (@playwright/mcp, optional)

Two complementary browser paths — pick by task:

- **Deterministic path (default for verified/repeatable flows):** the validated
  executor (`execute_web_playbook.cjs`) and compiled scripts. Use this for
  learned, confirmed actions — it is safe, fast, and reproducible.
- **Accessibility-tree path (optional, for exploration / learning capture):** if
  this session has Microsoft's `@playwright/mcp` server registered, prefer its
  accessibility-snapshot tools to navigate and act on pages the way a person
  reads them — better for first-time exploration and capturing missing flows. It
  is free/open-source (Apache-2.0) and runs locally.

When `@playwright/mcp` is available, use it for discovery/coverage passes and
exploration steps, then capture the result as a learned action so future runs
use the deterministic path. Never put credentials in MCP tool calls; rely on the
shared browser session. If `@playwright/mcp` is not registered, everything still
works through the deterministic executor — it is an enhancement, not a
requirement.

## Natural-Language Routing

You are the router. Do not rely on keyword tables — read `capability-map.json`
and match the user's request to a capability by meaning:

1. Load `capability-map.json`. Each capability has `intents`, a description,
   `params` (with `required`/`askWhenMissing`), `execution`, and `successSignal`.
2. Pick the single best-matching capability by intent. If two are plausible, ask
   one focused disambiguating question rather than guessing — especially when one
   candidate is a write/destructive action.
3. Fill `params` from the request; for any missing `required` param, ask using
   its `askWhenMissing` prompt before executing.
4. Execute through the typed learned-system tool when available; otherwise
   materialize the plan from `execution.learnedFlow.operationTemplate` and user
   parameters. Never author a fresh browser/script plan at runtime.
5. If no capability matches, say so and offer to re-learn that area — never
   invent an endpoint or selector.

(For very large systems where the full capability set will not fit in context,
add a retrieval pre-filter to shortlist candidates before this step. Not needed
for typical systems — the model routes directly.)

## Coverage Completeness

Learning is not done after one pass. Explore like a QA engineer mapping the
whole system, then critique coverage:

- Systematically walk every menu, tab, list, filter, detail, dialog, and
  pagination within scope — not just the landing pages.
- After each pass, ask "what have I NOT seen yet?" (modules behind permissions,
  routes only reached via buttons/JS, write flows, error/validation states) and
  run another foreground pass to cover them. Stop only when consecutive passes
  surface nothing new.
- Authoritative contracts (`api-contracts.json`) define the API/data-structure
  ceiling; use the UI scan to map which capability each contract serves and to
  cover UI-only flows the contract omits.
- Record coverage and known gaps in `health.json` honestly. A skill with gaps is
  a reviewable draft, not a finished operator — say what is not yet covered.

## Re-learning & Drift

When re-learning a system, diff the new contracts against the persisted ones:

```
node scripts/diff_contracts.cjs --old api-contracts.json --new api-contracts.new.json
```

Treat `removed`/`changed` endpoints (and anything under `breaking`) as stale:
re-verify or disable the capabilities bound to them before reuse. Record the
drift summary in `change-log.json`.
