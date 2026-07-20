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
