# 2026-07-20 — document delivery gate false blocks (报销 excel case)

Symptom (user transcript): "重新生成excel 格式缺失" task produced the file, then
TWO rounds ended with the fallback "交付验证尚未通过（缺少：render →
visual_inspection, formula_recalculation）" despite the agent doing 36 real
verification commands (render_document.py runs, per-page RapidOCR, PDF checks).

Root causes (confirmed against messages.db `meta.documentDelivery` records):

1. **recalc requirement self-triggered by our own internal prompt.** Round 1
   (real user text) had `recalculated: true` (not required); the recovery turn's
   `userText` is `state.enginePayload.rawText` = the internal recovery prompt,
   which literally contains "公式"/"recalc.py" — `FORMULA_TASK_RE` matched it and
   invented a formula-recalculation requirement the original task never had.
   Fix: recalc is now **artifact-driven** — `xlsxContainsFormulas()` parses the
   xlsx zip central directory (offsets there are reliable even with data
   descriptors) and inflates only `xl/worksheets/*.xml` looking for `<f>` cells.
   No formulas → recalc never required; formulas → always required. Keyword
   heuristic (`FORMULA_TASK_RE`) deleted.

2. **OCR inspection invisible to the gate.** `IMAGE_INSPECTION_TOOL_RE` only
   credited image-reading tools (read/view_image/vision/…). The active model
   took the legitimate non-vision route — RapidOCR over every rendered page —
   and `visual.inspected` stayed 0. Fix: a successful command matching
   `OCR_COMMAND_RE` (rapidocr/tesseract/paddleocr/easyocr) whose text references
   a rendered page image counts as inspecting that page. Recovery prompt now
   explicitly offers the OCR route for non-vision models and names the
   anthropics-xlsx skill's recalc.py (the agent could not find it before).

3. **Internal identifiers leaked to users.** Fallback showed
   "缺少：visual_inspection, formula_recalculation". Fix: `MISSING_LABELS`
   (zh/en/ar) — users see "视觉检查、公式重算" style labels.

Retry budget context: `maybeToolCallRescueRetry` allows ONE recovery attempt
(`wasRescueAttempt` guard), so a second unverifiable verdict is final — false
blocks here are user-facing dead ends, not soft warnings.

Tests: `scripts/test-document-delivery-gate.mjs` — OCR-counts / OCR-unrelated /
formula-free xlsx + internal prompt / formula xlsx requires recalc.py / zh
fallback labels. `xlsxContainsFormulas` exported for tests.
