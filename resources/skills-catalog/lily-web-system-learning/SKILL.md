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

The scanner collects page structure only:
   - menus and top-level navigation
   - search/list/detail pages
   - form labels, required fields, buttons
   - export/download actions
   - obvious destructive or submit actions

If the browser runtime is missing, stop and report the structured error. Do not
invent a skill from memory or screenshots alone.

6. Produce a JSON spec using this shape:

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

7. Validate and create the connector playbook plus skill draft:

```bash
node scripts/create_web_system_skill.cjs --spec web-system-spec.json
```

The script writes:

- `web-system-playbook.json`: the standard connector/action contract.
- `web-system-spec.json`: the legacy learning spec for human review.
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
