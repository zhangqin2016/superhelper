# Lily Website Legal Center Design

## Goal

Publish a stable, truthful legal center for Lily Workbench that satisfies the
website and Microsoft Store disclosure needs without claiming controls the
product does not yet provide.

## Scope

- Add `/legal`, `/privacy`, `/terms`, `/legal/data-and-third-parties`, and
  `/account-deletion`.
- Add all legal links to the public site footer.
- Cover local workspace data, model and media requests, account and device
  information, aggregate usage, diagnostics, payments, contact submissions,
  attachments, wishes, cookies, and mobile pairing.
- Identify the actual service categories and configurable AI providers.
- Explain access, correction, withdrawal, deletion, complaint, and local-data
  handling procedures.
- Provide complete Chinese, English, and Arabic content through the existing
  locale mechanism.

## Product Truths

- Chats and workspace files are local by default, but user prompts and selected
  or extracted file content can be sent to the chosen AI provider when an AI
  feature requires it.
- Lily's service stores account, device, license, aggregate usage, billing, and
  diagnostic records. Contact attachments are stored in Qiniu.
- Model and media providers vary by managed configuration or the user's own
  provider settings. Cross-border transfer can therefore depend on the selected
  provider and endpoint.
- There is no self-service account deletion endpoint today. The deletion page
  must describe the current manual request path and must not claim an in-app
  deletion button exists.

## Information Architecture

The legal index gives a short summary and links to four focused documents. Each
document uses a shared, accessible article component with an in-page section
navigation. The pages use the existing site navigation, footer, typography, and
locale detection.

## Verification

- A source-level contract test asserts routes, footer links, required
  disclosures, rights channels, and dangerous-claim exclusions.
- `next build` verifies all routes compile and render.
- Browser screenshots verify desktop and mobile layout, link visibility, and
  absence of overlap or horizontal overflow.
