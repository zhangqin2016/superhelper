---
name: lily-research-synthesis
description: Use when the user needs current facts, source-backed summaries, comparisons, rankings, prices, policy/news updates, competitor research, or synthesis across multiple sources. Requires clear separation between sourced facts, inference, uncertainty, and practical next steps.
---

# Lily Research Synthesis

Use this skill when correctness depends on current or source-backed information. Search, compare sources, and synthesize rather than guessing from memory.

## When to Use

- Current news, prices, rankings, releases, policies, laws, schedules, public figures, or company facts.
- Competitor research, market scans, product comparisons, or source-backed summaries.
- Questions where the answer may have changed recently.

## Workflow

1. Clarify scope only if missing scope would make the research misleading.
2. Identify who owns or publishes the requested fact: regulator, registry,
   accreditor, appointing authority, issuer, dataset owner, or named benchmark.
3. Use broad search only for discovery. Once the source owner or official host is
   known, switch to a domain-constrained query and open the original page.
4. For a classification, verify whether the label is formally conferred. If it
   is shorthand, prove the underlying facts and separate them from inference.
5. For lists and rankings, keep a candidate-to-evidence map. Secondary lists may
   seed candidates, but every delivered item needs its own supporting passage.
6. Open sources when details, quotes, dates, or attribution matter.
7. Separate facts, inference, and uncertainty.
8. Provide dates for time-sensitive claims.
9. Cite sources or name exactly where facts came from.
10. Deliver the verified answer or verified subset first. Label completeness as
    complete or partial and say what could not be verified.

## Guardrails

- Do not invent sources, prices, dates, or rankings.
- Do not repeat a broad query after it returns the same low-authority source
  class. Change the source owner, source vocabulary, domain, or evidence target.
- Do not return only a research-process refusal when supported findings exist.
- Do not overquote copyrighted text.
- For medical, legal, financial, or safety topics, be explicit about limits and use high-quality sources.
- If search fails, say it failed and provide only stable background, clearly marked as such.
