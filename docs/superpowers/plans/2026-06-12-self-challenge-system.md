# Self-Challenge System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建开发者自测试系统，自动检测代码变更、生成挑战任务、执行并自评、输出改进建议和能力画像。

**Architecture:** 独立 Node.js CLI 脚本（`scripts/dev-self-challenge/`），通过 `child_process.spawn` 直接驱动引擎 CLI 执行任务，不进 Electron 包。cron 控制有序执行节奏，lock 文件防止并发。所有数据存 `.lily-work/challenges/`。

**Tech Stack:** Node.js CJS（匹配项目现有风格），无外部依赖。

---

### Task 1: 数据存储层 — ChallengeStore

**Files:**
- Create: `scripts/dev-self-challenge/lib/challenge-store.js`
- Test: `scripts/test-self-challenge-store.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/test-self-challenge-store.mjs
#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-challenge-store-"));
const dataDir = path.join(tempRoot, ".lily-work", "challenges");

// Mock config
const config = {
  challengeDataDir: () => dataDir,
};

const { ChallengeStore } = require("../scripts/dev-self-challenge/lib/challenge-store.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new ChallengeStore(config);

  // Test: empty state
  assert(store.listHistory().length === 0, "history should be empty initially");

  // Test: append history
  const entry = store.appendHistory({
    type: "diff-driven",
    prompt: "Test challenge",
    result: "completed",
    score: 8,
    filesChanged: ["a.js"],
  });
  assert(entry.id.startsWith("ch_"), `id should start with ch_: ${entry.id}`);
  assert(entry.timestamp, "should have timestamp");
  assert(store.listHistory().length === 1, "history should have 1 entry");
  assert(store.listHistory({ limit: 1 })[0].id === entry.id, "should return latest");

  // Test: get by id
  const found = store.getHistory(entry.id);
  assert(found && found.score === 8, "should find by id");

  // Test: lock
  assert(!store.isLocked(), "should not be locked initially");
  assert(store.acquireLock(), "should acquire lock");
  assert(store.isLocked(), "should be locked");
  assert(!store.acquireLock(), "should not double-acquire");
  store.releaseLock();
  assert(!store.isLocked(), "should release lock");

  // Test: stale lock (over 30 min)
  fs.writeFileSync(path.join(dataDir, "lock"), new Date(Date.now() - 40 * 60 * 1000).toISOString());
  assert(store.acquireLock(), "should acquire stale lock");

  console.log("PASS: test-self-challenge-store");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-self-challenge-store.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/dev-self-challenge/lib/challenge-store.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min stale

class ChallengeStore {
  constructor(config) {
    this._config = config;
  }

  _dataDir() {
    return this._config.challengeDataDir();
  }

  _historyPath() {
    return path.join(this._dataDir(), "history.json");
  }

  _lockPath() {
    return path.join(this._dataDir(), "lock");
  }

  _ensureDir() {
    fs.mkdirSync(this._dataDir(), { recursive: true });
  }

  _readHistory() {
    try {
      const raw = fs.readFileSync(this._historyPath(), "utf8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  _writeHistory(records) {
    this._ensureDir();
    fs.writeFileSync(this._historyPath(), JSON.stringify(records, null, 2), "utf8");
  }

  listHistory(opts = {}) {
    const records = this._readHistory();
    const limit = Math.max(1, Math.min(500, opts.limit || 50));
    return records.slice(-limit);
  }

  getHistory(id) {
    return this._readHistory().find((item) => item.id === id) || null;
  }

  appendHistory(fields) {
    const records = this._readHistory();
    const entry = {
      id: `ch_${crypto.randomUUID()}`,
      type: String(fields.type || "unknown"),
      prompt: String(fields.prompt || "").slice(0, 8000),
      result: String(fields.result || "unknown"),
      score: Number.isFinite(fields.score) ? fields.score : null,
      filesChanged: Array.isArray(fields.filesChanged) ? fields.filesChanged : [],
      issues: Array.isArray(fields.issues) ? fields.issues : [],
      suggestions: Array.isArray(fields.suggestions) ? fields.suggestions : [],
      durationMs: Number.isFinite(fields.durationMs) ? fields.durationMs : null,
      timestamp: fields.timestamp || new Date().toISOString(),
    };
    records.push(entry);
    if (records.length > 500) records.splice(0, records.length - 500);
    this._writeHistory(records);
    return entry;
  }

  isLocked() {
    try {
      const raw = fs.readFileSync(this._lockPath(), "utf8").trim();
      if (!raw) return false;
      const lockedAt = new Date(raw).getTime();
      if (Number.isNaN(lockedAt)) return false;
      return (Date.now() - lockedAt) < LOCK_TIMEOUT_MS;
    } catch {
      return false;
    }
  }

  acquireLock() {
    if (this.isLocked()) return false;
    this._ensureDir();
    fs.writeFileSync(this._lockPath(), new Date().toISOString(), "utf8");
    return true;
  }

  releaseLock() {
    try {
      fs.unlinkSync(this._lockPath());
    } catch {
      // ignore
    }
  }
}

module.exports = { ChallengeStore };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-self-challenge-store.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-self-challenge/lib/challenge-store.js scripts/test-self-challenge-store.mjs
git commit -m "feat: add ChallengeStore for self-challenge data persistence"
```

---

### Task 2: 能力画像追踪 — CapabilityTracker

**Files:**
- Create: `scripts/dev-self-challenge/lib/capability-tracker.js`
- Test: `scripts/test-self-challenge-capability.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/test-self-challenge-capability.mjs
#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-challenge-cap-"));
const dataDir = path.join(tempRoot, ".lily-work", "challenges");

const config = { challengeDataDir: () => dataDir };
const { CapabilityTracker } = require("../scripts/dev-self-challenge/lib/capability-tracker.js");
const { ChallengeStore } = require("../scripts/dev-self-challenge/lib/challenge-store.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new ChallengeStore(config);
  const tracker = new CapabilityTracker(config, store);

  // Test: default dimensions exist
  const dims = tracker.listDimensions();
  assert(dims.length >= 4, `should have default dimensions, got ${dims.length}`);
  const ca = tracker.getDimension("code-analysis");
  assert(ca && ca.score === 5, "default score should be 5");

  // Test: update score
  tracker.updateDimension("code-analysis", { score: 7, verdict: "pass" });
  const updated = tracker.getDimension("code-analysis");
  assert(updated.score === 7, `score should update, got ${updated.score}`);
  assert(updated.trend === "up", "trend should be up after improvement");

  // Test: trend down
  tracker.updateDimension("code-analysis", { score: 3, verdict: "fail" });
  const down = tracker.getDimension("code-analysis");
  assert(down.score === 3, `score should be 3`);
  assert(down.trend === "down", "trend should be down");

  // Test: weakest dimension
  tracker.updateDimension("refactoring", { score: 8, verdict: "pass" });
  const weakest = tracker.getWeakestDimension();
  assert(weakest, "should return weakest dimension");
  assert(weakest.key === "code-analysis", `weakest should be code-analysis, got ${weakest.key}`);

  // Test: persistence
  const tracker2 = new CapabilityTracker(config, store);
  const reloaded = tracker2.getDimension("code-analysis");
  assert(reloaded.score === 3, `persisted score should be 3, got ${reloaded.score}`);

  console.log("PASS: test-self-challenge-capability");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-self-challenge-capability.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/dev-self-challenge/lib/capability-tracker.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DIMENSIONS = {
  "code-analysis": { score: 5, description: "分析陌生模块、追踪调用链" },
  "refactoring": { score: 5, description: "拆分大函数、消除重复" },
  "error-handling": { score: 5, description: "边界条件、异常恢复" },
  "test-generation": { score: 5, description: "为无测试代码写测试" },
  "multi-locale": { score: 5, description: "多语言（中英阿）场景" },
  "cross-module": { score: 5, description: "跨多文件的复杂实现" },
};

class CapabilityTracker {
  constructor(config, store) {
    this._config = config;
    this._store = store;
  }

  _dataDir() {
    return this._config.challengeDataDir();
  }

  _path() {
    return path.join(this._dataDir(), "capabilities.json");
  }

  _read() {
    try {
      const raw = fs.readFileSync(this._path(), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // use defaults
    }
    return { ...DEFAULT_DIMENSIONS };
  }

  _write(data) {
    fs.mkdirSync(this._dataDir(), { recursive: true });
    fs.writeFileSync(this._path(), JSON.stringify(data, null, 2), "utf8");
  }

  listDimensions() {
    const data = this._read();
    return Object.entries(data).map(([key, value]) => ({
      key,
      ...value,
    }));
  }

  getDimension(key) {
    const data = this._read();
    if (!data[key]) return null;
    return { key, ...data[key] };
  }

  updateDimension(key, patch) {
    const data = this._read();
    if (!data[key]) data[key] = { score: 5, description: "" };

    const entry = data[key];
    const prevScore = entry.score;
    const newScore = Math.max(0, Math.min(10, Number(patch.score) || prevScore));

    entry.score = newScore;
    entry.lastTested = new Date().toISOString();
    entry.verdict = patch.verdict || entry.verdict || null;
    entry.trend = newScore > prevScore ? "up" : newScore < prevScore ? "down" : entry.trend || "stable";
    entry.consecutiveFails = patch.verdict === "fail"
      ? (entry.consecutiveFails || 0) + 1
      : 0;
    entry.paused = entry.consecutiveFails >= 2;

    this._write(data);
    return { key, ...entry };
  }

  getWeakestDimension() {
    const dims = this.listDimensions()
      .filter((d) => !d.paused)
      .sort((a, b) => a.score - b.score);
    return dims[0] || null;
  }
}

module.exports = { CapabilityTracker, DEFAULT_DIMENSIONS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-self-challenge-capability.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-self-challenge/lib/capability-tracker.js scripts/test-self-challenge-capability.mjs
git commit -m "feat: add CapabilityTracker for self-challenge skill profiling"
```

---

### Task 3: Diff 分析器 — DiffAnalyzer

**Files:**
- Create: `scripts/dev-self-challenge/lib/diff-analyzer.js`
- Test: `scripts/test-self-challenge-diff-analyzer.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/test-self-challenge-diff-analyzer.mjs
#!/usr/bin/env node
import module from "node:module";

const require = module.createRequire(import.meta.url);
const { analyzeDiff, hasUnchallengedChanges } = require("../scripts/dev-self-challenge/lib/diff-analyzer.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  // Test 1: empty diff
  const empty = analyzeDiff("");
  assert(empty.changedFiles.length === 0, "empty diff should have no files");
  assert(empty.modules.size === 0, "empty diff should have no modules");
  assert(!empty.hasChanges, "empty diff should not have changes");

  // Test 2: real diff format
  const sampleDiff = `diff --git a/src/main/agent-session.js b/src/main/agent-session.js
index abc..def 100644
--- a/src/main/agent-session.js
+++ b/src/main/agent-session.js
@@ -100,6 +100,10 @@
     this.busy = false;
+    this._retryCount = 0;
diff --git a/src/main/turn-orchestrator.js b/src/main/turn-orchestrator.js
index 123..456 100644
--- a/src/main/turn-orchestrator.js
+++ b/src/main/turn-orchestrator.js
@@ -50,3 +50,7 @@
+    this._maxRetries = 3;
diff --git a/scripts/test-new-feature.mjs b/scripts/test-new-feature.mjs
new file mode 100644
index 000..789
--- /dev/null
+++ b/scripts/test-new-feature.mjs
@@ -0,0 +1,10 @@
+#!/usr/bin/env node
+import { test } from "./helpers.mjs";
+test("new feature");
`;

  const result = analyzeDiff(sampleDiff);
  assert(result.hasChanges, "should detect changes");
  assert(result.changedFiles.length === 3, `should have 3 changed files, got ${result.changedFiles.length}`);
  assert(result.changedFiles.some((file) => file.path === "src/main/agent-session.js" && file.type === "M"), "agent-session should be modified");
  assert(result.modules.has("agent-session"), "should detect agent-session module");
  assert(result.modules.has("turn-orchestrator"), "should detect turn-orchestrator module");

  // Test 3: hasUnchallengedChanges
  const challenges = [{ type: "diff-driven", timestamp: new Date(0).toISOString(), changedFiles: [] }];
  assert(hasUnchallengedChanges(sampleDiff, challenges), "should detect unchallenged changes");

  const recentChallenges = [{ type: "diff-driven", timestamp: new Date().toISOString(), changedFiles: ["src/main/agent-session.js"] }];
  // Even with recent challenges, a new file appeared
  assert(hasUnchallengedChanges(sampleDiff, recentChallenges), "new file should trigger new challenge");

  console.log("PASS: test-self-challenge-diff-analyzer");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-self-challenge-diff-analyzer.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/dev-self-challenge/lib/diff-analyzer.js
"use strict";

const path = require("node:path");

function parseChangedFiles(diffOutput) {
  const files = [];
  const pattern = /^diff --git a\/(.+) b\/(.+)$/gm;
  let match;
  while ((match = pattern.exec(diffOutput))) {
    const filePath = match[2] || match[1];
    const isNew = diffOutput.includes(`diff --git a/${match[1]} b/${filePath}\nnew file`);
    files.push({
      path: filePath,
      type: isNew ? "A" : "M",
    });
  }
  return files;
}

function extractModuleName(filePath) {
  const basename = path.basename(filePath, path.extname(filePath));
  return basename;
}

function analyzeDiff(diffOutput) {
  const text = String(diffOutput || "").trim();
  if (!text) {
    return { changedFiles: [], modules: new Set(), hasChanges: false };
  }

  const changedFiles = parseChangedFiles(text);
  const modules = new Set();
  for (const file of changedFiles) {
    const mod = extractModuleName(file.path);
    if (mod && !mod.startsWith(".")) {
      modules.add(mod);
    }
  }

  return {
    changedFiles,
    modules,
    hasChanges: changedFiles.length > 0,
  };
}

function hasUnchallengedChanges(diffOutput, recentChallenges = []) {
  const analysis = analyzeDiff(diffOutput);
  if (!analysis.hasChanges) return false;

  const now = Date.now();
  const recentFiles = new Set();
  for (const ch of recentChallenges) {
    if (ch.type !== "diff-driven") continue;
    const age = now - new Date(ch.timestamp).getTime();
    if (age > 60 * 60 * 1000) continue; // older than 1 hour
    for (const file of (ch.changedFiles || [])) {
      recentFiles.add(file);
    }
  }

  // Check if any current change hasn't been challenged
  const unchallenged = analysis.changedFiles.filter((file) => !recentFiles.has(file.path));
  return unchallenged.length > 0;
}

module.exports = { analyzeDiff, hasUnchallengedChanges, parseChangedFiles };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-self-challenge-diff-analyzer.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-self-challenge/lib/diff-analyzer.js scripts/test-self-challenge-diff-analyzer.mjs
git commit -m "feat: add DiffAnalyzer for git diff-based challenge generation"
```

---

### Task 4: 挑战生成器 — ChallengeGenerator

**Files:**
- Create: `scripts/dev-self-challenge/lib/challenge-generator.js`
- Test: `scripts/test-self-challenge-generator.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/test-self-challenge-generator.mjs
#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-challenge-gen-"));
const dataDir = path.join(tempRoot, ".lily-work", "challenges");

const config = { challengeDataDir: () => dataDir };
const { ChallengeStore } = require("../scripts/dev-self-challenge/lib/challenge-store.js");
const { CapabilityTracker } = require("../scripts/dev-self-challenge/lib/capability-tracker.js");
const { analyzeDiff } = require("../scripts/dev-self-challenge/lib/diff-analyzer.js");
const { ChallengeGenerator } = require("../scripts/dev-self-challenge/lib/challenge-generator.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new ChallengeStore(config);
  const tracker = new CapabilityTracker(config, store);
  const generator = new ChallengeGenerator(config, store, tracker);

  // Test 1: diff-driven challenge
  const sampleDiff = `diff --git a/src/main/agent-session.js b/src/main/agent-session.js
--- a/src/main/agent-session.js
+++ b/src/main/agent-session.js
@@ -100,6 +100,10 @@
     this.busy = false;
+    this._retryCount = 0;
`;

  const diffChallenge = generator.generate({ diff: sampleDiff });
  assert(diffChallenge, "should generate diff-driven challenge");
  assert(diffChallenge.type === "diff-driven", `type should be diff-driven, got ${diffChallenge.type}`);
  assert(diffChallenge.prompt.includes("agent-session"), "prompt should mention changed module");
  assert(diffChallenge.dimension, "should assign a dimension");

  // Test 2: capability-driven challenge when no diff
  tracker.updateDimension("test-generation", { score: 2, verdict: "fail" });
  tracker.updateDimension("code-analysis", { score: 8, verdict: "pass" });

  const capChallenge = generator.generate({ diff: "" });
  assert(capChallenge, "should generate capability challenge when no diff");
  assert(capChallenge.type === "capability-driven", `type should be capability-driven, got ${capChallenge.type}`);
  assert(capChallenge.dimension === "test-generation", `should pick weakest dimension, got ${capChallenge.dimension}`);

  // Test 3: skip when paused dimension is the only option — generator
  // marks the dimension as paused and falls back to next weakest
  tracker.updateDimension("test-generation", { score: 2, verdict: "fail" });
  tracker.updateDimension("test-generation", { score: 2, verdict: "fail" });
  const pausedDim = tracker.getDimension("test-generation");
  assert(pausedDim.paused, "dimension should be paused after 2 consecutive fails");

  // Set all but one dimension high so the weakest non-paused is clear
  for (const dim of tracker.listDimensions()) {
    if (dim.key !== "test-generation" && dim.key !== "refactoring") {
      tracker.updateDimension(dim.key, { score: 9, verdict: "pass" });
    }
  }
  tracker.updateDimension("refactoring", { score: 7, verdict: "pass" });

  const fallbackChallenge = generator.generate({ diff: "" });
  assert(fallbackChallenge.dimension !== "test-generation", "should skip paused dimension");
  assert(fallbackChallenge.type === "capability-driven", "should still generate capability challenge");

  // Test 4: cooldown check
  const cooldownChallenge = generator.generate({ diff: "", lastChallengeAt: new Date().toISOString() });
  assert(!cooldownChallenge, "should not generate during cooldown");

  console.log("PASS: test-self-challenge-generator");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-self-challenge-generator.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/dev-self-challenge/lib/challenge-generator.js
"use strict";

const { analyzeDiff, hasUnchallengedChanges } = require("./diff-analyzer");

const COOLDOWN_MS = 5 * 60 * 1000; // 5 min between challenges

const CAPABILITY_PROMPTS = {
  "code-analysis": `分析 src/main/ 目录下最大的 2 个文件，总结它们的职责、相互依赖关系，并指出是否有职责不清或循环依赖。输出分析报告。`,
  "refactoring": `扫描 scripts/ 目录，找出超过 200 行的测试文件，评估其是否可以拆分。对最需要拆分的一个文件提出具体方案。`,
  "error-handling": `随机选取 src/main/ 下 3 个文件，检查其错误处理是否完善。对于每个函数，检查 try-catch 覆盖、错误传播和用户提示。输出检查报告。`,
  "test-generation": `运行 npm run test:unit 2>&1 获取覆盖率报告（如果可用），找出测试覆盖最薄弱的 3 个模块，为其中一个写补充测试。`,
  "multi-locale": `扫描 src/ 目录中所有包含中文文案的文件，检查是否所有面向用户的字符串都支持国际化（通过 locale-settings.js）。输出缺失列表。`,
  "cross-module": `选取 src/main/ 下 3 个交互最频繁的模块（如 turn-orchestrator 与 agent-session），追踪它们之间的调用链，评估耦合度并提出解耦建议。`,
};

class ChallengeGenerator {
  constructor(config, store, tracker) {
    this._config = config;
    this._store = store;
    this._tracker = tracker;
  }

  generate(opts = {}) {
    const lastChallengeAt = opts.lastChallengeAt || this._getLastChallengeTime();
    if (lastChallengeAt) {
      const age = Date.now() - new Date(lastChallengeAt).getTime();
      if (age < COOLDOWN_MS) return null;
    }

    const diff = String(opts.diff || "").trim();
    const analysis = analyzeDiff(diff);
    const recentHistory = this._store.listHistory({ limit: 20 });

    // Strategy 1: diff-driven
    if (analysis.hasChanges && hasUnchallengedChanges(diff, recentHistory)) {
      const modules = [...analysis.modules].slice(0, 3);
      const moduleList = modules.join("、");
      const changedFiles = analysis.changedFiles.map((file) => file.path);
      return {
        type: "diff-driven",
        prompt: `最近代码变更涉及以下模块：${moduleList}。\n变更文件：${changedFiles.join(", ")}\n\n请完成以下验证任务：\n1. 检查这些变更是否可能引入回归\n2. 为变更最关键的模块补充边界条件测试\n3. 如果发现潜在问题，提出修复建议`,
        dimension: this._pickDimension(modules[0]),
        changedFiles,
      };
    }

    // Strategy 2: capability-driven
    const roundsWithoutDiff = this._countRoundsWithoutDiff(recentHistory);
    if (roundsWithoutDiff >= 3) {
      const weakest = this._tracker.getWeakestDimension();
      if (!weakest) return null;
      const prompt = CAPABILITY_PROMPTS[weakest.key] || CAPABILITY_PROMPTS["code-analysis"];
      return {
        type: "capability-driven",
        prompt,
        dimension: weakest.key,
        changedFiles: [],
      };
    }

    return null;
  }

  _getLastChallengeTime() {
    const history = this._store.listHistory({ limit: 1 });
    return history.length > 0 ? history[0].timestamp : null;
  }

  _pickDimension(moduleName) {
    const map = {
      "agent-session": "error-handling",
      "turn-orchestrator": "cross-module",
      "scheduled-tasks": "cross-module",
      "session-manager": "refactoring",
    };
    return map[moduleName] || "code-analysis";
  }

  _countRoundsWithoutDiff(history) {
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].type === "diff-driven") break;
      count++;
    }
    return count;
  }
}

module.exports = { ChallengeGenerator, CAPABILITY_PROMPTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-self-challenge-generator.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-self-challenge/lib/challenge-generator.js scripts/test-self-challenge-generator.mjs
git commit -m "feat: add ChallengeGenerator with diff-driven and capability-driven strategies"
```

---

### Task 5: 挑战执行器 — ChallengeExecutor

**Files:**
- Create: `scripts/dev-self-challenge/lib/challenge-executor.js`
- Test: `scripts/test-self-challenge-executor.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/test-self-challenge-executor.mjs
#!/usr/bin/env node
import module from "node:module";
import { spawn } from "node:child_process";

const require = module.createRequire(import.meta.url);
const { ChallengeExecutor } = require("../scripts/dev-self-challenge/lib/challenge-executor.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  // Test 1: basic executor construction
  const executor = new ChallengeExecutor({ timeoutMs: 3000 });
  assert(executor._timeoutMs === 3000, "should accept timeout config");

  // Test 2: resolve engine command (echo fallback when engine not available)
  const cmd = executor._resolveCommand();
  assert(typeof cmd === "string" && cmd.length > 0, "should resolve a command string");

  // Test 3: execute with echo fallback (fast, always available)
  const result = await executor.execute({
    prompt: "echo hello world",
    cwd: process.cwd(),
  });
  assert(result.ok, `execution should succeed: ${JSON.stringify(result)}`);
  assert(typeof result.output === "string", "should return output string");
  assert(typeof result.durationMs === "number" && result.durationMs > 0, "should measure duration");

  // Test 4: timeout
  const slowExecutor = new ChallengeExecutor({ timeoutMs: 500, command: "sleep" });
  const timeoutResult = await slowExecutor.execute({
    prompt: "5",
    cwd: process.cwd(),
  });
  assert(!timeoutResult.ok, "should timeout");
  assert(timeoutResult.error === "TIMEOUT", `error should be TIMEOUT, got ${timeoutResult.error}`);

  // Test 5: execution failure
  const failExecutor = new ChallengeExecutor({ timeoutMs: 5000, command: "nonexistent_command_xyz" });
  const failResult = await failExecutor.execute({
    prompt: "anything",
    cwd: process.cwd(),
  });
  assert(!failResult.ok, "should fail for nonexistent command");
  assert(failResult.error, "should have error");

  console.log("PASS: test-self-challenge-executor");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-self-challenge-executor.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/dev-self-challenge/lib/challenge-executor.js
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 min
const ENGINE_CANDIDATES = [
  path.resolve(__dirname, "..", "..", "..", "..", "..", "Library", "Application Support", "lily-workbench", "lily-bin", "lily-workbench"),
];

class ChallengeExecutor {
  constructor(opts = {}) {
    this._timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this._command = opts.command || null;
  }

  _resolveCommand() {
    if (this._command) return this._command;
    const fs = require("node:fs");
    for (const candidate of ENGINE_CANDIDATES) {
      if (fs.existsSync(candidate)) return candidate;
    }
    // Fallback: use echo for testing
    return "echo";
  }

  execute(opts = {}) {
    const prompt = String(opts.prompt || "").trim();
    const cwd = opts.cwd || process.cwd();
    const command = this._resolveCommand();

    return new Promise((resolve) => {
      const startedAt = Date.now();
      let output = "";
      let errorOutput = "";
      let settled = false;

      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const child = spawn(command, ["-c", prompt], {
        cwd,
        env: { ...process.env },
        timeout: this._timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.length > 500_000) {
          output = output.slice(0, 500_000);
          child.kill();
        }
      });

      child.stderr.on("data", (chunk) => {
        errorOutput += String(chunk);
      });

      child.on("close", (code, signal) => {
        const durationMs = Date.now() - startedAt;
        if (signal === "SIGTERM" || code === null) {
          done({ ok: false, error: "TIMEOUT", output, errorOutput, durationMs });
          return;
        }
        if (code !== 0) {
          done({ ok: false, error: `EXIT_${code}`, output, errorOutput, durationMs });
          return;
        }
        done({ ok: true, output, errorOutput, durationMs });
      });

      child.on("error", (err) => {
        done({ ok: false, error: err.code || "SPAWN_ERROR", output: err.message, errorOutput, durationMs: Date.now() - startedAt });
      });
    });
  }
}

module.exports = { ChallengeExecutor };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-self-challenge-executor.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-self-challenge/lib/challenge-executor.js scripts/test-self-challenge-executor.mjs
git commit -m "feat: add ChallengeExecutor for engine-driven task execution"
```

---

### Task 6: 挑战评估器 — ChallengeEvaluator

**Files:**
- Create: `scripts/dev-self-challenge/lib/challenge-evaluator.js`
- Test: `scripts/test-self-challenge-evaluator.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/test-self-challenge-evaluator.mjs
#!/usr/bin/env node
import module from "node:module";

const require = module.createRequire(import.meta.url);
const { ChallengeEvaluator, parseEvaluationOutput } = require("../scripts/dev-self-challenge/lib/challenge-evaluator.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  // Test 1: parse valid evaluation output
  const validJson = JSON.stringify({
    scores: { completeness: 2, correctness: 2, style: 1, scope: 1, robustness: 2 },
    totalScore: 8,
    verdict: "pass",
    issues: [],
    suggestions: [],
  });
  const parsed = parseEvaluationOutput(validJson);
  assert(parsed, "should parse valid json");
  assert(parsed.totalScore === 8, `totalScore should be 8, got ${parsed.totalScore}`);
  assert(parsed.verdict === "pass", `verdict should be pass, got ${parsed.verdict}`);

  // Test 2: parse json with markdown wrapper
  const wrappedJson = 'Some markdown text\n```json\n{"scores":{"completeness":1,"correctness":1,"style":0,"scope":0,"robustness":0},"totalScore":2,"verdict":"fail","issues":[{"severity":"critical","description":"broke existing tests"}],"suggestions":[]}\n```';
  const wrapped = parseEvaluationOutput(wrappedJson);
  assert(wrapped, "should parse json from markdown");
  assert(wrapped.totalScore === 2, `totalScore should be 2, got ${wrapped.totalScore}`);
  assert(wrapped.verdict === "fail", "should be fail");

  // Test 3: invalid output returns default
  const invalid = parseEvaluationOutput("no json here at all");
  assert(!invalid.scores && invalid.verdict === "unknown", "should return default for invalid output");

  // Test 4: evaluator construction
  const evaluator = new ChallengeEvaluator({ timeoutMs: 5000 });
  assert(evaluator._timeoutMs === 5000, "should accept timeout config");

  // Test 5: build evaluation prompt
  const evalPrompt = evaluator._buildEvalPrompt("test task", "test output", []);
  assert(evalPrompt.includes("test task"), "eval prompt should include task");
  assert(evalPrompt.includes("test output"), "eval prompt should include output");
  assert(evalPrompt.includes("completeness"), "eval prompt should include scoring dimensions");

  console.log("PASS: test-self-challenge-evaluator");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-self-challenge-evaluator.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/dev-self-challenge/lib/challenge-evaluator.js
"use strict";

const { ChallengeExecutor } = require("./challenge-executor");

const EVALUATOR_SYSTEM_PROMPT = `你是 Lily Workbench 的自我评估系统。请审查以下挑战执行结果，输出 JSON。

## 评估维度（每个 0-2 分，总分 0-10）
1. completeness - 任务完成度
2. correctness - 代码正确性
3. style - 风格一致性
4. scope - 改动范围（最小化）
5. robustness - 健壮性

## 输出格式（纯 JSON，不要 markdown 包裹）
{"scores":{"completeness":N,"correctness":N,"style":N,"scope":N,"robustness":N},"totalScore":N,"verdict":"pass|fail|partial","issues":[{"severity":"critical|minor","description":"..."}],"suggestions":[{"type":"rule|refactor|test","description":"..."}]}`;

function parseEvaluationOutput(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  // Try direct JSON parse
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.totalScore === "number" && typeof parsed.verdict === "string") {
      return parsed;
    }
  } catch {
    // not direct JSON
  }

  // Try extracting from markdown code block
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1].trim());
      if (parsed && typeof parsed.totalScore === "number") return parsed;
    } catch {
      // not valid JSON in fence
    }
  }

  return null;
}

class ChallengeEvaluator {
  constructor(opts = {}) {
    this._timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10 * 60 * 1000;
  }

  _buildEvalPrompt(task, output, changedFiles = []) {
    return [
      EVALUATOR_SYSTEM_PROMPT,
      "",
      "## 原始任务",
      task,
      "",
      "## 执行输出",
      output.slice(0, 20_000),
      changedFiles.length ? `\n## 变更文件\n${changedFiles.join("\n")}` : "",
      "",
      "## 你的评估（纯 JSON）",
    ].join("\n");
  }

  async evaluate(opts = {}) {
    const { task, output, changedFiles = [], cwd } = opts;
    if (!task || !output) {
      return { ok: false, error: "MISSING_INPUT" };
    }

    const evalPrompt = this._buildEvalPrompt(task, output, changedFiles);
    const executor = new ChallengeExecutor({ timeoutMs: this._timeoutMs });

    const result = await executor.execute({
      prompt: evalPrompt,
      cwd: cwd || process.cwd(),
    });

    if (!result.ok) {
      return { ok: false, error: result.error, rawOutput: result.output };
    }

    const parsed = parseEvaluationOutput(result.output);
    if (!parsed) {
      return {
        ok: true,
        verdict: "unknown",
        totalScore: null,
        rawOutput: result.output,
      };
    }

    return {
      ok: true,
      verdict: parsed.verdict,
      totalScore: parsed.totalScore,
      scores: parsed.scores,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    };
  }
}

module.exports = { ChallengeEvaluator, parseEvaluationOutput };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-self-challenge-evaluator.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-self-challenge/lib/challenge-evaluator.js scripts/test-self-challenge-evaluator.mjs
git commit -m "feat: add ChallengeEvaluator for automated result scoring"
```

---

### Task 7: 主入口 — run.mjs 编排脚本

**Files:**
- Create: `scripts/dev-self-challenge/run.mjs`
- Modify: `package.json`（添加 `challenge` script）
- Test: `scripts/test-self-challenge-run.mjs`

- [ ] **Step 1: Write编排脚本和集成测试**

```javascript
// scripts/test-self-challenge-run.mjs
#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-challenge-run-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  // Run the challenge orchestrator in dry-run mode (no actual engine execution)
  const result = await new Promise((resolve, reject) => {
    const child = spawn("node", [
      path.resolve("scripts/dev-self-challenge/run.mjs"),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHALLENGE_DRY_RUN: "1",
        CHALLENGE_DATA_DIR: path.join(tempRoot, ".lily-work", "challenges"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });

  assert(result.code === 0, `exit code should be 0, got ${result.code}, stderr: ${result.stderr}`);
  assert(result.stdout.includes("challenge"), "output should mention challenge");

  // Check data was written
  const historyPath = path.join(tempRoot, ".lily-work", "challenges", "history.json");
  if (fs.existsSync(historyPath)) {
    const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    assert(Array.isArray(history), "history should be an array");
  }

  console.log("PASS: test-self-challenge-run");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-self-challenge-run.mjs`
Expected: FAIL (run.mjs doesn't exist yet)

- [ ] **Step 3: Write run.mjs**

```javascript
#!/usr/bin/env node
// scripts/dev-self-challenge/run.mjs
// Entry point: node scripts/dev-self-challenge/run.mjs
// Cron: 0 * * * * cd /path/to/project && node scripts/dev-self-challenge/run.mjs

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { ChallengeStore } = require("./lib/challenge-store.js");
const { CapabilityTracker } = require("./lib/capability-tracker.js");
const { ChallengeGenerator } = require("./lib/challenge-generator.js");
const { ChallengeExecutor } = require("./lib/challenge-executor.js");
const { ChallengeEvaluator } = require("./lib/challenge-evaluator.js");

const DRY_RUN = process.env.CHALLENGE_DRY_RUN === "1";
const DATA_DIR = process.env.CHALLENGE_DATA_DIR
  || path.resolve(__dirname, "..", "..", ".lily-work", "challenges");
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const config = {
  challengeDataDir: () => DATA_DIR,
};

function getGitDiff() {
  try {
    return execSync("git diff HEAD~1 -- '*.js' '*.mjs' '*.cjs'", {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch {
    return "";
  }
}

function log(message) {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${message}\n`);
}

async function main() {
  log("Self-challenge system starting...");

  const store = new ChallengeStore(config);
  const tracker = new CapabilityTracker(config, store);
  const generator = new ChallengeGenerator(config, store, tracker);
  const executor = new ChallengeExecutor({});
  const evaluator = new ChallengeEvaluator({});

  // 1. Lock check
  if (store.isLocked()) {
    log("Another challenge is in progress. Exiting.");
    return;
  }

  // 2. Generate challenge
  const diff = getGitDiff();
  const challenge = generator.generate({ diff });

  if (!challenge) {
    log("No challenge needed at this time. Exiting.");
    return;
  }

  log(`Challenge generated: type=${challenge.type}, dimension=${challenge.dimension}`);

  // 3. Acquire lock
  if (!store.acquireLock()) {
    log("Could not acquire lock. Exiting.");
    return;
  }

  try {
    // 4. Execute challenge
    log("Executing challenge...");

    let execResult;
    if (DRY_RUN) {
      execResult = {
        ok: true,
        output: "[DRY RUN] Challenge would execute: " + challenge.prompt.slice(0, 200),
        durationMs: 0,
      };
    } else {
      execResult = await executor.execute({
        prompt: challenge.prompt,
        cwd: PROJECT_ROOT,
      });
    }

    if (!execResult.ok) {
      log(`Execution failed: ${execResult.error}`);
      store.appendHistory({
        type: challenge.type,
        prompt: challenge.prompt,
        result: "execution_failed",
        score: 0,
        changedFiles: challenge.changedFiles || [],
        issues: [{ severity: "critical", description: execResult.error }],
        durationMs: execResult.durationMs,
      });
      if (challenge.dimension) {
        tracker.updateDimension(challenge.dimension, { score: 0, verdict: "fail" });
      }
      return;
    }

    log(`Execution complete in ${execResult.durationMs}ms`);

    // 5. Evaluate
    log("Evaluating result...");

    let evalResult;
    if (DRY_RUN) {
      evalResult = {
        ok: true,
        verdict: "pass",
        totalScore: 10,
        scores: { completeness: 2, correctness: 2, style: 2, scope: 2, robustness: 2 },
        issues: [],
        suggestions: [],
      };
    } else {
      evalResult = await evaluator.evaluate({
        task: challenge.prompt,
        output: execResult.output,
        changedFiles: challenge.changedFiles || [],
        cwd: PROJECT_ROOT,
      });
    }

    // 6. Persist
    const entry = store.appendHistory({
      type: challenge.type,
      prompt: challenge.prompt,
      result: evalResult.verdict,
      score: evalResult.totalScore,
      changedFiles: challenge.changedFiles || [],
      issues: evalResult.issues || [],
      suggestions: evalResult.suggestions || [],
      durationMs: execResult.durationMs,
    });

    if (challenge.dimension && evalResult.totalScore != null) {
      tracker.updateDimension(challenge.dimension, {
        score: evalResult.totalScore,
        verdict: evalResult.verdict,
      });
    }

    // 7. Output suggestions
    if (evalResult.suggestions && evalResult.suggestions.length > 0) {
      log("Suggestions:");
      for (const suggestion of evalResult.suggestions) {
        log(`  [${suggestion.type}] ${suggestion.description}`);
      }
    }

    log(`Challenge complete: id=${entry.id}, verdict=${evalResult.verdict}, score=${evalResult.totalScore}`);

  } finally {
    store.releaseLock();
  }
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 4: 添加 npm script**

Add to `package.json` scripts:
```json
"challenge": "node scripts/dev-self-challenge/run.mjs",
"challenge:dry": "CHALLENGE_DRY_RUN=1 node scripts/dev-self-challenge/run.mjs"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/test-self-challenge-run.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-self-challenge/run.mjs scripts/test-self-challenge-run.mjs package.json
git commit -m "feat: add self-challenge orchestrator entry point"
```

---

### Task 8: 集成验证 & cron 配置指南

**Files:**
- Create: `scripts/dev-self-challenge/CRON.md`（使用说明）

- [ ] **Step 1: 运行全部自挑战测试**

Run: `node scripts/test-self-challenge-store.mjs && node scripts/test-self-challenge-capability.mjs && node scripts/test-self-challenge-diff-analyzer.mjs && node scripts/test-self-challenge-generator.mjs && node scripts/test-self-challenge-executor.mjs && node scripts/test-self-challenge-evaluator.mjs && node scripts/test-self-challenge-run.mjs`
Expected: All 7 tests PASS

- [ ] **Step 2: 运行已有的测试确保无回归**

Run: `npm run test:unit`
Expected: 64/64 PASS

- [ ] **Step 3: 写使用文档**

```markdown
# Self-Challenge System

## 快速开始

```bash
# 手动运行一次（干跑模式，不实际执行引擎）
npm run challenge:dry

# 手动运行一次（真实执行）
npm run challenge
```

## 设置 cron 自动运行

```bash
# 编辑 crontab
crontab -e

# 每小时运行一次
0 * * * * cd /Users/zhangqin/aicode/ceshitermianl && /usr/local/bin/node scripts/dev-self-challenge/run.mjs >> .lily-work/challenges/cron.log 2>&1
```

## 数据文件

| 文件 | 说明 |
|------|------|
| `.lily-work/challenges/history.json` | 挑战历史记录 |
| `.lily-work/challenges/capabilities.json` | 能力维度画像 |
| `.lily-work/challenges/lock` | 运行锁 |

## 架构

```
cron (每小时)
  → run.mjs
    → Lock Check
    → git diff（检测变更）
    → ChallengeGenerator（选题）
    → ChallengeExecutor（spawn 引擎执行）
    → ChallengeEvaluator（spawn 引擎评估）
    → ChallengeStore + CapabilityTracker（存档）
```
```

- [ ] **Step 4: Commit**

```bash
git add scripts/dev-self-challenge/CRON.md
git commit -m "docs: add self-challenge cron setup guide"
```

- [ ] **Step 5: 最终验证**

Run: `npm run test:unit`
Expected: 64/64 PASS（无回归）

Run: `node scripts/test-self-challenge-store.mjs && node scripts/test-self-challenge-capability.mjs && node scripts/test-self-challenge-diff-analyzer.mjs && node scripts/test-self-challenge-generator.mjs && node scripts/test-self-challenge-executor.mjs && node scripts/test-self-challenge-evaluator.mjs && node scripts/test-self-challenge-run.mjs`
Expected: All 7 new tests PASS
```

---

## 实现顺序与依赖

```
Task 1 (ChallengeStore) ──── 无依赖，最先做
Task 2 (CapabilityTracker) ─ 依赖 Task 1
Task 3 (DiffAnalyzer) ─────── 无依赖
Task 4 (ChallengeGenerator) ─ 依赖 Task 1,2,3
Task 5 (ChallengeExecutor) ── 无依赖
Task 6 (ChallengeEvaluator) ─ 依赖 Task 5
Task 7 (run.mjs) ──────────── 依赖 Task 1-6
Task 8 (集成验证) ─────────── 依赖 Task 1-7
```

Tasks 1, 3, 5 可以并行开发。Tasks 2, 4, 6 有依赖关系需串行。
