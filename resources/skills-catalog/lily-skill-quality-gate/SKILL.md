---
name: lily-skill-quality-gate
description: Use when a Lily skill is being proposed, reviewed, prepared for release, or compared against existing skills, especially before publishing from the admin console or accepting a developer-submitted skill.
---

# Lily Skill Quality Gate

Use this skill to decide whether a skill truly improves Lily's platform capability rather than adding another prompt file.

## When to Use

- Reviewing a new skill or skill update before publishing.
- Comparing similar skills for merge, replacement, or removal.
- Checking trigger boundaries, output quality, safety, observability, and maintainability.

## Required Input

Skill directory or SKILL.md, manifest, target user and use cases, typical trigger requests, expected output, risk boundaries, and required permissions. If key information is missing, mark the review as insufficient information instead of guessing.

## Output Format

- Decision: pass, conditional pass, revise, or reject.
- Scores: 0-5 per dimension, total score, blockers.
- Evidence: concrete references to the skill text or missing parts.
- Required changes: minimum release-blocking fixes.
- Suggested changes: follow-up improvements.
- Regression examples: at least three should-trigger, two should-not-trigger, and one mixed-boundary example.

## Scoring Dimensions

Capability gain, trigger boundary, input/output clarity, execution specificity, verification path, failure recovery, safety and least privilege, observability, and maintainability.

Blockers include broad unsafe permissions, vague triggers, no verification path, dangerous operations, or unverifiable promises.
