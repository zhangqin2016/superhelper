# Media Provider Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver server-owned media provider contracts so Lily agents and scripts stop guessing provider request formats.

**Architecture:** Add an additive `effectiveConfig.media.contracts` block from the server, expose it through desktop media settings and AGENT.md, then migrate generation scripts to contract execution while preserving existing provider-specific fallbacks. Lily GPU contracts can be generated from the upstream service OpenAPI schema, so switching GPU models/services can change the parameters without hardcoding new client logic.

**Tech Stack:** Node.js ESM server, Electron main CommonJS modules, Lily skill Node scripts, existing `scripts/test-*.mjs` test runner.

---

### Task 1: Server Contract Delivery

**Files:**
- Create: `server/src/services/media-provider-contracts.js`
- Modify: `server/src/services/client-config.js`
- Test: `scripts/test-media-provider-contracts.mjs`

- [x] Write failing tests proving built-in Lily speech contract is delivered, filtered by configured endpoint, and contains voice defaults/enums/aliases.
- [x] Implement built-in contract helpers with a small schema: selected provider, endpoint env, auth env, request template, params, response extraction, and error policy.
- [x] Add OpenAPI `GenerateRequest` schema conversion so live Lily GPU service params can replace stale built-in defaults.
- [x] Include contracts in `effectiveConfig.media.contracts` without removing existing env delivery.
- [x] Run `node scripts/test-media-provider-contracts.mjs`.

### Task 2: Desktop Contract Consumption and AGENT.md

**Files:**
- Modify: `src/main/media-provider-settings.js`
- Modify: `src/main/skill-manager.js`
- Test: `scripts/test-agent-guide-i18n.mjs`

- [x] Write failing tests proving AGENT.md lists Lily speech voice enum/default from the delivered contract.
- [x] Expose effective media contracts from remote config through media settings.
- [x] Render contract parameter defaults/enums in the current provider section.
- [x] Run `node scripts/test-agent-guide-i18n.mjs`.

### Task 3: Contract Executor for Speech

**Files:**
- Create: `resources/skills/lily-speech-generation/scripts/media-contract-executor.cjs`
- Modify: `resources/skills/lily-speech-generation/scripts/generate-speech.cjs`
- Test: `scripts/test-media-generation-skills.mjs`

- [x] Write failing tests proving speech generation can execute a provider contract from `LILY_MEDIA_CONTRACTS_JSON`.
- [x] Implement contract validation, alias/default application, template materialization, and JSON request construction; reuse the existing speech script result extraction and download path.
- [x] Make speech script prefer contract execution when a matching provider contract exists, then fall back to existing logic.
- [x] Make video script prefer contract execution when a matching provider contract exists, then fall back to existing logic.
- [x] Run `node scripts/test-media-generation-skills.mjs`.

### Task 4: Capability Gate and Regression

**Files:**
- Modify: `CAPABILITY-GATE.md`
- Run focused tests.

- [x] Register the new media provider contract guard.
- [x] Run `node scripts/test-media-provider-contracts.mjs`.
- [x] Run `node scripts/test-media-gateway-providers.mjs`.
- [x] Run `node scripts/test-media-generation-skills.mjs`.
- [x] Run `node scripts/test-agent-guide-i18n.mjs`.
- [ ] Commit and push.
