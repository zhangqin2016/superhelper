---
name: lily-web-system-learning
description: Use when the user wants Lily to learn a web/OA/ERP/CRM/admin system and turn it into a reusable workspace skill for natural-language operations. Covers read-only automatic exploration, page/action mapping, domain allowlists, credential safety, high-risk confirmation, and creating a reviewed skill draft.
---

# Lily Web System Learning

Use this skill when the user asks to learn or automate a web system: OA, ERP,
CRM, finance, HR, support portals, admin dashboards, government/vendor portals,
or any browser-based internal tool.

## Product Contract

The goal is not "AI clicks a website freely." The goal is:

1. Learn the system within a user-approved scope.
2. Produce a page/action map.
3. Generate a standard connector playbook.
4. Generate a workspace skill draft that references the playbook contract.
5. Let the user review and enable the skill before future use.

Never store passwords in a skill, prompt, log, or generated file. The user must
log in through an interactive browser/profile, SSO, or existing session. Treat
all credentials, cookies, tokens, screenshots, exports, and personal data as
sensitive.

## Learning Modes

- **Read-only scan**: default. Open pages, inspect menus/forms/lists, collect
  labels and stable selectors. Do not submit forms or mutate data.
- **Dry-run rehearsal**: fill fields only when safe, but stop before submit.
- **Authorized execution**: only after the generated skill is reviewed and the
  specific action has an explicit confirmation policy.

If a Playwright MCP/browser runner is available, prefer it for exploration
because accessibility snapshots and locators are more stable than screenshots.
Use visual recognition only as fallback for canvas/low-code pages or unlabeled
controls.

## Automatic Learning Flow

1. Confirm the base URL, business scope, and forbidden areas.
2. Require a domain allowlist. Never follow links outside the allowlist.
3. Ask the user to log in interactively if the session is not already active.
4. Validate the read-only scanner configuration:

```bash
python scripts/scan_web_system.py \
  --base-url https://oa.example.com \
  --allowed-domain oa.example.com \
  --dry-run
```

5. Explore read-only:

```bash
python scripts/scan_web_system.py \
  --base-url https://oa.example.com \
  --allowed-domain oa.example.com \
  --max-pages 20 \
  --out web-system-scan.json
```

For systems where menus, tabs, details, or pagination are hidden behind
non-submit controls, run an interactive read-only pass:

```bash
python scripts/scan_web_system.py \
  --base-url https://oa.example.com \
  --allowed-domain oa.example.com \
  --max-pages 40 \
  --interactive-readonly \
  --out web-system-scan.json
```

Learning modes:

- `read-only` is the default. It learns pages, navigation, fields, forms, and
  static API contracts without submitting anything.
- `contract-probe` is reserved for future network-request discovery. It may
  observe request intent, but must abort unsafe network requests and redact
  payload values.
- `test-lab` is only for non-production systems. It requires both
  `--test-environment <name>` and `--allow-mutating-learning`; generated
  contracts may mark submit/delete/approve flows as learnable in that test
  environment, but credentials and field values must still be redacted.

Example test environment learning declaration:

```bash
python scripts/scan_web_system.py \
  --base-url https://qa-oa.example.com \
  --allowed-domain qa-oa.example.com \
  --learning-mode test-lab \
  --test-environment qa \
  --allow-mutating-learning \
  --interactive-readonly \
  --out web-system-scan.json
```

The scanner creates a read-only learning archive. It collects page structure only:
   - menus and top-level navigation
   - search/list/detail pages
   - form labels, required fields, buttons
   - export/download actions
   - obvious destructive or submit actions
   - page fingerprints, URL patterns, table headers, iframe hints, and coverage metrics
   - candidate business objects and action candidates that still require review
   - form contracts: field labels, required flags, select/radio/checkbox options,
     submit buttons, and the rule that learning never submits
   - API contracts from forms: endpoint, method, request field schema, submit
     buttons, and whether the API still needs a dynamic submit probe
   - interactive read-only discoveries from safe menu/tab/detail controls when
     `--interactive-readonly` is enabled

If the browser runtime is missing, stop and report the structured error. Do not
invent a skill from memory or screenshots alone.

6. Read `web-system-scan.json` and produce a reviewed JSON spec using this shape.
   The spec must be grounded in the scan archive; do not invent unsupported
   pages or actions. If the scan coverage is weak, tell the user which areas
   need another login/session or a deeper interactive pass.

```json
{
  "id": "company-oa",
  "name": "Company OA",
  "systemName": "Company OA",
  "baseUrl": "https://oa.example.com",
  "allowedDomains": ["oa.example.com"],
  "summary": "Internal OA system for approvals and expense lookups.",
  "actions": [
    {
      "id": "query-expense-status",
      "name": "Query expense status",
      "intentExamples": ["查报销进度", "本周报销有没有通过"],
      "risk": "read",
      "entry": "Expense > My reimbursements",
      "steps": [
        "Open the expense list page.",
        "Search by date range or keyword.",
        "Return status, amount, approver, and latest comment."
      ],
      "confirmation": "none"
    }
  ]
}
```

7. Validate and create the connector playbook plus skill draft. Pass the scan
   archive so the generated skill includes the real page map, domain model, and
   coverage report:

```bash
node scripts/create_web_system_skill.cjs \
  --spec web-system-spec.json \
  --scan web-system-scan.json
```

The script writes:

- `web-system-playbook.json`: the standard connector/action contract.
- `web-system-spec.json`: the legacy learning spec for human review.
- `web-system-scan.json`: the normalized read-only learning archive.
- `system-profile.json`: the system identity, scope, credential policy, and file index.
- `page-map.json`: learned pages, entries, anchors, and page/action relationships.
- `domain-model.json`: inferred business objects, vocabulary, fields, and open questions.
- `risk-policy.json`: domain allowlist, forbidden learning-time actions, learned form
  policies, and confirmation rules.
- `examples.jsonl`: natural language examples mapped to standard `web.*` actions.
- `change-log.json`: learning and re-learning history for change detection.
- `SKILL.md` and `skill.manifest.json`: the workspace skill draft.
- `scripts/execute_web_playbook.cjs`: the local, domain-checked, confirmation-gated
  execution helper for the generated playbook.

Tell the user they must review and enable the draft in Settings -> Skills before
it becomes active.

8. Future execution must be plan-driven. The assistant creates an
   `action-plan.json`, validates it first, then executes only if the risk and
   confirmation policy allow it:

```bash
node scripts/execute_web_playbook.cjs \
  --playbook web-system-playbook.json \
  --action web.query-expense-status \
  --plan action-plan.json \
  --dry-run
```

For `submit` and `destructive` actions, never add `--confirmed` until the user
has reviewed the exact action target and final field values.

The executor supports these plan operations:

- Read/state: `goto`, `wait`, `waitForUrl`, `waitForText`,
  `waitForResponse`, `assertText`, `extract`, `screenshot`.
- Draft/write controls: `click`, `fill`, `select`, `check`, `uncheck`,
  `upload`, `press`.

Use robust locators before brittle CSS: `testId`, `role/name`, `label`,
`placeholder`, `text`, then `selector`. For `select`, use `label` to find the
control and `optionLabel` or `value` to pick the option. If execution reports
`LOCATOR_NOT_FOUND`, `ASSERT_TEXT_FAILED`, or `WEB_ACTION_FAILED`, treat the
learned skill as stale and re-run learning before retrying submit/destructive
actions.

## Action Rules

Risk levels:

- `read`: query, search, open detail, export non-sensitive data.
- `prepare`: fill a form but do not submit.
- `submit`: submit, send, create, upload, comment.
- `destructive`: delete, approve/reject, pay, change permission, revoke.

Confirmation:

- `none` is allowed only for read-only actions.
- `review` means show the final fields/result before execution.
- `explicit` means the user must confirm the exact submit/destructive action.

Generated skills must keep submit/destructive actions behind confirmation. If
the learned page has CAPTCHA, 2FA, SSO re-auth, or unknown permission prompts,
pause and hand control back to the user.

## Form Learning Rules

- During learning, inspect form structure only. Never click submit/save/send.
- Record field labels, input types, required flags, disabled/readonly state, and
  visible options. Do not record existing field values.
- Treat POST forms or forms with submit/save/send/approve/delete/pay/upload
  buttons as mutating candidates.
- Record static API contracts from forms even when the action is submit/delete:
  endpoint, method, request field schema, submit buttons, and probe policy.
- If a SPA form has no static endpoint, mark `needsSubmitProbe: true` instead
  of guessing an API.
- Generated playbooks may fill drafts for `prepare` actions, but every submit
  button remains behind user review or explicit confirmation.
- For multi-step forms, record each discovered step as a separate page/form
  contract and require a dry-run validation before real execution.
- In `test-lab` mode only, generated policies may allow real submit/delete
  learning for the declared test environment. Production learning must never
  complete mutating actions.

## Interactive Read-only Rules

- Only click controls classified as read-only menu, tab, tree, summary, detail,
  next/previous, search/filter, or expand actions.
- Never click a control inside a form during learning.
- Never click text that looks like submit/save/send/delete/approve/reject/pay/
  upload/create.
- Store the discovered page or panel with `source: interactive-readonly` and
  `sourceInteraction` so the generated skill can explain how it was found.
- If a click leaves the allowed domains, discard it.

## Failure Handling

- If selectors are unstable, record multiple anchors: label text, role/name,
  URL pattern, nearby heading, and fallback visual note.
- If the page changes, the skill should re-run read-only discovery for that
  action before failing.
- If a field is ambiguous, ask the user instead of guessing.
- If the system exposes private data unrelated to the task, stop collecting and
  narrow the scope.

## Red Lines

- Do not ask the user to paste passwords into chat.
- Do not write credentials or cookies into generated skills.
- Do not auto-submit, approve, delete, pay, upload, or notify during learning.
- Do not browse outside the allowed domains.
- Do not generate a skill that bypasses the user's future confirmation choices.
