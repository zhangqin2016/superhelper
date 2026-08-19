# Legal Knowledge Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the official China enterprise legal character automatically acquire, cache, and search an authorized legal knowledge pack without reviving persona or world-book behavior.

**Architecture:** The customer ZIP is an offline source package, not a runtime dependency. A release-time builder converts it into a signed, read-only legal pack containing normalized metadata, searchable article chunks, and source pointers. The server stores immutable Qiniu artifact metadata and returns the newest artifact only after signed-device and plan entitlement checks. The desktop app downloads the pack on first use of the official legal character, verifies its size and SHA-256, installs it atomically under app data, and exposes a bounded `lily_legal_search` broker tool backed by local SQLite FTS5.

**Tech Stack:** Node.js 24, Electron main process, built-in `node:sqlite` with FTS5, Fastify, Kysely/PostgreSQL migrations, JSZip for release-time source ingestion, existing signed-device and resumable artifact download utilities.

---

### Task 1: Define the legal pack contract and source-package builder

**Files:**
- Create: `src/main/legal-kb/legal-kb-contract.js`
- Create: `scripts/build-legal-kb-pack.mjs`
- Test: `scripts/test-legal-kb-contract.mjs`
- Test: `scripts/test-build-legal-kb-pack.mjs`

- [ ] **Step 1: Write failing contract tests**

  Test that valid metadata accepts `packId`, `contentVersion`, `sha256`, `sizeBytes`, and `schemaVersion`; rejects unsafe paths, missing versions, invalid hashes, and executable payload entries; and normalizes customer ZIP backslash paths to POSIX relative paths.

- [ ] **Step 2: Run the focused tests and verify the expected missing-module failures**

  Run `node scripts/test-legal-kb-contract.mjs && node scripts/test-build-legal-kb-pack.mjs`.

- [ ] **Step 3: Implement the contract and builder**

  The builder must read `laws_manifest.json`, `version_lineage.json`, and legal Markdown files from the customer ZIP, reject path traversal, ignore `tools/`, `vendor/`, HTML, JavaScript, and executable files, extract article-shaped sections into bounded chunks, and write a deterministic pack directory containing `manifest.json`, `catalog.json`, `articles.jsonl`, and `lineage.json`. It must never execute customer-provided code.

- [ ] **Step 4: Run the focused tests and verify the generated fixture pack**

  Run the two focused tests again. Expected: all assertions pass and the fixture pack contains only data/index files.

### Task 2: Add server-side immutable pack records and entitlement-gated resolution

**Files:**
- Create: `server/migrations/029_legal_knowledge_packs.sql`
- Create: `server/src/routes/admin/legal-knowledge-packs.js`
- Create: `server/src/routes/public/legal-knowledge-packs.js`
- Modify: `server/src/routes/admin.js`
- Modify: `server/src/routes/public.js`
- Test: `scripts/test-legal-knowledge-pack-server.mjs`

- [ ] **Step 1: Write failing route/service tests**

  Test that admin registration stores a legal pack record, public resolution requires a signed device request, a device without the configured plan gets `NOT_ENTITLED`, disabled or unknown character ids return no artifact, and the returned artifact contains only the Qiniu URL plus immutable checksum/version metadata.

- [ ] **Step 2: Run the focused server test and verify it fails before route registration**

  Run `node scripts/test-legal-knowledge-pack-server.mjs`.

- [ ] **Step 3: Implement the migration and routes**

  Store `pack_id`, `character_id`, `version`, `url`, `sha256`, `size_bytes`, `format`, `schema_version`, `min_plan`, `enabled`, and timestamps. Register an admin upsert/list/enable surface. Add `POST /api/legal-kb/artifact` using the existing signed-device verifier and plan resolver. The public endpoint must not expose URLs through an unsigned catalog.

- [ ] **Step 4: Run the focused server test and verify entitlement behavior**

  Run `node scripts/test-legal-knowledge-pack-server.mjs` and the relevant server unit tests.

### Task 3: Add client artifact resolution and atomic local installation

**Files:**
- Create: `src/main/legal-kb/legal-kb-paths.js`
- Create: `src/main/legal-kb/legal-kb-installer.js`
- Modify: `src/main/service-client.js`
- Modify: `src/main/config.js`
- Test: `scripts/test-legal-kb-installer.mjs`

- [ ] **Step 1: Write failing installer tests**

  Test cache lookup, resumable download delegation, checksum mismatch cleanup, disk-space rejection, archive path traversal rejection, ignored executable files, and atomic replacement of a previous good version.

- [ ] **Step 2: Run the focused installer test and verify the missing-module failure**

  Run `node scripts/test-legal-kb-installer.mjs`.

- [ ] **Step 3: Implement the installer**

  Resolve the pack with `serviceClient.legalKnowledgePackArtifact`, download through `runtime-pack-download` with a legal-pack size cap, hash the completed artifact, validate the generated pack manifest, install into `userData/legal-kb/<packId>/<version>`, write an install state, and replace only after every validation succeeds. Concurrent callers for the same pack must join one active promise.

- [ ] **Step 4: Run focused installer tests and verify crash-safe behavior**

  Run `node scripts/test-legal-kb-installer.mjs` and `node --check` on all changed main-process files.

### Task 4: Implement local legal search and broker exposure

**Files:**
- Create: `src/main/legal-kb/legal-kb-search.js`
- Create: `src/main/legal-kb/legal-kb-manager.js`
- Modify: `src/main/mcp/tool-broker-registry.js`
- Modify: `src/main/mcp/tool-broker-mcp.js` only if dependency injection is required
- Test: `scripts/test-legal-kb-search.mjs`
- Test: `scripts/test-legal-kb-tool.mjs`

- [ ] **Step 1: Write failing search/tool tests**

  Test exact title and article retrieval, Chinese bigram FTS ranking, bounded result counts, source/version/verification fields, no arbitrary filesystem access, and a clear `LEGAL_KB_NOT_READY` result before installation. Test the official legal character tool description and read-only annotations.

- [ ] **Step 2: Run focused tests and verify they fail for the missing search/tool implementation**

  Run `node scripts/test-legal-kb-search.mjs && node scripts/test-legal-kb-tool.mjs`.

- [ ] **Step 3: Implement the local store and read-only broker tool**

  Build SQLite FTS5 from the release pack on install, query only the active installed pack, cap query length/top-k/excerpt bytes, and return evidence objects suitable for the existing `knowledge_base` evidence ledger. The tool is platform-safe and read-only; the legal character guidance instructs the model to call it before legal conclusions. No world-book or persona APIs are touched.

- [ ] **Step 4: Run focused search/tool tests and inspect the returned evidence shape**

  Run both focused tests and verify returned results include `title`, `article`, `excerpt`, `verified`, `version`, `sourcePath`, and `packVersion`.

### Task 5: Make first use automatic and observable

**Files:**
- Modify: `src/main/character-worlds/compile-turn-context.js`
- Modify: `src/main/character-worlds/official-character-catalog.js`
- Modify: `src/main/work-progress-protocol.js` only if an existing event shape cannot represent the download
- Test: `scripts/test-legal-kb-character-activation.mjs`

- [ ] **Step 1: Write the failing activation test**

  Test that an official revision with `source.officialId === "lily-cn-legal-counsel"` requests the legal pack once before the turn is sent, while custom characters, native Lily, and all persona/world-book snapshots do not request it.

- [ ] **Step 2: Run the focused activation test and verify the expected failure**

  Run `node scripts/test-legal-kb-character-activation.mjs`.

- [ ] **Step 3: Implement activation wiring and user-facing progress**

  Ensure the pack through a cancellable, deduplicated manager call before the legal character turn proceeds. Emit existing download progress events with a human-readable label and retain the last good installed version when an update fails. If the pack cannot be obtained, return an explicit legal-role dependency error rather than silently presenting unsupported legal conclusions.

- [ ] **Step 4: Run the focused activation tests and renderer/main syntax checks**

  Run the focused test, `node --check` for changed files, and `git diff --check`.

### Task 6: Document release and verification flow

**Files:**
- Create: `docs/legal-knowledge-pack.md`
- Modify: `README.md` only if the project already documents artifact release commands there
- Test: `scripts/test-legal-kb-release-manifest.mjs`

- [ ] **Step 1: Write the failing release-manifest test**

  Verify a generated pack has deterministic content, no `tools/` or executable payload, a manifest checksum, and a reproducible artifact size.

- [ ] **Step 2: Implement release documentation and manifest verification**

  Document the offline conversion command, Qiniu upload key convention, admin registration payload, entitlement setup, rollback procedure, and the user experience for first download/update/failure. State clearly that the customer source package is not shipped or executed directly.

- [ ] **Step 3: Run the complete focused legal-pack suite and the existing relevant regression tests**

  Run every `scripts/test-legal-kb-*.mjs`, the character-card-only focused suite, syntax checks, and `git diff --check`. Report any unrelated pre-existing full-suite failures separately.
