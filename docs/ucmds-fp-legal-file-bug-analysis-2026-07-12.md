# UCMDS FP Legal File Bug Analysis

Date: 2026-07-12  
Source: Anjaz UCMDS project, task search `FP Legal File`, plus `UCMDS-557` attachments `legal-adaptation-requirements.md` and `type_1_template.docx`.

## 1. Summary

- 36 matching bugs, all `To Do` and assigned to Qin Zhang.
- Tracker priority: 32 Medium, 4 Low (`UCMDS-636`, `UCMDS-631`, `UCMDS-627`, `UCMDS-612`).
- The 36 records collapse into eight shared implementation causes. Fixing by cause is safer than patching each screen independently.
- The authoritative scope is Phase 1 `Criminal File` only. Do not reuse this workflow for other file types.

## 2. Recommended implementation order

1. Route and menu isolation: UCMDS-595/596/597/598.
2. Canonical status, progress, and incident-change model: UCMDS-638/634/632/608/610/609/612.
3. Data adapters and generated section state: UCMDS-613/621/623/624/626/630/633.
4. Validation and editable field contracts: UCMDS-643/629/628/618/619.
5. Directionality/i18n primitives: UCMDS-641/627/625/616/614.
6. List-card mapping and empty states: UCMDS-642/640/639/637/635.
7. Layout polish: UCMDS-636/631/617/620.

## 3. Shared root-cause fixes

### A. Route and menu isolation

Create one Legal File route namespace and one route-state owner. A card opened from Legal Files must stay in the Legal Files detail route; the back action must return directly to the Legal Files list. Do not mount the Legal File entry or detail shell under Cases.

Acceptance tests:

- Legal Files list → card → detail → back returns to Legal Files list in one step.
- Cases detail contains no Legal Files menu or embedded Legal File shell.
- Narrow laptop viewport retains a usable editor area with independent TOC/content scrolling.

### B. Canonical file workflow state

Use one enum for Phase 1: `draft | in_review | ready`. Remove `referred` from the UI/API contract unless a newer approved requirement explicitly restores it. Define an explicit transition to `ready`, guarded by completion and required-field validation.

Keep generated and manual sections separate:

- Regenerate on incident change: S1, S4, S5, S7, S10.
- Preserve accepted AI suggestions for incidents that remain linked.
- Never reset manual sections S2, S3, S6, S8.
- S9 is permanently skipped and excluded from overall progress.

### C. Incident selection state

Maintain three explicit sets: persisted linked incidents, current draft selection, and the diff (`added`, `removed`). After first confirmation, both additions and removals must open the same confirmation dialog and list affected generated sections. Removing an incident must return it to the searchable candidate list.

The primary prosecutor must reference an item in the selected prosecutor set. When that prosecutor is removed, clear the primary selection or require a replacement.

### D. Directionality and bilingual input

Page direction and input direction are different concerns. Keep the English shell LTR and Arabic shell RTL, but set editable text fields to `dir="auto"` (or detect direction from the first strong character). Do not inherit RTL into English inputs. Apply the same shared input primitive to list search and Sections 1, 2, 7, and 8.

### E. Generated data adapters

Build deterministic adapters before invoking AI:

- S1 from Incident fields and incident-type lookup.
- S4 from attribution records.
- S5 from incident evidence aggregation.
- S7 from S5 custody/assessment plus S4 verification state.
- S10 from linked incident count and attachment rules.

AI should enrich only fields identified by the requirement. Empty source data must produce a visible empty/needs-data state, not a false 100% completion.

### F. Progress calculation

Centralize progress in a pure function. Exclude S9; calculate each section from its actual required fields/accepted generated results. Do not initialize S10 to complete when required page/note/generated values are empty. Recalculate after every incident diff, form save, AI accept/dismiss, and attachment import.

### G. Validation

Use the same schema on client and server. S8 `Reasons` is required before save/transition. Year is editable and validated as a four-digit value. `Likelihood of prosecution success` is one select field, not select plus free text.

### H. List projection

The Legal File card projection should expose `title`, `updatedAt`, `incidentCount`, `status`, and `progress`. If title is blank, derive it only after incident confirmation; do not use the menu label `Legal Files`. Search with zero matches must render an explicit empty state.

## 4. Bug records and proposed changes

| ID | Pri | Area | Bug record | Proposed change / acceptance |
|---|---|---|---|---|
| UCMDS-643 | Medium | Detail / S0 | Year is read-only although the requirement defines a year field. | Render an editable four-digit year input, persist it, and keep file-number generation consistent with the saved year. |
| UCMDS-642 | Medium | List | No empty state after a search has no matches. | Render a localized “No legal files found” state with a clear-filter action; do not leave a blank grid. |
| UCMDS-641 | Medium | i18n | Arabic text entered in the English UI is aligned/directed incorrectly in list and detail inputs. | Use `dir="auto"` on user-text fields while preserving LTR shell layout; test Arabic, English, and mixed strings. |
| UCMDS-640 | Medium | List | Card shows creation time instead of required update time. | Map card timestamp to `updatedAt`, update it after any successful file mutation, and label it as updated time. |
| UCMDS-639 | Medium | List | Linked incident count is missing. | Add `incidentCount` to the list projection and card; count persisted links, not current search selections. |
| UCMDS-638 | Medium | Workflow | UI has an unrequested `referred` status and no way to reach `ready`. | Restrict Phase 1 to Draft/In Review/Ready and add a validated Ready transition. Remove `referred` from filters, badges, DTOs, and tests. |
| UCMDS-637 | Medium | Create | Blank title becomes `Legal Files`. | Keep title null/blank until incident confirmation, then derive a meaningful title; never default from the navigation label. |
| UCMDS-636 | Low | Layout | Completion checkmarks sit too high in section forms. | Align the status icon with the section header’s flex center/baseline; add a visual regression check for common viewport sizes. |
| UCMDS-635 | Medium | Breadcrumb | Parent breadcrumb differs from requirement. | Use `Federal Prosecution / FP / Legal Adaptation` and its approved Arabic equivalent from the requirement. |
| UCMDS-634 | Medium | State/progress | Section linkage and progress do not follow the requirement. | Implement the centralized dependency graph and pure progress calculator described above; add table-driven tests for all section changes. |
| UCMDS-633 | Medium | S10 | Supplementary investigation control is display-only instead of functional. | Implement the specified modal: department, annex type, optional note, submit action, response state, and new-file marker. If real integration is unavailable, fail visibly rather than pretending upload occurred. |
| UCMDS-632 | Medium | S10 / progress | S10 is marked complete with no content. | Derive S10 progress from generated attachment rows and required values; empty source data must not equal 100%. |
| UCMDS-631 | Low | S10 / layout | Pages and Notes inputs have inconsistent sizes. | Use a shared field component and explicit grid widths/heights; verify Arabic and English layouts. |
| UCMDS-630 | Medium | S10 / generation | Pages and Notes are not auto-filled. | Populate page counts from the approved formulas and notes/source metadata through the S10 adapter; recompute on incident changes. |
| UCMDS-629 | Medium | S8 / validation | Save succeeds with empty required Reasons. | Add required validation client-side and server-side; block save/Ready transition and focus the field with a localized error. |
| UCMDS-628 | Medium | S8 | Likelihood field has an extra text box. | Keep a single High/Medium/Low select. Store rationale in the section’s analysis/reasons field, not a duplicate likelihood input. |
| UCMDS-627 | Low | S8 / i18n | Input text and caret are forced to the right in English. | Apply the shared `dir="auto"` text input behavior and LTR control chrome in English mode. |
| UCMDS-626 | Medium | S7 / AI | Gap analysis does not generate a list. | Generate candidates from broken custody, evidence needing reinforcement, and under-verification attribution; show run/loading/error/results states and Accept/Dismiss actions. |
| UCMDS-624 | Medium | S6 | Victims section lacks attachment import. | Add the optional Report/Annex 9/10/11 import action, preview extracted rows, require confirmation, and preserve manually entered rows. |
| UCMDS-623 | Medium | S5 / data | Evidence content is empty and not auto-filled. | Aggregate `INCIDENT_EVIDENCE` for linked incidents, map custody/evaluation fields, show source-data errors, and recalculate S7/S10 dependencies. |
| UCMDS-621 | Medium | S4 / data/UI | Responsible Persons style differs and automatic content is missing. | Render the official table structure, populate up to three attribution records, keep generated rows non-deletable, and allow additional manual persons. |
| UCMDS-620 | Medium | S3 / UI | Text areas and colors differ from approved HTML/requirement. | Normalize fields, state colors (Proven/Probable/Missing), table spacing, and analysis area using shared design tokens. |
| UCMDS-619 | Medium | S2 / spec | Characterization Guide appears although reporter says approved HTML omits it. | Resolve the source conflict before deletion: the attached requirement and official DOCX explicitly include `دليل التكييف` as a read-only reference table. Keep it unless product/design confirms the HTML is the newer authority. |
| UCMDS-618 | Medium | S2 | Crime rows are fixed at two although approved HTML allows add/delete. | Use a row collection with add/delete controls, stable row IDs, minimum-row rules, persistence, and validation. |
| UCMDS-617 | Medium | S2 / layout | Crime field is not aligned with other columns. | Put all crime-table cells on one grid/table geometry and share height/padding/border tokens. |
| UCMDS-616 | Medium | S2 / i18n | Placeholder and caret are on the right in English. | Use the shared bidi input component; localize placeholder text independently of text direction. |
| UCMDS-614 | Medium | S1 / i18n | Consolidated narrative caret is on the right in English. | Apply `dir="auto"` to the narrative editor and verify Arabic/English/mixed content. |
| UCMDS-613 | Medium | S1 / data/AI | Projectile field and AI-generated fields differ from requirement. | Map projectile count from `payload.total_projectiles`; implement the documented classification and preliminary-characterization rules, with Accept/Edit/Regenerate. |
| UCMDS-612 | Low | S0 / state | Removing a selected prosecutor leaves an invalid primary prosecutor selection. | Enforce referential integrity: clear the primary value when removed or block removal until another primary is selected. |
| UCMDS-610 | Medium | S0 / incident | Removed linked incident does not reappear as addable. | Candidate query must exclude only currently selected/persisted links; refresh candidates immediately after removal. |
| UCMDS-609 | Medium | S0 / incident | Existing-linked table appears to show only a hard-coded/limited set rather than the case’s actual linked incidents. | Load persisted case-file links from the backend with pagination; separate linked table from search-result limits. |
| UCMDS-608 | Medium | S0 / confirmation | Removing an incident warns after confirmation, but adding one does not. | Use a single diff confirmation for both added and removed incidents and list S1/S4/S5/S7/S10 regeneration effects. |
| UCMDS-598 | Medium | Responsive layout | Detail editor has an impractically small scrollable area on a laptop screen. | Use viewport-based height, sticky header/TOC, and one primary content scroller; define/test a minimum supported viewport. |
| UCMDS-597 | Medium | Navigation | Back navigation loops through Cases detail and Legal detail. | Replace history-dependent back behavior with an explicit Legal Files list destination; prevent duplicate route entries. |
| UCMDS-596 | Medium | Navigation | Opening a Legal File card routes to the Cases menu. | Route cards to the Legal File detail namespace and set active navigation from route metadata, not shared case identifiers. |
| UCMDS-595 | Medium | Menu/scope | Cases detail also shows Legal Files although this release should expose it only under Legal Files. | Remove the Legal Files entry/component from the Cases shell and add a route/menu visibility test. |

## 5. Important requirement conflict

UCMDS-619 says the approved HTML does not contain `Characterization guide`. However, both attached sources say it belongs in Section 2:

- `legal-adaptation-requirements.md` defines `دليل التكييف` as a six-row, read-only reference table.
- `type_1_template.docx` contains the heading `دليل التكييف` and the full six-row table.

Recommendation: do not remove it based only on the bug title. Product/design should confirm whether the group HTML is a newer approved source. Until then, the official DOCX is the stronger source for Arabic legal content.

## 6. Verification matrix

- Unit: status transitions, incident diff, progress calculation, S1/S4/S5/S7/S10 adapters, title fallback, primary-prosecutor integrity.
- API/integration: list projection (`updatedAt`, `incidentCount`), persisted links, S8 validation, supplementary request action.
- Component: bilingual direction, zero-search empty state, dynamic S2 rows, required error behavior.
- End-to-end: create blank file → link incident → confirm → edit links → verify regenerated/preserved sections → complete S8 → mark Ready → return to list.
- Responsive/visual: Arabic and English at laptop viewport, alignment of completion checkmarks, S2/S3/S10 field geometry, independent TOC/content scrolling.

## 7. Scope note

This workspace contains Lily Workbench, not the UCMDS application source. Therefore the recommendations identify component/service responsibilities and test intent, but cannot name verified UCMDS file paths or code symbols. Code-level patching requires the UCMDS frontend/backend repository or an accessible deployed test environment with source mapping.
