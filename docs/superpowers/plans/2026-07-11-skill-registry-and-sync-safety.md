# Skill Registry and Sync Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invalidate stale bundled skill caches by content and prevent catalog synchronization from destructively replacing Lily metadata.

**Architecture:** Compute deterministic SHA-256 revisions from normalized registry entries and preserve provenance through normalization. Make sync generate a validated temporary candidate by default; require an explicit apply flag for atomic replacement and restrict external sources to their namespaces.

**Tech Stack:** Node.js `crypto`, filesystem atomic rename, JSON registry schema, existing skill-catalog tests.

---

## File map

- Create `src/main/skill-registry-revision.js`: stable serialization and content revision helpers.
- Modify `src/main/skill-registry.js`: preserve provenance and compare revisions.
- Modify `resources/skills-registry/registry.json`: store the generated registry revision and current timestamp.
- Create `scripts/stamp-skill-registry.mjs`: regenerate entry and registry revisions deterministically.
- Modify `scripts/test-skill-catalog.mjs`: cache invalidation and provenance regressions.
- Modify `scripts/sync-skills-catalog.mjs`: candidate generation, invariant validation, and atomic apply.
- Modify `resources/skills-registry/catalog-sources.json`: namespace constraints for third-party sources.
- Modify `package.json`: safe default script plus explicit apply script.
- Create `scripts/test-sync-skills-catalog.mjs`: non-destructive and rejection tests.

### Task 1: Define deterministic registry revisions

- [ ] **Step 1: Add failing revision tests to `scripts/test-skill-catalog.mjs`**

Create two bundled registries with the same IDs, versions, and `updatedAt`, but different descriptions or capability hints. Assert the second registry replaces the cached first registry. Also assert `sourceKind: "bundled-vendor"` survives normalization.

```js
assert.equal(refreshed.skills.find((s) => s.id === "lily-ui-quality").description, "new description");
assert.equal(refreshed.skills.find((s) => s.id === "anthropics-pdf").sourceKind, "bundled-vendor");
```

- [ ] **Step 2: Run and confirm stale behavior**

Run: `node scripts/test-skill-catalog.mjs`

Expected: FAIL because cache comparison only checks timestamp and ID list, and `sourceKind` is dropped.

- [ ] **Step 3: Create `src/main/skill-registry-revision.js`**

```js
"use strict";
const crypto = require("node:crypto");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function entryRevision(entry) {
  const { contentRevision, fetchedAt, ...content } = entry || {};
  return sha256(content);
}

function skillContentRevision(entry, { skillMarkdown = "", manifest = null } = {}) {
  return sha256({
    entry: { ...entry, contentRevision: undefined, fetchedAt: undefined },
    skillMarkdown: String(skillMarkdown).replace(/\r\n/g, "\n"),
    manifest,
  });
}

function registryRevision(registry) {
  return sha256({
    schemaVersion: registry?.schemaVersion || 1,
    categories: registry?.categories || [],
    remoteIndexes: registry?.remoteIndexes || [],
    skills: (registry?.skills || []).map((entry) => ({ id: entry.id, contentRevision: entry.contentRevision || entryRevision(entry) })),
  });
}

module.exports = { stable, entryRevision, skillContentRevision, registryRevision };
```

- [ ] **Step 4: Preserve and compare revisions in `skill-registry.js`**

`normalizeRegistryEntry()` must retain `sourceKind` and `contentRevision`. `loadRegistryFile()` must return `registryRevision`. In `ensureBundledRegistryCached()`, compute missing revisions and replace cache when bundled and cached revisions differ.

- [ ] **Step 5: Run and commit**

Run: `node scripts/test-skill-catalog.mjs`

Expected: PASS, including same-timestamp content replacement.

```bash
git add src/main/skill-registry-revision.js src/main/skill-registry.js scripts/test-skill-catalog.mjs
git commit -m "fix: invalidate skill registry cache by content"
```

### Task 2: Stamp the bundled registry reproducibly

- [ ] **Step 1: Create `scripts/stamp-skill-registry.mjs`**

Read `resources/skills-registry/registry.json`, then read each registered catalog skill's `SKILL.md` and optional `skill.manifest.json`. Calculate `contentRevision` from the normalized registry entry plus those file contents, calculate the top-level `registryRevision`, set `updatedAt` only when `--touch` is present, and write stable two-space JSON with a trailing newline. Mandatory platform-only skills receive the same treatment from `resources/skills/<id>` when they are represented in the registry.

```js
for (const skill of registry.skills) {
  const dir = path.join(root, "resources", "skills-catalog", skill.id);
  const skillMarkdown = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  const manifestPath = path.join(dir, "skill.manifest.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  skill.contentRevision = skillContentRevision(skill, { skillMarkdown, manifest });
}
registry.registryRevision = registryRevision(registry);
if (process.argv.includes("--touch")) registry.updatedAt = new Date().toISOString();
fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
```

- [ ] **Step 2: Add verification mode**

With `--check`, calculate revisions without writing and exit non-zero when stored values differ. Add a catalog test that runs `node scripts/stamp-skill-registry.mjs --check`. The test also modifies a copied `SKILL.md` without changing registry metadata and asserts check mode fails, proving guide-only changes cannot ship with an old revision.

- [ ] **Step 3: Stamp current content**

Run: `node scripts/stamp-skill-registry.mjs --touch`

Expected: every entry has a 64-character `contentRevision`; top-level `registryRevision` is present.

- [ ] **Step 4: Verify idempotence**

Run: `shasum resources/skills-registry/registry.json; node scripts/stamp-skill-registry.mjs; shasum resources/skills-registry/registry.json`

Expected: both hashes match when `--touch` is omitted.

- [ ] **Step 5: Commit**

```bash
git add scripts/stamp-skill-registry.mjs resources/skills-registry/registry.json scripts/test-skill-catalog.mjs
git commit -m "build: stamp bundled skill registry revisions"
```

### Task 3: Make catalog synchronization non-destructive by default

- [ ] **Step 1: Create a failing integration test**

`scripts/test-sync-skills-catalog.mjs` copies registry and sources into a temporary root, invokes the sync module with injected paths, and asserts:

```js
const before = fs.readFileSync(registryPath, "utf8");
const result = await syncCatalog({ root: tmp, apply: false, fetchSources: fakeFetchSources });
assert.equal(fs.readFileSync(registryPath, "utf8"), before);
assert.ok(fs.existsSync(result.candidatePath));
assert.ok(result.diff.added.length + result.diff.changed.length + result.diff.removed.length >= 0);
```

- [ ] **Step 2: Run and confirm failure**

Run: `node scripts/test-sync-skills-catalog.mjs`

Expected: FAIL because the script writes directly and has no importable sync function.

- [ ] **Step 3: Refactor `sync-skills-catalog.mjs` into importable functions**

Export `buildCandidate`, `validateCandidate`, `writeCandidate`, `applyCandidateAtomically`, and `syncCatalog`. Keep the CLI call behind an ESM main-module check.

Default CLI behavior writes `.lily-work/skill-sync/registry.candidate.json` and prints a diff. `--apply` is the only flag that can replace the formal registry. Keep `--bundle-only` read-only with respect to the registry.

- [ ] **Step 4: Implement atomic application**

```js
const temp = `${outPath}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
fs.renameSync(temp, outPath);
```

Run validation before creating the temporary sibling file, and remove it on failure.

- [ ] **Step 5: Update package scripts**

```json
"sync:skills-catalog": "node scripts/sync-skills-catalog.mjs",
"sync:skills-catalog:apply": "node scripts/sync-skills-catalog.mjs --apply"
```

- [ ] **Step 6: Run and commit**

Run: `node scripts/test-sync-skills-catalog.mjs`

Expected: PASS; default run leaves registry byte-identical.

```bash
git add scripts/sync-skills-catalog.mjs scripts/test-sync-skills-catalog.mjs package.json
git commit -m "fix: make skill catalog sync safe by default"
```

### Task 4: Validate Lily metadata and namespace ownership

- [ ] **Step 1: Add rejection cases**

In the sync test, candidates must fail when they remove a mandatory Lily skill, replace a `lily-*` entry from an external source, use an undeclared category, omit capability/risk metadata from an existing first-party skill, or contain duplicate IDs.

```js
assert.throws(() => validateCandidate(candidateWithoutAppBuilder, baseline), /required skill lily-app-builder/i);
assert.throws(() => validateCandidate(candidateWithExternalLilyId, baseline), /namespace lily-/i);
```

- [ ] **Step 2: Add source namespace declarations**

Each entry in `catalog-sources.json` gets `allowedIdPrefixes`, such as `anthropics-`, `superpowers-`, `marketing-`, `pm-`, or `tob-`. No external source may emit `lily-*`.

- [ ] **Step 3: Implement candidate merge instead of registry replacement**

Start from the current bundled registry. Update only entries whose ID matches the source's allowed prefixes, preserve all Lily entries and top-level capability metadata, then stamp content revisions.

- [ ] **Step 4: Run and commit**

Run: `node scripts/test-sync-skills-catalog.mjs && node scripts/test-skill-catalog.mjs && node scripts/stamp-skill-registry.mjs --check`

Expected: PASS.

```bash
git add resources/skills-registry/catalog-sources.json scripts/sync-skills-catalog.mjs scripts/test-sync-skills-catalog.mjs
git commit -m "fix: protect Lily skill metadata during sync"
```

### Task 5: Verify registry upgrades

- [ ] **Step 1: Run focused tests**

Run: `node scripts/test-skill-catalog.mjs && node scripts/test-sync-skills-catalog.mjs && node scripts/stamp-skill-registry.mjs --check`

Expected: all PASS.

- [ ] **Step 2: Run a clean-cache probe**

Run the existing skill catalog test twice against a new temporary user-data directory.

Expected: first run seeds bundled cache; second run reuses it; changing a copied bundled description with unchanged timestamp causes a refresh.
