# Skill Catalog Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unreachable skills, make first-party manifests truthful, canonicalize duplicated rules, and align categories, localization, presets, and runtime paths.

**Architecture:** Enforce catalog invariants in one governance test, then update metadata and delete dead directories only after references are proven absent. Preserve vendor files that remain active and express Lily-specific behavior through wrappers or overlays.

**Tech Stack:** JSON manifests/registry, Markdown guides, Electron renderer JavaScript, Node.js filesystem tests.

---

## File map

- Create `scripts/test-skill-catalog-governance.mjs`: directory registration, permissions, categories, locale, and duplicate-source invariants.
- Modify manifests under `resources/skills-catalog/lily-*`: truthful file/network/subprocess/runtime declarations.
- Modify `src/main/skill-md-convert.js`: conservative complete permission defaults.
- Modify `src/renderer/modules/skill-settings.js` and locale files: display subprocess and runtime-pack permission hints.
- Modify `resources/skills-registry/registry.json`: versions, categories, sources, permissions, and i18n.
- Modify `src/main/skill-manager.js`: remove dead vendor overlays and keep active vendor overlays only.
- Modify `src/main/skills-state.js`: remove nonexistent bundled IDs or provide valid manifests for genuinely bundled mandatory skills.
- Modify `src/main/skill-presets.js`: canonical preset with compatibility alias.
- Modify `resources/skills-catalog/lily-document-verify/SKILL.md` and manifest: use a resolved script placeholder.
- Delete eight confirmed orphan directories under `resources/skills-catalog`.

### Task 1: Establish catalog governance invariants

- [ ] **Step 1: Create `scripts/test-skill-catalog-governance.mjs`**

The test must read the registry, catalog directories, manifests, mandatory skills, and locale files. Assert:

```js
const registeredIds = new Set(registry.skills.map((skill) => skill.id));
const catalogIds = fs.readdirSync(catalogDir).filter((id) => fs.statSync(path.join(catalogDir, id)).isDirectory());
assert.deepEqual(catalogIds.filter((id) => !registeredIds.has(id)).sort(), []);

const allowedCategories = new Set(registry.categories.map((category) => category.id));
for (const skill of registry.skills) assert.ok(allowedCategories.has(skill.category), `${skill.id} category ${skill.category}`);

const operationalFirstPartyIds = [
  "lily-app-builder",
  "lily-code-repair",
  "lily-document-query",
  "lily-pdf-form",
  "lily-runtime-packs",
  "lily-template-fill",
  "lily-browser-qa",
];
const readManifest = (id) => {
  const file = path.join(catalogDir, id, "skill.manifest.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
};
for (const id of operationalFirstPartyIds) {
  const manifest = readManifest(id);
  assert.ok(manifest, `${id} has a manifest`);
  assert.ok(["none", "read", "readwrite"].includes(manifest.permissions.filesystem));
  assert.ok(typeof manifest.permissions.subprocess === "boolean");
}
```

Also assert no registered skill references an unregistered skill ID, no dead overlay keys remain, and `lily-engineering-rules` has one canonical guide source/version.

- [ ] **Step 2: Run and capture all current failures**

Run: `node scripts/test-skill-catalog-governance.mjs`

Expected: FAIL listing the eight orphan directories, missing manifests, undeclared `coding` category, stale overlays, and duplicate engineering-rules source.

- [ ] **Step 3: Commit the red governance test**

```bash
git add scripts/test-skill-catalog-governance.mjs
git commit -m "test: define skill catalog governance"
```

### Task 2: Make first-party permissions truthful

- [ ] **Step 1: Add or update manifests**

Use these minimum declarations:

```json
{
  "lily-app-builder": { "network": false, "filesystem": "readwrite", "subprocess": true },
  "lily-code-repair": { "network": false, "filesystem": "readwrite", "subprocess": true },
  "lily-document-query": { "network": false, "filesystem": "read", "subprocess": true },
  "lily-pdf-form": { "network": false, "filesystem": "readwrite", "subprocess": true },
  "lily-runtime-packs": { "network": true, "filesystem": "readwrite", "subprocess": true },
  "lily-template-fill": { "network": false, "filesystem": "readwrite", "subprocess": true },
  "lily-browser-qa": { "network": true, "filesystem": "read", "subprocess": true, "requiredRuntimePacks": ["web-automation"] }
}
```

For each created manifest, copy ID, localized name/description, version, category, capability layer, risk, and guide body metadata from the registry/current guide rather than inventing a second identity.

- [ ] **Step 2: Make generated manifests conservative**

Update `buildManifestFromSkillMd`:

```js
permissions: {
  network: false,
  filesystem: "read",
  subprocess: false,
},
```

The converter cannot infer write/subprocess/network authority; first-party operational skills must use explicit manifests.

- [ ] **Step 3: Display all permission dimensions**

Extend `permissionHint(skill)`:

```js
if (skill.permissions?.subprocess) parts.push(t("skills.perm.subprocess"));
if ((skill.requiredRuntimePacks || []).length) {
  parts.push(t("skills.perm.runtimePacks", { packs: skill.requiredRuntimePacks.join(", ") }));
}
```

Add `skills.perm.subprocess` and `skills.perm.runtimePacks` to renderer `zh-CN`, `en`, and `ar` locale sources using existing interpolation conventions.

- [ ] **Step 4: Run and commit**

Run: `node scripts/test-skill-catalog-governance.mjs && node scripts/test-skill-capability-contracts.mjs`

Expected: permission and manifest assertions PASS; remaining failures are isolated to orphan/category/canonicalization work.

```bash
git add resources/skills-catalog/lily-*/skill.manifest.json src/main/skill-md-convert.js src/renderer/modules/skill-settings.js src/renderer/i18n resources/skills-registry/registry.json
git commit -m "fix: declare truthful skill permissions"
```

### Task 3: Canonicalize engineering rules and bundled IDs

- [ ] **Step 1: Choose the catalog guide as the canonical engineering-rules source**

Make `resources/skills/lily-engineering-rules/skill.manifest.json` carry only the mandatory wrapper/guide reference generated from the same version and body, or remove the catalog duplicate from install flow. The content visible to agents must be byte-equivalent after placeholder expansion.

- [ ] **Step 2: Add an equivalence assertion**

```js
assert.equal(normalizeGuide(mandatoryEngineeringGuide), normalizeGuide(catalogEngineeringGuide));
assert.equal(mandatoryManifest.version, catalogManifest.version);
```

- [ ] **Step 3: Fix `BUNDLED_SKILL_IDS`**

Remove `lily-diagrams` from `BUNDLED_SKILL_IDS` if it remains guide-only without a mandatory manifest, because it is a catalog recommendation rather than a protected platform skill. Keep actual mandatory IDs unchanged.

- [ ] **Step 4: Run and commit**

Run: `node scripts/test-skill-catalog-governance.mjs && node scripts/test-skill-catalog.mjs`

Expected: duplicate-source and nonexistent-bundled-ID assertions PASS.

```bash
git add resources/skills/lily-engineering-rules resources/skills-catalog/lily-engineering-rules src/main/skills-state.js resources/skills-registry/registry.json
git commit -m "fix: canonicalize engineering rule skill"
```

### Task 4: Normalize categories, source provenance, localization, and presets

- [ ] **Step 1: Normalize `coding` to the declared development category**

Use one category ID in registry entries and manifests. Prefer the existing declared `dev` category to avoid adding a synonym. Keep localized label values “编程研发”, “Development”, and “التطوير”.

- [ ] **Step 2: Correct publisher and source metadata**

First-party entries use `publisher: "Lily Workbench"` and `sourceKind: "bundled-first-party"`. Retained Anthropic entries use `publisher: "Anthropic"` and `sourceKind: "bundled-vendor"` with their upstream repository path.

- [ ] **Step 3: Fill locale gaps**

Ensure every registered displayable skill has `name_i18n.en`, `name_i18n.ar`, `description_i18n.en`, and `description_i18n.ar`. Add `lily-document-query` to Arabic and renderer static locale data, or change renderer lookup to use registry values with `locale → en → base` fallback.

- [ ] **Step 4: Consolidate preset definitions**

Define one canonical development preset and a compatibility alias:

```js
const DEV_STARTER_SKILL_IDS = RELIABILITY_CORE_SKILL_IDS;
const PRESET_ALIASES = Object.freeze({ reliability: "dev-starter" });
function getPresetById(id) {
  return PRESET_BY_ID[PRESET_ALIASES[id] || id] || null;
}
```

Do not list two identical presets in `SKILL_PRESETS`; update tests to assert alias behavior.

- [ ] **Step 5: Run and commit**

Run: `node scripts/test-skill-catalog-governance.mjs && node scripts/test-skill-catalog.mjs`

Expected: category, provenance, locale, and duplicate-preset assertions PASS.

```bash
git add resources/skills-registry resources/skills-catalog/lily-*/skill.manifest.json src/main/skill-presets.js src/renderer/i18n scripts/test-skill-catalog.mjs
git commit -m "fix: normalize skill metadata and presets"
```

### Task 5: Resolve document verification resources

- [ ] **Step 1: Add a manifest placeholder test**

Assert `lily-document-verify` declares a placeholder whose relative target exists:

```js
assert.equal(manifest.placeholders["{{RENDER_DOCUMENT_PY}}"], "../../runtime-scripts/render_document.py");
assert.match(skillMarkdown, /\{\{RENDER_DOCUMENT_PY\}\}/);
assert.doesNotMatch(skillMarkdown, /resources\/runtime-scripts\/render_document\.py/);
```

If placeholder resolution is restricted to the skill directory, instead add a runtime placeholder in `skills-state.js` that resolves directly from `process.resourcesPath/resources/runtime-scripts/render_document.py`.

- [ ] **Step 2: Implement the resolved runtime placeholder**

Add `{{RUNTIME_SCRIPTS_DIR}}` to `buildReplacements()` and use `{{RUNTIME_SCRIPTS_DIR}}/render_document.py` in the guide. Resolve packaged and development resource roots through the existing `bundledResourceCandidates()` helper.

- [ ] **Step 3: Run and commit**

Run: `node scripts/test-skill-catalog-governance.mjs && node scripts/test-document-verify-skill.mjs`

Expected: PASS; rendered command contains an absolute runtime path after installation.

```bash
git add src/main/skills-state.js resources/skills-catalog/lily-document-verify scripts/test-skill-catalog-governance.mjs
git commit -m "fix: resolve document verification runtime path"
```

### Task 6: Delete orphan skills and stale overlays

- [ ] **Step 1: Prove the exact orphan list**

The governance test must produce exactly:

```js
[
  "anthropics-frontend-design",
  "anthropics-web-artifacts-builder",
  "anthropics-webapp-testing",
  "superpowers-executing-plans",
  "superpowers-systematic-debugging",
  "superpowers-test-driven-development",
  "superpowers-verification-before-completion",
  "superpowers-writing-plans",
]
```

Also run:

```bash
rg -n "anthropics-frontend-design|anthropics-web-artifacts-builder|anthropics-webapp-testing|superpowers-(executing-plans|systematic-debugging|test-driven-development|verification-before-completion|writing-plans)" src resources scripts package.json
```

Expected: only the orphan directories, explicit test list, catalog source declarations, and two stale overlays remain.

- [ ] **Step 2: Remove stale overlays and exclusions**

Delete the `anthropics-web-artifacts-builder` and `anthropics-webapp-testing` overlay entries from `src/main/skill-manager.js`. Remove tests that specially tolerate these directories; replace them with the universal “every catalog directory is registered” invariant.

- [ ] **Step 3: Delete the eight directories**

Use `apply_patch` file deletions for every tracked file under the exact directories. Do not touch active Anthropic skills.

- [ ] **Step 4: Remove obsolete source entries if they only exist to regenerate deleted skills**

Keep a source only when it still supplies at least one retained registered third-party skill and its namespace is explicitly allowed.

- [ ] **Step 5: Run and commit**

Run: `node scripts/test-skill-catalog-governance.mjs && node scripts/test-skill-catalog.mjs`

Expected: PASS; no unregistered production directories.

```bash
git add src/main/skill-manager.js resources/skills-catalog resources/skills-registry/catalog-sources.json scripts/test-skill-catalog.mjs scripts/test-skill-catalog-governance.mjs
git commit -m "chore: remove unreachable bundled skills"
```

### Task 7: Add active-vendor platform overlays without modifying vendor guides

- [ ] **Step 1: Add governance assertions for active vendor dependencies**

For `anthropics-pdf`, assert Lily guidance does not promise missing `pytesseract`, `reportlab`, or `qpdf` executables. The vendor `SKILL.md` remains byte-untouched.

- [ ] **Step 2: Add or update a Lily overlay**

The overlay states that extraction/rendering use Lily's bundled document pipeline and runtime packs, package installation is not performed ad hoc, and unavailable operations fail clearly. Keep the overlay scoped to platform differences only.

- [ ] **Step 3: Run and commit**

Run: `node scripts/test-skill-catalog-governance.mjs && node scripts/test-skill-catalog.mjs`

Expected: PASS and `git diff -- resources/skills-catalog/anthropics-pdf/SKILL.md` is empty.

```bash
git add src/main/skill-manager.js scripts/test-skill-catalog-governance.mjs
git commit -m "fix: align vendor skill guidance with Lily runtime"
```

### Task 8: Verify catalog governance

- [ ] **Step 1: Run all focused checks**

Run: `node scripts/test-skill-catalog-governance.mjs && node scripts/test-skill-catalog.mjs && node scripts/test-skill-capability-contracts.mjs && node scripts/test-long-task-supervisor-migration.mjs`

Expected: all PASS.

- [ ] **Step 2: Verify packaging inputs**

Run: `node -e 'const p=require("./package.json"); console.log(p.build?.files || p.files)'`

Expected: the deleted orphan directories cannot be included through `resources/**/*`; all remaining catalog directories are registered.

- [ ] **Step 3: Run the complete project test suite after all four plans land**

Run: `npm run test:unit`

Expected: exit 0. Runtime-dependent tests may use their existing explicit skip behavior when the bundled runtime is absent; no newly added suite may be skipped.

- [ ] **Step 4: Inspect the final working tree**

Run: `git status --short && git diff --check`

Expected: only intentional implementation changes are present, `.superpowers/` remains untouched, and `git diff --check` emits no errors.
