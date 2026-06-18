---
name: lily-intent-eval
description: Use when maintaining or evaluating Lily's intent routing examples, skill triggers, regression cases, or task classification quality across office, coding, UI, media, research, runtime-pack, and mixed tasks.
---

# Lily Intent Evaluation

Use this skill to keep routing examples and regression cases reliable. It evaluates which skill should trigger, not the user's end task.

## When to Use

- Adding or reviewing golden examples for intent routing.
- Comparing whether two skills overlap or one steals tasks from another.
- Investigating why the wrong skill triggered.
- Creating regression cases for office, code, UI, media, research, runtime-pack, web-system, or mixed tasks.

## Evaluation Output

For each example, produce input text, expected primary skill, optional supporting skills, reason, should-trigger examples, should-not-trigger examples, boundary notes, and misroute risk.

## Rules

- Route by intended deliverable, not incidental words.
- Prefer the most specific skill that owns the workflow.
- Mixed tasks may have one primary skill plus supporting skills.
- Do not route to high-risk automation unless the user clearly asks for it.
- Current language should not affect intent classification.

## Regression Quality

Good examples include positive cases, negative cases, and ambiguous mixed cases. A routing change is not complete unless it preserves earlier important examples or deliberately updates them with explanation.
