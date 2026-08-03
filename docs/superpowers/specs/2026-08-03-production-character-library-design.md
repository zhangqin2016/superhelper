# Production Character Library Design

Date: 2026-08-03
Status: Approved for implementation planning
Scope: Character, persona, and world-book library experience; official production-role catalog

## 1. Problem

The current character library is a narrow, single-column management list. Each
character permanently exposes several text actions, so the interface becomes
slow to scan and physically unusable as the catalog grows. Official characters
also read primarily as short personas. They do not yet communicate the inputs,
method, deliverables, quality bar, or boundaries that make a professional role
useful in real work.

Personas and world books share the same scaling problem. They need a coherent
library experience, but they must not be flattened into character semantics:
a persona describes the user, while a world book supplies scoped knowledge and
activation rules.

## 2. Goals

1. Make 30-100 characters easy to browse and keep the interface usable at 500
   items.
2. Replace the one-row-per-character view with grouped, searchable grid cards.
3. Make activation explicit: inspecting a card must not alter the conversation.
4. Preserve all existing authoring, import, history, duplicate, export, archive,
   install, update, and binding capabilities.
5. Ship official roles that encode a professional working method, not a shallow
   personality description.
6. Give personas and world books equally complete, domain-specific library
   experiences.
7. Preserve current storage formats and fail open to the existing native Lily
   behavior when optional catalog or library data is missing.

## 3. Non-goals

- Replacing natural-language role creation with a large form builder.
- Changing the imported character-card schema or rewriting user-authored cards.
- Treating an AI legal role as a licensed lawyer or a substitute for retained
  counsel.
- Shipping factual world books whose content will silently become stale.
- Adding a remote marketplace, ratings, payments, or social publishing in this
  iteration.

## 4. Information Architecture

The modal becomes a three-pane library shell:

1. **Left group rail**: stable categories and counts.
2. **Center catalog**: toolbar plus responsive three-column grid.
3. **Right details drawer**: complete information and the explicit primary
   action.

The existing top-level tabs remain:

- Characters
- Personas
- World books

Each tab reuses the shell and interaction conventions but owns its group model,
card fields, details sections, and primary action.

### 4.1 Character groups

- All characters
- Official picks
- Work and delivery
- Research and analysis
- Content creation
- Technology and creation
- Learning and growth
- Life support
- My characters
- Recently used
- Archived

Counts are derived from current data. Categories are stable catalog identifiers;
localized labels are presentation only.

### 4.2 Persona groups

- All personas
- Work identities
- Creative identities
- Research and learning
- Communication profiles
- My personas
- Recently used
- Archived

Official persona entries are fill-in templates. A template may not be activated
until required user-specific fields are completed; placeholder text must never
be injected as user fact.

### 4.3 World-book groups

- All world books
- Project knowledge
- Brand and language
- Product and terminology
- Operations and support
- Story worlds
- My world books
- Active in this conversation
- Archived

Official world-book entries are structural templates, not unverified factual
knowledge. Initial templates include project knowledge base, brand voice guide,
product glossary, customer-support SOP, and story-world bible.

## 5. Interaction Design

### 5.1 Browse and search

- The center toolbar contains search, filter, import, and AI creation.
- Search matches names, summaries, capability terms, scenarios, and tags.
- Filters include source, category, installed state, update state, and recently
  used state where relevant.
- Filtering and grouping are pure renderer-side derivations over the loaded
  summaries. No model call is involved.
- Card order is deterministic. The default order is recently used, then official
  editorial order, then localized name.

### 5.2 Cards

Character cards show:

- stable visual marker or monogram;
- name;
- one-sentence outcome-oriented summary;
- up to three capability tags;
- official, custom, draft, installed, update, or active state when applicable.

Persona cards show identity name, use context, description summary, and
completion state. World-book cards show name, entry count, activation mode,
last update, and health state.

Cards have stable dimensions. Text truncates safely without changing grid
geometry. A grid card is a selection control, not an activation control.

### 5.3 Details drawer

Selecting a card opens the right drawer and does not change current runtime
state.

Official character details show:

- suitable scenarios;
- required inputs;
- working method;
- typical deliverables;
- quality checks;
- professional boundaries;
- install/update status.

User character details show the existing canonical description, personality,
scenario, tags, source, and revision metadata. Existing edit, history,
duplicate, export, and archive operations move into a compact details menu.

Persona details show identity facts, communication preferences, expertise,
language style, applicable contexts, completion gaps, and boundaries.

World-book details show knowledge scope, entry count, trigger modes, constant
versus conditional content, linked characters, priority, detected conflicts,
health, and estimated context-budget impact.

### 5.4 Activation

- Characters: **Use in this conversation** installs or updates an official
  character when needed, then binds its immutable revision to the active
  conversation.
- Personas: **Use in this conversation** requires a complete, user-confirmed
  persona revision before binding.
- World books: **Add to this conversation** supports multiple active books and
  displays priority, conflicts, and budget effects before confirmation.

The primary action is transactional from the user's perspective. A failed
install, update, or bind leaves the current conversation configuration
unchanged. The drawer remains open with a specific recoverable error.

## 6. Responsive and Accessibility Behavior

- Wide desktop: group rail, three-column catalog, persistent detail drawer.
- Medium width: two-column catalog and overlay detail drawer.
- Narrow width: one-column catalog; group rail becomes a category menu and the
  detail drawer becomes a full modal view.
- Font sizes do not scale with viewport width.
- Cards, controls, and toolbars use responsive constraints to prevent layout
  movement.
- Keyboard users can traverse tabs, groups, cards, details, menus, and the
  primary action with predictable focus.
- Selection and active state are distinct in both visual styling and ARIA.
- The dialog restores focus to its invoker and preserves the existing unsaved
  edit guard.
- Arabic uses logical properties and correct RTL order.

## 7. Data Architecture

### 7.1 Official catalog metadata

The official character catalog gains presentation and capability metadata:

```text
categoryId
editorialOrder
featured
visualKey
summary
suitableFor[]
requiredInputs[]
workflow[]
deliverables[]
qualityChecks[]
boundaries[]
```

Stable identifiers and ordering are locale-independent. Human-readable content
is localized in Chinese, English, and Arabic. This metadata is official-catalog
data only and does not alter the character-card canonical schema.

### 7.2 Normalized renderer summaries

The renderer maps official and local entities into a presentation-only summary:

```text
id, kind, source, name, summary, categoryId, tags,
visualKey, revisionId, active, installed, updateAvailable,
recentlyUsedAt, archivedAt, health
```

The normalized summary is not persisted as a second source of truth. Entity and
revision repositories remain authoritative.

### 7.3 Detail loading

List calls remain summary-oriented. Canonical revisions and world-book detail
are loaded only when a card is selected. Detail responses are cached by immutable
revision ID, bounded in size, and invalidated when the current revision changes.

### 7.4 No destructive migration

Existing local characters, personas, world books, bindings, revisions, and
official installations remain valid. Missing new metadata maps to an
"Uncategorized" group and a compact legacy detail view. It never hides an
existing entity.

## 8. Official Professional Catalog

The first production catalog contains 18 roles.

### Work and delivery

1. Senior Product Manager
2. Delivery Project Manager
3. Meeting Execution Assistant
4. Contract Risk Reviewer
5. Spreadsheet Automation Specialist
6. Chinese Enterprise Legal Counsel

### Research and analysis

7. Deep Researcher
8. Data Analyst
9. Market and Competitive Intelligence Analyst

### Content creation

10. Executive Content Editor
11. Business Writing Advisor
12. Presentation Strategist

### Technology and creation

13. Principal Architect
14. Systems Troubleshooter
15. Automation Solution Engineer

### Learning, decisions, and life

16. Learning Coach
17. Strategic Decision Advisor
18. Thoughtful Companion

The companion remains available under Life Support but is not promoted on the
production-first landing group.

### 8.1 Professional-role contract

Every official professional role must:

1. establish the user's objective, constraints, source material, and success
   criteria before doing consequential work;
2. separate facts, inferences, assumptions, and unknowns;
3. use tools and current authoritative sources when the task requires them;
4. follow a role-specific workflow rather than output generic advice;
5. produce a named, usable deliverable;
6. run role-specific quality checks before claiming completion;
7. expose uncertainty and request missing critical input;
8. preserve Lily's permission, evidence, tool, and capability rules;
9. avoid inventing authority, credentials, facts, citations, or completed work.

### 8.2 Chinese Enterprise Legal Counsel

The featured professional role **Chinese Enterprise Legal Counsel** is separate
from Contract Risk Reviewer and focuses on mainland
China enterprise matters including labor and employment, intellectual property,
corporate governance, compliance, and dispute-path analysis.

Its mandatory contract is:

- confirm that mainland China is the relevant jurisdiction and identify any
  cross-border element;
- establish the material date and verify law/regulation currency when needed;
- cite current primary legal authority near supported conclusions;
- distinguish supplied facts, legal rules, analysis, and unresolved questions;
- provide practical options, risk level, and documents or evidence still
  required;
- never claim to be licensed counsel or guarantee an outcome;
- recommend qualified human counsel for litigation, criminal exposure,
  irreversible deadlines, major transactions, or materially incomplete facts.

## 9. Persona and World-book Templates

Persona templates are professional questionnaires, not finished identities:

- Workplace identity
- Founder or business owner
- Content creator
- Research professional
- Learner

World-book templates define fields, entry groups, examples, and validation:

- Project knowledge base
- Brand voice guide
- Product glossary
- Customer support SOP
- Story-world bible

Templates have explicit completion state. Incomplete placeholders are excluded
from runtime compilation.

## 10. Failure and Capability Safety

- Official catalog load failure preserves and displays local entities.
- Unknown category or malformed optional metadata falls back to legacy display.
- Detail-load failure does not remove the selected card or alter the binding.
- Install/update failure does not bind a partial official character.
- Persona validation failure blocks activation and points to missing fields.
- A corrupt or over-budget world book is skipped according to existing
  character-worlds fail-open rules; native conversation capability remains.
- Search/filter errors fall back to the unfiltered loaded list.
- No UI failure may disable chat, native Lily mode, or existing character
  controls.
- `LILY_CHARACTER_WORLDS=0` continues to restore native behavior without
  deleting library data.

## 11. Testing and Acceptance

### 11.1 Pure model tests

- category derivation and counts;
- deterministic ordering;
- search across names, capability terms, scenarios, and tags;
- filters and archived/active/recent groups;
- official/local normalization and legacy fallback;
- selected versus active state;
- responsive layout-state decisions where implemented in JavaScript.

### 11.2 Electron DOM tests

- character, persona, and world-book tabs;
- group navigation and responsive grid rendering;
- details loading and explicit activation;
- all existing edit/history/duplicate/export/archive/import flows;
- official install/update/bind success and failure atomicity;
- persona completion guard;
- multi-world-book activation, conflict, and budget presentation;
- focus trap, focus restoration, keyboard navigation, ARIA state, and dirty-form
  protection;
- Chinese, English, Arabic, and RTL rendering.

### 11.3 Catalog contract tests

- stable unique IDs and category IDs;
- complete localization;
- every professional role contains inputs, workflow, deliverables, checks, and
  boundaries;
- official display metadata does not leak into or mutate canonical user data;
- legal-role jurisdiction, material-date, primary-source, uncertainty, and
  human-counsel boundaries are mandatory.

### 11.4 Scale and visual verification

- seed 30, 100, and 500 items and verify filtering and scrolling remain usable;
- capture wide, medium, and narrow Electron screenshots;
- verify three-, two-, and one-column layouts;
- verify long Chinese, English, and Arabic labels do not overlap or resize the
  card grid;
- confirm detail drawers and menus do not cover the primary action.

## 12. Delivery Sequence

1. Pure library presentation model and tests.
2. Official catalog metadata and professional role content.
3. Three-pane character library shell and details activation flow.
4. Persona templates, detail view, and completion guard.
5. World-book templates, detail view, multi-book status, and activation flow.
6. Responsive, accessibility, localization, and visual regression pass.
7. Full capability-gate and renderer regression suite.

The sequence preserves existing behavior at every checkpoint. The old list may
remain as an internal fallback until the new shell passes functional and visual
acceptance, then be removed in the same release.
