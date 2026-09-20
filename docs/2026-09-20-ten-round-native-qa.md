# Ten-round Windows native QA

Requested follow-up: ten distinct test/inspect/repair/retest rounds. Source
Electron client, isolated 2GiB stress profile, synthetic workspace only.
No release, production configuration change or real-user data deletion.

## Round ledger

1. History loaded with the 4096-4099 tail and final fixture message; no new
   watchdog stall. Found false empty-onboarding flash during async load. Added
   request-owned loading/error/ready state; native regression pending restart.
2. Returned to ordinary conversation: prior three-point answer restored, no
   synthetic history leaked into it. No new issue observed in this switch.
3. Skills panel showed 34 selected skills; Escape dismissed it without losing
   the conversation/composer. No configuration was changed.
4. New missing-attachment starter enabled Send. Engine asked via question tool;
   selected re-upload. Found auxiliary judge timeout replacing genuine waiting
   answer with missing-file fallback (`novice-ui9`, 00:50:07 UTC). Repaired
   unavailable/invalid applicability handling: preserve answer + factual
   unverified-delivery note; never mark verified or auto-create outputs.
   Valid delivery verdicts still enforce literal file checks. Unit fault cases
   passed; native regression pending restart. Engine directory discovery before
   asking was observed, but no old table was substituted as the requested input.
5. Nonexistent explicitly named XLSX: no substitute or output, final waiting
   answer retained. `novice-ui10` returned invalid_answer_quote, exercising the
   repaired fallback in the real desktop, not just a mock.
6. Explicit real workbook: four net sales 115000/172000/144000/89000, total
   520000. Final in-chat answer survived; returned idle, no output requested.
7. Completion/send race: analysis finished while pause request was being typed.
   It became a new turn, was not lost, and acknowledged waiting in 7s. This is
   not counted as an accepted in-flight steer; that path passed the prior run.
8. Recovery audit found retries omitted accepted steers. Added exact-turn,
   worker-backed retrieval from durable user messages (not a full history scan).
   Replay now combines original request with ordered accepted revisions/files.
   Reopened-SQLite integration test passed, including read failure refusal and
   foreign turn/session exclusion. Actual isolated native turn
   `turn_95c2165b-d4b4-4b78-9d21-38044de436f7` returned its accepted pause
   revision through the new production reader. No real retry was sent by UI in
   this round; mechanism verification is distinguished from UI acceptance.
9. Restarted into `novice-ui11`: waiting answer persisted, 4103-message history
   displayed explicit loading text then the same synthetic tail. No false
   onboarding flash in the captured loading state. Returned to ordinary chat.
   Watchdog file contained only its two pre-existing entries, no new stall.
10. Completed with additional repair/retest iterations: real one-page Word generation after explicit user resumption,
    plus final regression matrix. This checks that stopping safeguards do not
    block legitimate subsequent delivery. Found two additional issues:
    helper discovery recursively searched development/install trees for 36s;
    stale bundled `soffice.cmd` pointed at an absent executable, shadowing the
    system-installed LibreOffice. Word COM fallback then waited over 100s.
    Stopped the synthetic task through the UI (returned idle, DOCX preserved).
    Added current-build literal helper directory to skill overlays and valid
    system-Office discovery as the fallback after bundled/managed Office.
    Resolved executable directory precedes legacy bin shims in PATH. No system
    configuration or real-user files changed. Native restart/retests below.

## Round 10 follow-up findings

- `novice-ui12` used the system LibreOffice successfully and produced a one-page
  PDF plus page PNG. Native client completed, and independent image inspection
  confirmed readable Chinese, four net sales and the correct total 520000.
- A printer-connection popup recurred during this run. Child environment now
  suppresses Windows printer-list/default-printer discovery for direct Office
  calls as well as the managed Python converter. This is not an OS setting.
- Follow-up inspection caught Office's private `python.exe` shadowing Lily's
  interpreter after PATH reordering. Corrected order retains Lily Python first,
  then real Office, then stale bin shims. Actual child imports of docx,
  pdfplumber, PIL and pypdfium2 succeeded with the bundled Python 3.12.10.
- `novice-ui13` restarted with both corrections and exported a 95,702-byte,
  one-page PDF. Original Word and workbook hashes remained unchanged. No
  printer popup was observed in the subsequent captures; the earlier popup's
  owning process was not established, so this is not all-Office certification.
- This exposed another real defect: the vision CLI successfully described the
  page but the delivery gate only recognized named image tools, not CLI visual
  evidence. It unnecessarily retried verification and appended a contradictory
  incomplete-visual-check note. Added a successful-call structured receipt,
  matched against rendered pages after rendering; failures and partial coverage
  remain unverified. Native `novice-ui14` follow-up completed in 52s, 12 steps,
  returned idle, and had no contradictory visual-check note or verify replay.
  Its actual engine tool records were replayed through the production delivery
  assessor with delivery explicitly required: verified, rendered 1 page,
  inspected 1/1, no missing checks, no retry recommended. One receipt observed.
  PDF copy in `output/final-qa-2/` has the same SHA256 as `final-qa/`:
  `90D2F0467296EA8830E8000D5D9971FB4F1CD717B25DF6D0351F0E4F008B0319`.
  Source Word/workbook hashes remained unchanged. Watchdog still contains only
  two pre-existing entries; no new main-loop stall recorded during these rounds.
- Original report SHA256 before/after first successful render:
  `44477472C84F44D52C49B30FE13932029846A47E0534C6E0640C33986B0BF185`.

## Verification boundaries

These ten rounds combine native UI acceptance, observed fault repair and
mechanism/SQLite integration tests; round 8 is explicitly not a UI retry test.
Not a signed installer, all skills, all models or arbitrary-duration long-task
certification. No commit, build or publication. Test-profile legacy migration
isolation and native retry-button coverage remain separate work.
Additional residual observations: restarting after internal document recovery
triggered the existing continuity-mismatch session reset; ui13 logged a task
graph projection warning (failed open). Neither blocked final delivery, but
their correctness is not certified by this run. The final copied PDF was named
in the answer without a visible attachment card; artifact-card parity remains
an additional UI coverage item. No claim of every defect being eliminated.

Each round records evidence and new findings; passing one scenario is not
all-platform acceptance. Existing unrelated working-tree changes are retained.
