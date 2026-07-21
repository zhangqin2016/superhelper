# Evidence Gate Model-First Refactor (2026-07-20)

## The field failure

A user asked "中国有哪些建筑公司是副部级别". The evidence gate answered with
two paragraphs of zero-content refusal ("现有材料仍没有…逐项闭合证据") after
eight real searches that had actually opened sasac.gov.cn. Root cause: the
gate's semantic decisions were driven by trilingual regex vocabularies
(`副部级|中管企业|三甲|双一流|ministerial-level|…` in
`external-claim-profiles.js` / `external-fact-policy.js`). For informal-label
questions those vocabularies demanded `official_primary` sourcing plus
item-level closed evidence against an official roster **that does not exist**
(the label is industry shorthand) — an unsatisfiable requirement, so every
researched answer was replaced by the refusal.

User decision (2026-07-20): this is a general platform — hardcoding any
domain's vocabulary is wrong. **The model judges semantics; code judges
literals.** Fail boundary: ordinary asks fail OPEN (keep the answer under an
unverified banner), genuinely high-stakes asks fail CLOSED.

## The architecture that replaced it

- **Turn-start detection is domain-blind** (`external-fact-policy.js`).
  Only request-SHAPE triggers remain: ranking, superlative, freshness
  (最新/今天/现任 + a question), explicit web research, user URLs, plus the
  single `high_stakes` floor (medical/legal/finance) that exists solely for
  the fail-closed boundary. `DYNAMIC_DOMAINS`, `PROFILE_DEFINITIONS` and all
  domain regexes are deleted; the baseline verification plan is always empty.
- **The model declares semantics** through the `lily_intent_contract_commit`
  verification-plan candidate (`applyModelVerificationPlanCandidate` →
  `model-turn-contract-refinement.js`): claim kinds, scope dimensions,
  `entityEvidenceRequired`, pinned `authorityHosts`, declared
  `sourceAuthority` tier. Observed web research also promotes a general task
  into the gate (`activateExternalFactPolicyFromObservation`).
- **Turn-end: ONE unified semantic judge call**
  (`evidence-entailment-judge.js#judgeTurnSemantics`, via
  `answer-evidence-finalizer.js#evaluateAnswerEvidenceWithJudge`) rules claim
  entailment, source authority, conflicts, informal-label framing, and stakes
  in a single structured verdict. The deterministic floor runs first and after:
  URL grounding, entity presence, numeric grounding, ledger counts.
- **Hard floors the judge can never cross**:
  - a claim with NO real evidence window is never sent to the judge
    (fabricated entities stay stripped, line-wise, with a removal note);
  - judge-ruled conflicts are never banner-kept;
  - pinned `authorityHosts` (user/model-declared) are an absolute floor;
  - judge unavailable/malformed → ordinary tiers fail open bounded
    (`composeFramedBoundedAnswer`), high-stakes fail closed
    (`safeExternalFactFallback`). Kill switches: `LILY_EVIDENCE_LLM_JUDGE=0`,
    `LILY_EVIDENCE_RISK_TIERS=0`.
- **Failure precedence in `external-claim-gate.js`**: conflicts > fabrication
  (entity absent from evidence) > authority-pending > support-pending —
  fabrication is never masked as a source-tier issue. A *satisfied* host pin
  IS the authority decision (no further adequacy verdict for those urls).
- **Risk tiers** (`externalFactRiskTier`): `high_stakes` reason (or judge
  `stakes: "high"`) → hard; anything else required → verify_soft; not
  required → advisory. `HARD_RISK_REASONS = {high_stakes}` only.

## Why the old design could never work

A regex vocabulary must enumerate every domain's defining facts in every
language the product ships. Users always have other words for the same
question (俗称、级别、档次、行政序列…), and each miss is either a capability
regression (gate stays silent) or an unsatisfiable demand (gate asks for a
roster that doesn't exist). The vocabulary also leaked one country's
administrative taxonomy into a general product. Semantic judgment is what the
model is for; the platform's job is the literal floor and the fail boundary.

## Guards

- `scripts/test-external-evidence-recovery.mjs` asserts the gate's production
  sources contain no domain vocabulary (`副部级|中管|三甲|双一流|…`).
- `scripts/test-evidence-entailment-judge.mjs` pins the judge contract:
  windowless claims never judged, verdict strict-parsed, judge-down fail
  boundary, citation repair precedes the judge.
- `scripts/test-evidence-risk-tiers.mjs` pins "delivered content never drops
  to zero after real research" using the live 副部级 case.
- After protocol changes: full app restart (`npm start`).

## Field follow-up (same day, evening): the judge never actually ran

Post-deploy messages.db inspection showed `semanticJudged` absent on every
gated turn — the judge was failing SILENTLY and every external-fact answer
took the "auto re-check once + unverified banner" fail-open path even with
good evidence. Root causes and fixes:

- **Silent failure was the bug.** `judgeTurnSemantics` returned null for five
  distinct reasons (disabled, no judgable input, connection unresolved,
  transport empty, verdict unparseable) with zero observability. Now every
  null path records `diagnostics.reason` and the finalizer persists it as
  `judgeUnavailable` in the gate meta (readable from messages.db) plus one
  `log.warn` per turn. Never add a fail-open path without a recorded reason.
- **8s timeout was too tight for thinking models** (deepseek-v4-pro spends
  seconds reasoning before the verdict JSON). Default now 15s; judge
  max_tokens 2000 → 4000 (`reasoning_content` is parsed too).
- **Entity extraction noise polluted pending/unsupported** — markdown
  emphasis leaked into labels (`**副部级**` never literal-matches evidence),
  list-item prose fragments with sentence punctuation were captured as
  "entities", and markdown table HEADER cells ("企业") became claims. Fixes
  in `entity-claim-evidence.js` are all mechanical (strip `*`/backticks,
  drop labels with sentence punctuation or >30 chars, drop CJK structured
  labels containing digits/whitespace, skip rows followed by a `|---|`
  separator) — still zero domain vocabulary.
- Diagnostics caveat: `remote-config-cache.json` is safeStorage-encrypted
  and ACL-bound to the real app binary — a bare `electron` script cannot
  decrypt it (neither `lily-workbench` nor `智能工作台` app names). Diagnose
  via the persisted gate meta instead.
- `test-architecture-boundaries.mjs` ratchets `answer-evidence-finalizer.js`
  at 578 lines — additions must be line-neutral (trim docs, compact blocks)
  or extract a module.

## Field follow-up 2: "世界杯冠军" — the model has no clock

Same evening field test: user asked "世界杯冠军" on 2026-07-20 — the day
AFTER the 2026 World Cup final. The turn classified general/fast/casual (no
freshness term matched, mechanical classifier stayed silent, which is BY
DESIGN — no false banner). But the model answered entirely from training
memory, listing winners through 2022 and calling 2026 "next edition": it had
no way to know the final was yesterday. Root cause: NOTHING in the whole
prompt chain (platform_context, execution_constraints, task contract, agent
defaults) carried the current date. A model can't judge date-sensitivity it
can't see. Fix: `src/main/turn-clock-context.js` injects one
`Current date/time: … (UTC±n)` line + freshness guidance into
platform_context every turn (zero net lines in the ratcheted orchestrator —
the parts-array initialization carries it). The JUDGMENT of whether to search
stays with the model; the platform just gives it a clock. Tests:
`scripts/test-turn-clock-context.mjs` (use fake `now` objects — the runner's
own zone is not the user's; this machine is UTC+4, not +8).

## Field follow-up 3: two-pass → one-pass (citation guidance up front)

After the clock fix, "世界杯冠军" searched on pass 1 but still needed the
auto-verify retry: the model cited ZERO urls on a casual turn (no contract
layer reaches casual turns, so nothing told it to cite) and years
("2026/2018/2014") were gated as numeric pseudo-entities absent from
evidence. The retry did the deep work (opened 新华社 page, cited) — correct
safety net, but a visible second Q&A. Fixes: (1) the clock line now also says
"when you use live sources, cite the URLs you relied on" — the model provably
reads platform_context (it searched BECAUSE of the clock line), so the
citation expectation now arrives BEFORE composition, not after failure;
(2) `isPlausibleEntityLabel` drops pure-numeric labels (`^\d[\d.,%]*$`) —
numbers are facts ABOUT entities, never entities. Judge confirmed working in
production (`semanticJudged: true`, accepted claims recorded); the retry path
stays as the fail-safe for genuinely under-researched first passes.

## Field follow-up 4: judge timeout at 15s + model research-discipline failures

Third field round ("世界杯冠军"): pass 1 the model SAID it would search and
then answered entirely from memory (zero tool calls); the gate failed it
(external_fact_without_source_link) and the retry did search — but cited two
toutiao URLs from MEMORY (not in tool results), which citation repair
correctly stripped (fabricated citations are worse than none). The judge was
then invoked but hit `timeout_15000ms` (deepseek thinking model spends >15s
reasoning before the verdict JSON). Fixes: judge timeout 15s → 30s with a
smaller prompt (MAX_JUDGED_CLAIMS 8 → 5, evidence windows 700 → 450 chars in
the finalizer's claimParams), and the last extraction leak closed —
suffix-less CJK structured labels >12 chars are sentences, not names
("这是西班牙队史第二座世界杯冠军"). Lesson: judge latency budget must match
a THINKING model's reasoning time; keep the verdict prompt small so the
budget goes to the verdict. Model-compliance failures (say-search-but-don't,
fabricate citations) are the engine's variance — the deterministic floor +
judge caught every one; do NOT patch them with more deterministic rules.

## Field follow-up 5: verdict_unparseable — thinking models emit brace-heavy reasoning

Fourth field round: pass 2 was clean (authoritative pages, coverage table, no
banner) but the judge verdict was LOST: `verdict_unparseable`. Root cause:
deepseek-v4-pro emits its reasoning BEFORE the verdict, and the reasoning
itself contains braces (`{claim 1}`, draft JSON) — the greedy
first-`{`-to-last-`}` regex spanned reasoning + verdict and never parsed.
Fix: `extractVerdictJson` scans balanced one-level-deep JSON candidates and
takes the LAST one that parses AND carries verdict keys (the final answer
trails the reasoning); max_tokens 4000 → 8000 so reasoning cannot consume the
budget and truncate the verdict mid-JSON. Also dropped bracket-wrapped labels
(`[央广网]`) — citation markers in the answer's own source column. Pass-1 gap
is now pure model compliance (names sources but omits URLs); no deterministic
patch is appropriate for that.

## Field follow-up 6: timeout_30000ms — reuse the compat overlay; named-but-unread sources

Fifth field round: judge parse fix CONFIRMED in production (pass 1
`semanticJudged: true`), but pass 2 hit `timeout_30000ms` — 30s is still not
enough when a thinking model spends the budget reasoning. Fix: the judge
connection now carries the preset's `LILY_OPENCODE_BODY_OVERLAY_JSON`
(compatibility-probe contract, e.g. `chat_template_kwargs.enable_thinking:
false`) into the request body — thinking-disabled gateways answer in seconds.
If a gateway has no such overlay the probe never learned one, and
`judgeUnavailable` keeps reporting honestly. Same round: the model named
"Reuters/AP News/USA Today" as sources WITHOUT opening them — correctly
gated (names absent from evidence); citation repair appended the turn's real
grounded URLs. Clock guidance now demands a concrete format: a final "来源"
section with exact URLs copied from tool results — source names alone do not
count.

## Field follow-up 7 — "证据门槛" false positive on task turns (2026-07-20)

A tower-defense build turn did REAL verification (`node --check` syntax pass,
`curl` HTTP 200) yet the final answer got the "证据门槛：缺少可核验证据支撑"
notice appended. Root cause chain: `evidence-ledger.js` only classified a bash
call as `verification` when the command matched a hardcoded runner list
(`commandLooksLikeVerification`: npm test / pytest / vitest / jest / playwright /
tsc / eslint / cargo test / go test). `node --check` and `curl` fell through to
kind `command`, so `hasVerificationEvidence` stayed false; the answer said
"验证通过" → `evidence-gate.js assessPolicyBackedClaims` fired
`verified_claim_without_verification` (advisory) and the finalizer appended the
warning. Fix (generic, no new hardcoding): ledger summary now exposes
`hasCommandEvidence` — any successful command/verification event counts as
executed verification (exit-code success is a mechanical signal, not a keyword
list); the VERIFIED_RE check accepts it. The guarded lie narrows to "claims
verified with zero successful command runs", which is the actual failure mode.
Tests: `test-evidence-ledger.mjs` (success→true, failed→false),
`test-evidence-gate.mjs` (command-backed "验证通过" passes).

## Field follow-up 8 — full fail-open: decorators retired, gate never rewrites (2026-07-20)

User ruling: "感觉我们加了证据之后越来越蠢了" — four user-visible misfires in
one day (副部级 refusal, World Cup banner, tower-defense "证据门槛", Excel
"未通过" jargon) proved that EVERY gate-authored decoration or replacement
degrades the product. Final direction: 判断交给大模型,贯彻到底.

What changed (plan A, zero content refusals anywhere):
- `answer-evidence-finalizer.js`: OK path delivers the original verbatim
  (informal-label rulings are assessment meta only). External-fact failure
  delivers `original` (retry pending) or `original + one plain-language
  honesty note` ("备注:以上回答未能通过本轮逐项核实") — never a bounded
  banner, never a stripped roster, and the high-stakes fail-closed branch is
  deleted entirely. Document-delivery failure keeps the literal-fact
  replacement only for missing output_file/structure; everything else gets
  `original + documentDeliveryNote`. catch path fail-opens for every tier.
  The ONLY surviving content replacement is `safeSourceContentFallback`
  (attachment bytes never read ⇒ any content claim is fabricated by
  construction — a literal fact, not semantics).
- `external-evidence-recovery.js`: deleted `safeExternalFactFallback`,
  `boundedAnswerBanner`, `composeBoundedExternalAnswer`,
  `composeFramedBoundedAnswer`, `prependFramingNote`. Salvage (verified
  subset + disclosure line) is unchanged — it is inherently safe because the
  projected subset re-passes the full gate.
- `evidence-gate.js`: the keyword-class semantic checks (VERIFIED /
  ROOT_CAUSE / FIXED / COVERAGE / FRESH / MEDIA_OUTPUT / SOURCE_CLAIM) are
  demoted to telemetry — `collectPolicyAdvisoryReasons` returns reason
  strings riding on the assessment as `advisoryReasons`, never `ok:false`.
  `appendEvidenceGateNotice` is gone. Literal checks (numbers, URLs,
  citations, entities absent from evidence) stay hard.

Strictness now flows to the learning loop (assessment meta → incident →
eval case), never to the user's eyes. Tests rewritten to encode the new
intent: fail-open verbatim delivery, honesty note at final failure, no
banners, conflicts delivered; the domain-vocabulary leak guards are kept.
