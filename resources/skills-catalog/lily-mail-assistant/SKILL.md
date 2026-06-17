---
name: lily-mail-assistant
description: Use when the user wants Lily to search, summarize, analyze, draft, or send email through Gmail, Outlook/Microsoft 365, or IMAP/SMTP connectors. Keeps credentials out of chat and requires confirmation before sending or destructive mailbox changes.
---

# Lily Mail Assistant

Use this skill when the user asks to work with email: search messages, summarize
threads, find attachments, analyze customer requests, draft replies, prepare a
daily digest, or send mail after review.

## Product Contract

Email is an application connector, not a pile of ad-hoc browser steps.

1. Configure or discover a mail connector.
2. Use the standard `mail.*` action protocol.
3. Keep credentials out of chat, skills, logs, and generated files.
4. Default to read-only or draft-only work.
5. Require explicit confirmation before sending, deleting, archiving in bulk, or
   changing mailbox state.

## Supported Connector Shapes

- Gmail: OAuth session, Gmail API, no password in chat.
- Outlook / Microsoft 365: OAuth session, Microsoft Graph, no password in chat.
- IMAP / SMTP: app password or token stored by the application/keychain; scripts
  reference a `secretRef`, never the secret value.

If the account is not connected, ask the user to connect it through
Settings -> Connectors. IMAP/SMTP accounts can be tested immediately. Gmail and
Microsoft 365 require OAuth app details before they can be authorized.

When running inside Lily Workbench, use the local connector bridge script for
real mail actions. The script talks to the app process using a short-lived local
token and never exposes credentials:

```bash
node scripts/mail_connector_action.cjs accounts
node scripts/mail_connector_action.cjs search --account <account-id> --query '{"limit":5}'
node scripts/mail_connector_action.cjs read --account <account-id> --uid <imap-uid>
node scripts/mail_connector_action.cjs read --account <account-id> --id <provider-message-id>
```

Only send after the user has reviewed the exact draft and explicitly approved
sending:

```bash
node scripts/mail_connector_action.cjs send --account <account-id> --message reply.json --confirmed
```

When a workspace needs a reusable mail connector declaration, generate a
connector playbook draft:

```bash
node scripts/create_mail_playbook.cjs --spec mail-connector.json --out mail-playbook.json
```

## Standard Actions

| Action | Risk | Confirmation | Use |
|---|---|---|---|
| `mail.search` | read | none | Find messages by sender, date, subject, labels, or natural language criteria. |
| `mail.read` | read | none | Read selected message/thread metadata and body snippets needed for the task. |
| `mail.summarize` | read | none | Summarize threads, daily inboxes, or grouped messages. |
| `mail.find_attachments` | read | none | Locate attachments and describe filenames, types, and likely purpose. |
| `mail.draft_reply` | prepare | review | Generate a reply draft but do not send. |
| `mail.send` | submit | explicit | Send a user-approved message. |
| `mail.archive` | destructive | explicit | Archive or move messages; bulk actions require exact confirmation. |
| `mail.delete` | destructive | explicit | Delete messages only after explicit confirmation naming the target. |

## Execution Rules

- Never ask the user to paste email passwords, cookies, OAuth codes, or raw API
  tokens into the conversation.
- Never include message bodies in generated skill files.
- When summarizing, cite sender/date/subject so the user can verify the source.
- For replies, produce a draft first and wait for explicit approval before send.
- For attachments, show filename, sender, date, and save location before opening
  or exporting.
- For bulk mailbox changes, list the exact affected messages and ask for
  explicit confirmation.

## Failure Handling

- If the connector is not configured, ask for account setup instead of inventing
  results.
- If search returns too many messages, narrow by date, sender, label, project, or
  unread state.
- If a message contains sensitive personal or financial data, summarize only the
  minimum necessary information and avoid copying raw secrets.
- If provider-specific APIs differ, keep the user-facing result in the standard
  `mail.*` shape.
