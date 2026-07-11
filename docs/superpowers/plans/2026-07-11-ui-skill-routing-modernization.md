# UI Skill Routing Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route ordinary Chinese and English UI creation/review requests to the maintained Lily skill chain and make each UI skill's responsibilities current and explicit.

**Architecture:** Extend the capability broker with separate UI creation, review, and explicit-verification facts; keep scoring deterministic and catalog-driven. Replace every stale `frontend-design` reference with the maintained app-builder/UI-quality/browser-QA chain, then make the golden intent evaluation execute the real broker.

**Tech Stack:** Node.js CommonJS/ESM, JSONL fixtures, Markdown skill guides, `node:assert` tests.

---

## File map

- Modify `src/main/capability-broker.js`: classify UI creation/review/verification and score the correct skills.
- Modify `scripts/test-capability-broker.mjs`: regression coverage for common UI language and negative cases.
- Modify `scripts/run-intent-eval.mjs`: derive actual routes from the real broker when no external result file is supplied.
- Modify `scripts/test-intent-eval.mjs`: prove golden examples exercise real routing.
- Modify `resources/skills-catalog/lily-intent-eval/references/golden.jsonl`: add representative Chinese and English UI prompts.
- Modify `resources/skills/lily-intent-router/skill.manifest.json`: remove stale IDs from all locales.
- Modify `resources/skills/lily-image-generation/SKILL.md` and `resources/skills/lily-diagrams/SKILL.md`: point real UI work to maintained skills.
- Modify `resources/skills-catalog/lily-app-builder/SKILL.md`: use process jobs and progress-bounded verification.
- Modify `resources/skills-catalog/lily-ui-quality/SKILL.md`: add creation/review modes and modern quality gates.
- Modify `resources/skills-catalog/lily-browser-qa/SKILL.md`: specify evidence and runtime failure behavior.
- Modify `resources/skills-catalog/lily-coding-core/SKILL.md`: narrow it to engineering discipline and orchestration.
- Modify `resources/skills-registry/registry.json`: align capability intents, hints, versions, and descriptions.

### Task 1: Add failing UI routing regressions

- [ ] **Step 1: Add table-driven assertions to `scripts/test-capability-broker.mjs`**

```js
const uiCreationCases = [
  ["设计一个有高级感的 SaaS 落地页", ["lily-app-builder", "lily-ui-quality"]],
  ["美化这个登录页并优化移动端", ["lily-app-builder", "lily-ui-quality"]],
  ["Build a distinctive landing page", ["lily-app-builder", "lily-ui-quality"]],
  ["Redesign this login screen", ["lily-app-builder", "lily-ui-quality"]],
];
for (const [text, required] of uiCreationCases) {
  const ids = recommendSkillCapabilityGraph({ text }).map((skill) => skill.id);
  for (const id of required) assert.ok(ids.includes(id), `${text} should include ${id}: ${ids}`);
  assert.equal(ids.includes("frontend-design"), false);
}

const explicitUiVerification = recommendSkillCapabilityGraph({
  text: "重设计这个落地页，完成后打开并截图检查",
}).map((skill) => skill.id);
assert.ok(explicitUiVerification.includes("lily-browser-qa"));

const uiAdviceOnly = recommendSkillCapabilityGraph({
  text: "解释什么是视觉层级",
}).map((skill) => skill.id);
assert.equal(uiAdviceOnly.includes("lily-app-builder"), false);
```

- [ ] **Step 2: Run the focused test and confirm the new cases fail**

Run: `node scripts/test-capability-broker.mjs`

Expected: FAIL because landing-page/design/redesign phrases do not consistently include `lily-app-builder` and `lily-ui-quality`.

- [ ] **Step 3: Commit the red test**

```bash
git add scripts/test-capability-broker.mjs
git commit -m "test: cover common UI creation routing"
```

### Task 2: Implement creation/review/verification facts

- [ ] **Step 1: Replace the coupled UI expressions in `queryFacts()`**

Add deterministic facts using the existing `text`, `zh`, and `sourceOfficeFile` values:

```js
const uiArtifact = !sourceOfficeFile &&
  /ui|页面|界面|落地页|登录页|官网|网站|网页|仪表盘|看板|后台|组件|表单|landing\s*page|login\s*(?:page|screen)|web\s*page|website|dashboard|admin\s*(?:page|screen|interface)|component|form/i.test(`${text} ${zh}`);
const uiReview = uiArtifact &&
  /检查|审查|评审|验收|质量|一致|问题|无障碍|可访问|audit|review|inspect|critique|qa|quality|consistency|accessibility/i.test(`${text} ${zh}`);
const uiCreate = !codeRepair && uiArtifact &&
  /设计|制作|创建|构建|开发|实现|生成|搭建|美化|优化|改版|重新设计|做一个|design|build|create|implement|make|redesign|polish|restyle/i.test(`${text} ${zh}`);
const explicitBrowserVerification = uiArtifact &&
  /打开|预览|截图|浏览器|点击|测试|验证|响应式|控制台|open|preview|screenshot|browser|click|test|verify|responsive|console/i.test(`${text} ${zh}`);
const uiQuality = uiReview || uiCreate;
const appCreate = !codeRepair && (uiCreate ||
  /写.*脚本|生成.*脚本|批量.*文件|小工具|script/i.test(`${text} ${zh}`));
```

Return `uiArtifact`, `uiReview`, `uiCreate`, and `explicitBrowserVerification`. Set `browserQa` to the existing browser test signals plus `uiReview` or `explicitBrowserVerification`; do not make all creation requests claim that browser execution is mandatory at routing time.

- [ ] **Step 2: Make skill scoring reflect the split**

```js
if (skill.id === "lily-browser-qa" && facts.web && (!facts.sourceResearch || facts.browserQa)) {
  score += facts.browserQa ? 150 : 60;
}
if (skill.id === "lily-ui-quality" && facts.uiQuality) score += facts.uiReview ? 170 : 160;
if (skill.id === "lily-app-builder" && facts.appCreate) score += 180;
```

Keep code-repair precedence and all Office exclusions unchanged.

- [ ] **Step 3: Run broker tests**

Run: `node scripts/test-capability-broker.mjs`

Expected: PASS, including existing PDF/PPT/image negative-routing assertions.

- [ ] **Step 4: Commit the routing implementation**

```bash
git add src/main/capability-broker.js scripts/test-capability-broker.mjs
git commit -m "fix: route UI creation to maintained skills"
```

### Task 3: Make golden intent evaluation execute the broker

- [ ] **Step 1: Add real-route UI examples to the JSONL fixture**

Append records with unique IDs and exact expected routes:

```json
{"id":"ui_landing_create_zh_001","locale":"zh-CN","prompt":"设计一个有高级感的 SaaS 落地页","attachments":[],"expected_intents":["coding","app_create","ui"],"expected_route":["lily-app-builder","lily-ui-quality"],"must_not_route":["frontend-design","lily-image-generation"],"needs_clarification":false,"verification_required":["run_check"],"risk":"low","notes":"真实页面必须走代码创建与 UI 质量技能。"}
{"id":"ui_landing_create_en_001","locale":"en","prompt":"Build a distinctive landing page","attachments":[],"expected_intents":["coding","app_create","ui"],"expected_route":["lily-app-builder","lily-ui-quality"],"must_not_route":["frontend-design","lily-image-generation"],"needs_clarification":false,"verification_required":["run_check"],"risk":"low","notes":"English creation wording must not fall through to generic routers."}
{"id":"ui_review_verify_zh_001","locale":"zh-CN","prompt":"检查这个登录页的视觉层级和无障碍，打开页面截图验证","attachments":[],"expected_intents":["ui","browser_qa"],"expected_route":["lily-ui-quality","lily-browser-qa"],"must_not_route":["lily-app-builder"],"needs_clarification":false,"verification_required":["browser_open_check","screenshot"],"risk":"low","notes":"审查已有页面不应触发从零创建。"}
```

- [ ] **Step 2: Add a broker-backed actual-route builder in `scripts/run-intent-eval.mjs`**

Import `recommendSkillCapabilityGraph`, convert attachment names to `{ name }`, and use this result when `--actual` is absent:

```js
function brokerActual(example) {
  return {
    id: example.id,
    route: recommendSkillCapabilityGraph({
      text: example.prompt,
      files: (example.attachments || []).map((name) => ({ name })),
    }).map((skill) => skill.id),
    needs_clarification: false,
    verification: example.verification_required || [],
  };
}
```

Preserve `--actual` as an override for model-evaluation imports.

- [ ] **Step 3: Update `scripts/test-intent-eval.mjs` to assert live-route comparison**

```js
const live = JSON.parse(execFileSync("node", ["scripts/run-intent-eval.mjs", "--json", "--broker"], { encoding: "utf8" }));
assert.equal(live.ok, true);
assert.equal(live.mode, "broker");
assert.equal(live.coverage.examples >= 13, true);
```

- [ ] **Step 4: Run the intent tests**

Run: `node scripts/test-intent-eval.mjs`

Expected: PASS and report mode `broker`.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-intent-eval.mjs scripts/test-intent-eval.mjs resources/skills-catalog/lily-intent-eval/references/golden.jsonl
git commit -m "test: evaluate intents through the real broker"
```

### Task 4: Replace stale router references

- [ ] **Step 1: Add a catalog invariant before editing content**

In `scripts/test-skill-catalog.mjs`, scan active mandatory and registered guides:

```js
const activeGuideFiles = [
  ...skillManager.MANDATORY_PLATFORM_SKILL_IDS.map((id) => path.join(ROOT, "resources", "skills", id, "skill.manifest.json")),
  ...bundledRegistry.skills.map((skill) => path.join(ROOT, "resources", "skills-catalog", skill.id, "SKILL.md")),
].filter((file) => fs.existsSync(file));
for (const file of activeGuideFiles) {
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes("`frontend-design`"), false, `${file} references removed frontend-design`);
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `node scripts/test-skill-catalog.mjs`

Expected: FAIL on the intent router and image/diagram guides.

- [ ] **Step 3: Update all three locale bodies in `resources/skills/lily-intent-router/skill.manifest.json`**

Use the maintained chain: real UI/page → `lily-app-builder` + `lily-ui-quality`; actual rendering evidence → `lily-browser-qa`. Update the base, `zh-CN`, `en`, and `ar` guide bodies consistently.

- [ ] **Step 4: Update image and diagram guides**

Replace `frontend-design` with `lily-app-builder` and state that `lily-ui-quality` governs design quality. Keep `lily-diagrams` for structural/vector outputs and `lily-image-generation` for bitmap outputs.

- [ ] **Step 5: Run the invariant and commit**

Run: `node scripts/test-skill-catalog.mjs`

Expected: PASS.

```bash
git add scripts/test-skill-catalog.mjs resources/skills/lily-intent-router/skill.manifest.json resources/skills/lily-image-generation/SKILL.md resources/skills/lily-diagrams/SKILL.md
git commit -m "fix: remove stale frontend design routes"
```

### Task 5: Modernize the maintained UI skill guides

- [ ] **Step 1: Add guide-contract assertions**

Create `scripts/test-ui-skill-guides.mjs` that loads the four guides and asserts exact operational concepts:

```js
for (const token of ["Creation mode", "Review mode", "keyboard", "focus", "contrast", "200%", "prefers-reduced-motion", "RTL", "long text"]) {
  assert.match(uiQuality, new RegExp(token, "i"));
}
for (const token of ["lily_process_jobs", "job_status", "job_logs", "progress", "lily-browser-qa"]) {
  assert.match(appBuilder, new RegExp(token, "i"));
}
for (const token of ["URL", "viewport", "steps", "actual result", "BROWSER_RUNTIME_UNAVAILABLE"]) {
  assert.match(browserQa, new RegExp(token, "i"));
}
assert.doesNotMatch(codingCore, /wraps frontend design/i);
```

- [ ] **Step 2: Run and confirm failure**

Run: `node scripts/test-ui-skill-guides.mjs`

Expected: FAIL on missing quality and process-job requirements.

- [ ] **Step 3: Rewrite `lily-ui-quality/SKILL.md` around creation and review modes**

Include the shared quality matrix, explicit browser-evidence boundary, desktop/mobile/RTL/content-stress checks, and a report format ordered by user impact.

- [ ] **Step 4: Update App Builder, Browser QA, and Coding Core**

App Builder must start long-lived servers through `lily_process_jobs`, inspect readiness with `job_status`/`job_logs`, and iterate while progress is observed. Browser QA must report URL, viewport, steps, actual results, console failures, screenshots, and unavailable-runtime status. Coding Core must link to the specialist skills without duplicating their standards.

- [ ] **Step 5: Align registry capability metadata and bump affected versions**

For UI quality, include creation and review intents such as `ui.create`, `ui.review`, `frontend.visual_qa`, `interaction.review`, and `accessibility.review`. Update match hints and descriptions for all three locales, and increment patch versions for each changed skill.

- [ ] **Step 6: Run focused tests and commit**

Run: `node scripts/test-ui-skill-guides.mjs && node scripts/test-skill-capability-contracts.mjs && node scripts/test-capability-broker.mjs`

Expected: all PASS.

```bash
git add scripts/test-ui-skill-guides.mjs resources/skills-catalog/lily-app-builder resources/skills-catalog/lily-ui-quality resources/skills-catalog/lily-browser-qa resources/skills-catalog/lily-coding-core resources/skills-registry/registry.json
git commit -m "feat: modernize Lily UI skill chain"
```

### Task 6: Verify the UI routing project

- [ ] **Step 1: Run all focused checks**

Run: `node scripts/test-capability-broker.mjs && node scripts/test-intent-eval.mjs && node scripts/test-ui-skill-guides.mjs && node scripts/test-skill-catalog.mjs`

Expected: all commands print their success marker and exit 0.

- [ ] **Step 2: Run a direct probe**

Run:

```bash
node --input-type=module -e 'const m=await import("./src/main/capability-broker.js"); for (const text of ["设计一个有高级感的 SaaS 落地页","Build a distinctive landing page","检查登录页无障碍并截图"]) console.log(text, m.recommendSkillCapabilityGraph({text}).map(x=>x.id))'
```

Expected: creation cases include app builder and UI quality; the review case starts with UI quality and includes browser QA; none contain `frontend-design`.
