# UI 视觉全面翻新(日光极简)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Lily 工作台渲染层全面翻新为"日光极简"风格 — 浅色暖灰 + 品牌紫罗兰为主打主题,深色主题按同语言重做,聊天主界面(消息流/输入区/顶栏)做骨架级视觉调整。

**Architecture:** 设计规格见 `docs/superpowers/specs/2026-07-22-ui-visual-overhaul-design.md`。改动集中在 `src/renderer/styles/base.css`(两套主题令牌)与聊天三件套的 CSS/DOM;纯渲染层,不碰 IPC、主进程、文档管线。组件 CSS 经核查已无硬编码 hex(全部消费令牌),新增 `scripts/test-theme-tokens.mjs` 作为令牌一致性的长期护栏。

**Tech Stack:** Electron renderer(原生 DOM/ESM,无框架)、CSS 自定义属性、Node 内置 assert(测试)。

**关键背景事实(执行者无需重新调查):**

- 主题令牌:`base.css` `:root`(深色,行 17-199)与 `:root[data-theme="light"]`(行 201-320)。主题切换逻辑在 `theme-settings.js`(system/dark/light + prefers-color-scheme),**本计划不改它**。
- 用户消息:`.runtime-user-message`(article)> `.runtime-user-label`(p)+ `.runtime-user-body`(div),DOM 在 `message.js:398-442`,样式在 `runtime-chat.css:108-117`;`:761-763` 另有 `position: relative`(hover 重编辑按钮的锚点)。
- 助手回合:**已是透明无框**(`.assistant-turn-article`,`runtime-chat.css:176-186`)。shell 由 `turn-article-shell.js:5-54` 的 `createLiveTurnArticleShell()` 创建,进行中与封存回合共用(`turn-view-renderer.js:32-38` 只是换 `is-sealed` class)。`header.assistant-turn-header` 在状态为空时会被 `turn-article-frame.js:53` 隐藏 — 所以头像行必须挂在 header **外面**。
- 工具行:`details.assistant-tool-row`(`runtime-chat.css:1177-1184`),`row.dataset.status` 已写入,状态值为 `running`/`failed`/`done`(`turn-legacy-timeline.js:13,27` 佐证 `done`)。`:1200-1205` 有一条强制透明/无边的覆盖规则,翻新时必须处理。
- 输入区:**已是浮起卡片**(`.composer-row`,`composer.css:731-747`,圆角 20px + 阴影 + focus 环);DOM 是 `index.html:180-263` 静态结构。本任务只做精修,不改 DOM。
- 顶栏:DOM 是 `index.html:108-147` 静态结构,`session-chrome.js` 只更新文本。无模型选择器(在设置面板里),`topbar.css` 里 `.model-preset-*`/`.topbar-center`/`.working-dir`/`.mode-switch` 是死样式。本任务只瘦身重绘现有元素,**不新增控件**。
- 测试约定:`scripts/test-*.mjs` 被 `scripts/run-all-tests.mjs` 自动发现,脚本用 `node:assert/strict`,失败即非零退出。
- **git 规则:每次 commit 前必须先征得用户同意(项目铁律),执行者不得自行提交。**

---

### Task 1: 令牌一致性测试(先红)

**Files:**
- Create: `scripts/test-theme-tokens.mjs`

- [ ] **Step 1: 写测试**

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesDir = join(root, "src/renderer/styles");
const base = readFileSync(join(stylesDir, "base.css"), "utf8");

function tokens(block) {
  const out = new Map();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.set(m[1], m[2].trim());
  return out;
}

const rootBlock = base.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
const lightBlock = base.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)[1];
const darkTokens = tokens(rootBlock);
const lightTokens = tokens(lightBlock);

// 1) Theme parity: every color-valued token in :root must be re-themed for light,
//    and light must not invent tokens that dark lacks (aliases via var() are exempt).
const COLORISH = /#|rgba?\(|color-mix\(/;
const themedNames = [...darkTokens].filter(([, v]) => COLORISH.test(v)).map(([n]) => n);
for (const name of themedNames) {
  assert.ok(lightTokens.has(name), `light theme missing re-theme of ${name}`);
}
for (const name of lightTokens.keys()) {
  if (name === "--color-scheme") continue;
  assert.ok(darkTokens.has(name), `light theme defines unknown token ${name}`);
}

// 2) Component CSS must consume tokens, not hardcode hex (brand gradient + white allowlisted).
const ALLOW = new Set(["#fff", "#ffffff", "#6366f1", "#8b5cf6"]);
for (const file of readdirSync(stylesDir)) {
  if (!file.endsWith(".css") || file === "base.css") continue;
  const css = readFileSync(join(stylesDir, file), "utf8");
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    assert.ok(ALLOW.has(m[0].toLowerCase()), `${file}: hardcoded color ${m[0]} — use a theme token from base.css`);
  }
}

console.log(`theme tokens ok: ${themedNames.length} themed tokens checked`);
```

- [ ] **Step 2: 运行,确认当前失败(红)**

Run: `node scripts/test-theme-tokens.mjs`
Expected: FAIL,`light theme missing re-theme of --hairline`(以及 `--top-highlight`)—— 现行浅色块缺这两条,恰是本计划要补的。若意外 PASS,说明 base.css 已被改动,停下来重新核对。

- [ ] **Step 3: 提交(先征得用户同意)**

```bash
git add scripts/test-theme-tokens.mjs
git commit -m "test: add theme token parity + hardcoded-color guard"
```

---

### Task 2: 浅色主题重写 — 暖灰日光 + 紫罗兰(转绿)

**Files:**
- Modify: `src/renderer/styles/base.css:201-320`(`:root[data-theme="light"]` 整块替换)

- [ ] **Step 1: 整体替换 `:root[data-theme="light"]` 块为**

```css
:root[data-theme="light"] {
  --color-scheme: light;

  /* Accent: brand violet, softened for daylight surfaces */
  --accent: #6366f1;
  --accent-hover: #4f46e5;
  --accent-dim: rgba(99, 102, 241, 0.12);
  --accent-subtle: rgba(99, 102, 241, 0.07);
  --accent-border: rgba(99, 102, 241, 0.30);
  --accent-strong-border: rgba(99, 102, 241, 0.55);
  --accent-strong-bg: rgba(99, 102, 241, 0.14);
  --accent-ring: rgba(99, 102, 241, 0.18);

  /* Warm-neutral daylight ladder (Notion-style #f7f7f5 family) */
  --bg-body: #f7f7f5;
  --bg-left: #fbfbfa;
  --bg-center: #f7f7f5;
  --bg-right: #fbfbfa;
  --bg-topbar: #ffffff;
  --bg-input: #ffffff;
  --bg-primary: var(--bg-center);
  --bg-secondary: var(--bg-surface-muted);
  --bg-elevated: var(--bg-surface-raised);
  --bg-surface: #ffffff;
  --bg-surface-raised: #ffffff;
  --bg-surface-hover: #f0efec;
  --bg-surface-active: #e8e6e1;
  --bg-surface-muted: rgba(60, 56, 48, 0.05);
  --bg-surface-subtle: rgba(60, 56, 48, 0.03);
  --bg-floating: rgba(255, 255, 255, 0.97);
  --bg-backdrop: rgba(31, 27, 20, 0.16);
  --bg-drop-overlay: rgba(31, 27, 20, 0.18);
  --bg-drop-card: rgba(255, 255, 255, 0.96);
  --bg-tool-detail: rgba(60, 56, 48, 0.04);
  --bg-tool-detail-strong: rgba(60, 56, 48, 0.06);
  --bg-media: rgba(250, 250, 248, 0.96);
  --bg-choice-backdrop: rgba(31, 27, 20, 0.28);
  --bg-pdf-active: rgba(99, 102, 241, 0.08);
  --bg-pdf-viewport-sheen: rgba(60, 56, 48, 0.035);
  --bg-user-chip: rgba(255, 255, 255, 0.22);
  --bg-user-chip-soft: rgba(255, 255, 255, 0.16);

  /* Warm ink ladder */
  --text-primary: #1f2328;
  --text: var(--text-primary);
  --text-secondary: #5b5b56;
  --text-tertiary: #83837d;
  --text-faint: #b0aea6;
  --text-dim: #6b6b66;
  --text-muted: #8b8b85;
  --muted: var(--text-muted);
  --text-inverse: #ffffff;
  --text-strong: #17181c;
  --text-code: #9a4a0e;
  --link: #4f46e5;

  /* Warm hairlines */
  --border: rgba(31, 27, 20, 0.09);
  --border-light: rgba(31, 27, 20, 0.12);
  --border-subtle: rgba(31, 27, 20, 0.06);
  --border-strong: rgba(31, 27, 20, 0.17);

  /* Soft warm-neutral shadows, three rungs */
  --shadow: 0 1px 2px rgba(31, 27, 20, 0.05), 0 12px 32px rgba(31, 27, 20, 0.06);
  --shadow-sm: 0 1px 2px rgba(31, 27, 20, 0.05), 0 4px 14px rgba(31, 27, 20, 0.04);
  --shadow-floating: 0 16px 40px rgba(31, 27, 20, 0.10);
  --shadow-panel: -14px 0 42px rgba(31, 27, 20, 0.08);
  --shadow-image: 0 8px 36px rgba(31, 27, 20, 0.16);
  --shadow-modal: 0 22px 64px rgba(31, 27, 20, 0.13);
  --shadow-pdf-page: 0 16px 40px rgba(31, 27, 20, 0.12);
  --shadow-pdf-thumb: 0 1px 4px rgba(31, 27, 20, 0.08);

  --success-bg: #e9f8ef;
  --success-bg-hover: #d8f1e2;
  --success-border: #a7dfba;
  --success-text: #15803d;
  --success-text-soft: #166534;
  --success-dot: #16a34a;
  --success-dot-ring: rgba(22, 163, 74, 0.16);
  --danger-bg: #fef0f0;
  --danger-bg-hover: #fde1e1;
  --danger-border: #f8b4b4;
  --danger-text: #dc2626;
  --danger-text-soft: #b91c1c;
  --danger-dot-ring: rgba(220, 38, 38, 0.14);
  --warning-bg: #fff7e6;
  --warning-bg-soft: rgba(217, 119, 6, 0.12);
  --warning-border: #f4d58d;
  --warning-border-soft: rgba(217, 119, 6, 0.35);
  --warning-text: #b45309;
  --warning-text-soft: #92400e;
  --info-bg: #eef6ff;
  --info-bg-soft: rgba(37, 99, 235, 0.1);
  --info-border: #b9d5ff;
  --info-border-soft: rgba(37, 99, 235, 0.28);
  --info-text: #2563eb;
  --info-text-soft: #1d4ed8;
  --info-text-muted: #315fbe;

  --diff-add-bg: rgba(22, 163, 74, 0.12);
  --diff-add-text: #15803d;
  --diff-del-bg: rgba(220, 38, 38, 0.1);
  --diff-del-text: #dc2626;
  --diff-hunk-bg: rgba(99, 102, 241, 0.10);
  --diff-hunk-text: #4f46e5;
  --diff-meta-bg: rgba(100, 116, 139, 0.1);
  --diff-meta-text: #64748b;

  --code-bg: #f5f4f1;
  --code-text: var(--text-code);
  --pre-bg: #faf9f7;
  --pre-text: #2a2d34;
  --copy-bg: rgba(255, 255, 255, 0.88);
  --copy-bg-hover: rgba(245, 244, 241, 0.96);
  --image-backdrop: var(--copy-bg);
  --document-page-bg: #ffffff;
  --image-control-bg: rgba(31, 27, 20, 0.56);
  --image-control-hover: rgba(31, 27, 20, 0.72);
  --scrollbar-thumb: #d6d3cb;

  /* Daylight "lit from above": hairline goes warm, highlight comes from the white surface */
  --hairline: rgba(31, 27, 20, 0.06);
  --top-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.6);
}
```

- [ ] **Step 2: 运行测试,确认转绿**

Run: `node scripts/test-theme-tokens.mjs`
Expected: PASS,输出 `theme tokens ok: N themed tokens checked`

- [ ] **Step 3: 提交(先征得用户同意)**

```bash
git add src/renderer/styles/base.css
git commit -m "feat(theme): daylight-minimal light theme with brand violet"
```

---

### Task 3: 深色主题配套重做 — 暖调深灰 + 圆角刻度升级

**Files:**
- Modify: `src/renderer/styles/base.css:32-82`(surface/text/border)、`:84-91`(不动)、`:129-150`(code/pre/scrollbar/hairline/highlight)、`:141-146`(radius)

- [ ] **Step 1: 替换 `:root` 中的 surface ladder(base.css:32-62)为**

```css
  /* Surface ladder: warm charcoal, layered by lightness (not borders) */
  --bg-body: #131210;
  --bg-left: #181713;
  --bg-center: #1b1a16;
  --bg-right: #181713;
  --bg-topbar: #1e1d18;
  --bg-input: #22211c;
  --bg-primary: var(--bg-center);
  --bg-secondary: var(--bg-surface-muted);
  --bg-elevated: var(--bg-surface-raised);
  --bg-surface: #24231e;
  --bg-surface-raised: #2a2923;
  --bg-surface-hover: #32312a;
  --bg-surface-active: #3a3931;
  --bg-surface-muted: rgba(255, 250, 240, 0.045);
  --bg-surface-subtle: rgba(255, 250, 240, 0.025);
  --surface-subtle: var(--bg-surface-subtle);
  --hover-bg: var(--bg-surface-hover);
  --bg-status: var(--bg-topbar);
  --bg-floating: rgba(32, 31, 26, 0.96);
  --bg-backdrop: rgba(0, 0, 0, 0.5);
  --bg-drop-overlay: rgba(10, 10, 8, 0.82);
  --bg-drop-card: rgba(30, 29, 24, 0.94);
  --bg-tool-detail: rgba(0, 0, 0, 0.18);
  --bg-tool-detail-strong: rgba(0, 0, 0, 0.22);
  --bg-media: rgba(16, 15, 12, 0.72);
  --bg-choice-backdrop: rgba(0, 0, 0, 0.28);
  --bg-pdf-active: rgba(99, 102, 241, 0.10);
  --bg-pdf-viewport-sheen: rgba(255, 250, 240, 0.035);
  --bg-user-chip: rgba(255, 255, 255, 0.15);
  --bg-user-chip-soft: rgba(255, 255, 255, 0.1);
```

- [ ] **Step 2: 替换 text ladder(base.css:64-75)为**

```css
  --text-primary: #efeeea;
  --text: var(--text-primary);
  --text-secondary: #a8a7a0;
  --text-tertiary: #86857e;
  --text-faint: #63625c;
  --text-dim: #73726b;
  --text-muted: #7e7d76;
  --muted: var(--text-muted);
  --text-inverse: #ffffff;
  --text-strong: #faf9f6;
  --text-code: #f0a060;
  --link: #9a9df7;
```

- [ ] **Step 3: 替换 border 组(base.css:77-82)为**

```css
  /* Hairlines, not hard borders — warm tint to match the charcoal ladder */
  --border: rgba(255, 250, 240, 0.08);
  --border-light: rgba(255, 250, 240, 0.11);
  --border-subtle: rgba(255, 250, 240, 0.055);
  --border-soft: var(--border-subtle);
  --border-strong: rgba(255, 250, 240, 0.15);
```

- [ ] **Step 4: 替换 code/pre/scrollbar 杂项(base.css:129-139)中三行**

`--pre-bg: #0d1117;` → `--pre-bg: #191814;`
`--pre-text: #d7e1ea;` → `--pre-text: #e3dfd5;`
`--scrollbar-thumb: #2a2b30;` → `--scrollbar-thumb: #383731;`

- [ ] **Step 5: 替换 hairline/highlight(base.css:149-150)为**

```css
  --hairline: rgba(255, 250, 240, 0.06);
  --top-highlight: inset 0 1px 0 rgba(255, 250, 240, 0.07);
```

- [ ] **Step 6: 圆角刻度升级(base.css:141-146),全主题共享**

`--radius: 8px;` → `--radius: 10px;`
`--radius-lg: 12px;` → `--radius-lg: 14px;`
(`--radius-xs: 4px`、`--radius-sm: 6px`、`--radius-md: var(--radius)`、`--radius-pill: 999px` 不动)

- [ ] **Step 7: 运行测试,确认仍绿**

Run: `node scripts/test-theme-tokens.mjs`
Expected: PASS(深色块改动不破坏奇偶校验;若报 `light theme missing ...`,说明改了 :root 里某个色值令牌的名字,回去对齐)

- [ ] **Step 8: 提交(先征得用户同意)**

```bash
git add src/renderer/styles/base.css
git commit -m "feat(theme): warm-charcoal dark theme + 6/10/14 radius scale"
```

---

### Task 4: 用户消息 — 右侧气泡

**Files:**
- Modify: `src/renderer/styles/runtime-chat.css:108-117`(`.runtime-user-message`)、`:132-138`(`.runtime-user-label`)

- [ ] **Step 1: 替换 `.runtime-user-message` 规则为**

```css
.runtime-user-message {
  display: block;
  width: fit-content;
  max-width: 72%;
  margin: 0 0 16px auto;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border-subtle));
  border-radius: var(--radius-lg) var(--radius-lg) var(--radius-xs) var(--radius-lg);
  background: color-mix(in srgb, var(--accent) 9%, var(--bg-surface));
  box-shadow: none;
}
```

- [ ] **Step 2: 替换 `.runtime-user-label` 规则为(视觉隐藏,保留无障碍语义;气泡位置本身已表达"这是你")**

```css
.runtime-user-label {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
```

- [ ] **Step 3: 验证令牌护栏仍绿,并人工核对气泡**

Run: `node scripts/test-theme-tokens.mjs`
Expected: PASS(没有引入硬编码色)

- [ ] **Step 4: 提交(先征得用户同意)**

```bash
git add src/renderer/styles/runtime-chat.css
git commit -m "feat(chat): right-aligned accent bubble for user messages"
```

> **执行后修正(已落地,commit f332593):** 审查发现两处回归 — ① `.runtime-user-steer-badge`(插话标记)原挂在 sr-only 的 label 内被一并隐藏,已改为挂到 article(`message.js:413`)+ 徽章 CSS 改为气泡顶缘标签;② `.runtime-user-edit` 在 fit-content 气泡上遮挡首行文字,已改为悬于气泡左缘外侧(`top:50%; left:-6px; transform:translate(-100%,-50%)`)。后续执行者如遇相关代码,以仓库现状为准。

---

### Task 5: 助手回合 — 头像 + 名称行

**Files:**
- Modify: `src/renderer/modules/turn-article-shell.js:51-53`
- Modify: `src/renderer/styles/runtime-chat.css`(.assistant-turn-header 规则附近,`:193-199` 之后插入)

- [ ] **Step 1: 在 `turn-article-shell.js` 中,把**

```js
  const roleNodes = { header, process, taskrun: taskRun, narrative, artifacts, footer, prompts };
  article.append(...slotOrder.map((role) => roleNodes[role]).filter(Boolean));
  return article;
```

**改为(头像行挂在 header 外,避开 `turn-article-frame.js:53` 的空状态隐藏逻辑;进行中与封存回合自动同享)**

```js
  const speaker = document.createElement("div");
  speaker.className = "assistant-turn-speaker";
  const avatar = document.createElement("span");
  avatar.className = "assistant-turn-avatar";
  avatar.textContent = "L";
  avatar.setAttribute("aria-hidden", "true");
  const speakerName = document.createElement("span");
  speakerName.className = "assistant-turn-name";
  speakerName.textContent = "Lily";
  speaker.append(avatar, speakerName);

  const roleNodes = { header, process, taskrun: taskRun, narrative, artifacts, footer, prompts };
  article.append(speaker, ...slotOrder.map((role) => roleNodes[role]).filter(Boolean));
  return article;
```

- [ ] **Step 2: 在 `runtime-chat.css` 的 `.assistant-turn-header` 规则后追加**

```css
.assistant-turn-speaker {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
}

.assistant-turn-avatar {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.assistant-turn-name {
  font-size: var(--text-sm);
  font-weight: 650;
  color: var(--text-primary);
}
```

(两个渐变 hex 已在测试白名单 `#6366f1 / #8b5cf6 / #ffffff` 内。)

- [ ] **Step 3: 验证**

Run: `node scripts/test-theme-tokens.mjs`
Expected: PASS

- [ ] **Step 4: 提交(先征得用户同意)**

```bash
git add src/renderer/modules/turn-article-shell.js src/renderer/styles/runtime-chat.css
git commit -m "feat(chat): assistant speaker row with brand avatar"
```

---

### Task 6: 工具行 — 淡紫卡片 + 完成勾

**Files:**
- Modify: `src/renderer/styles/runtime-chat.css:1177-1184`(`.assistant-tool-row`)、`:1200-1205`(透明覆盖规则)

- [ ] **Step 1: 替换 `.runtime-chat.css:1177-1184` 的 `.assistant-tool-row` 规则为**

```css
.assistant-tool-row {
  margin-top: 4px;
  border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border-subtle));
  border-radius: var(--radius);
  padding: 2px 6px;
  background: color-mix(in srgb, var(--accent) 5%, var(--bg-surface));
  min-width: 0;
  max-width: var(--chat-prose);
}
```

- [ ] **Step 2: 把 `:1200-1205` 的透明覆盖规则**

```css
.assistant-turn-article .assistant-tool-row,
.assistant-turn-article .assistant-tool-row[open] {
  background: transparent;
  border: none;
  box-shadow: none;
}
```

**改为(只压阴影,保留新卡片底色与边框)**

```css
.assistant-turn-article .assistant-tool-row,
.assistant-turn-article .assistant-tool-row[open] {
  box-shadow: none;
}
```

- [ ] **Step 3: 在 `.assistant-tool-status` 规则(`:1276-1283`)之后追加完成勾(纯 CSS,`data-status="done"` 已由 `turn-tool-row.js:18` 写入)**

```css
.assistant-tool-row[data-status="done"] .assistant-tool-command::before {
  content: "✓";
  margin-right: 7px;
  color: var(--success-text);
  font-family: var(--font);
  font-weight: 650;
}
```

- [ ] **Step 4: 验证**

Run: `node scripts/test-theme-tokens.mjs`
Expected: PASS

- [ ] **Step 5: 提交(先征得用户同意)**

```bash
git add src/renderer/styles/runtime-chat.css
git commit -m "feat(chat): violet tool cards with done checkmark"
```

---

### Task 7: 输入区精修

**Files:**
- Modify: `src/renderer/styles/composer.css:731-747`(`.composer-row`)、`:762-773`(`.composer-actionbar`)

- [ ] **Step 1: `.composer-row` 中两行改值(其余声明不动)**

`border-radius: 20px;` → `border-radius: var(--radius-lg);`
`box-shadow: 0 10px 28px color-mix(in srgb, var(--bg-body) 18%, transparent), var(--top-highlight);` → `box-shadow: var(--shadow-sm);`

- [ ] **Step 2: `.composer-actionbar` 中一行改值(贴合新圆角)**

`border-radius: 0 0 19px 19px;` → `border-radius: 0 0 calc(var(--radius-lg) - 1px) calc(var(--radius-lg) - 1px);`

- [ ] **Step 3: 验证**

Run: `node scripts/test-theme-tokens.mjs`
Expected: PASS

- [ ] **Step 4: 提交(先征得用户同意)**

```bash
git add src/renderer/styles/composer.css
git commit -m "feat(composer): harmonize card radius and shadow with new scale"
```

---

### Task 8: 顶栏瘦身

**Files:**
- Modify: `src/renderer/styles/topbar.css:18-31`(`.topbar`)、`:355-376`(`.topbar-btn`)

- [ ] **Step 1: 替换 `.topbar` 规则为(去渐变、去投影,高度 56→46)**

```css
.topbar {
  position: relative;
  z-index: var(--z-topbar);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  background: var(--bg-topbar);
  border-bottom: 1px solid var(--border-subtle);
  min-height: 46px;
  box-shadow: none;
}
```

- [ ] **Step 2: `.topbar-btn` 中四行改值(其余不动)——按钮改胶囊形**

`border: 1px solid var(--border-light);` → `border: 1px solid var(--border);`
`border-radius: var(--radius-sm);` → `border-radius: var(--radius-pill);`
`background: color-mix(in srgb, var(--control-bg) 88%, var(--bg-surface) 12%);` → `background: var(--bg-surface);`
`box-shadow: var(--top-highlight);` → `box-shadow: none;`

- [ ] **Step 3: 验证**

Run: `node scripts/test-theme-tokens.mjs`
Expected: PASS

- [ ] **Step 4: 提交(先征得用户同意)**

```bash
git add src/renderer/styles/topbar.css
git commit -m "feat(topbar): slim flat bar with pill buttons"
```

---

### Task 9: 全量回归 + 人工视觉验收

**Files:**
- 无新增;运行现有套件

- [ ] **Step 1: 跑全量测试**

Run: `npm run test:unit`
Expected: 全绿(含新加入的 `test-theme-tokens.mjs`;需要 bundled runtime 的测试会声明 skip,属正常)

- [ ] **Step 2: 缓存破击号升级(stylesheet 变更的仓库惯例)**

`src/renderer/index.html:29` 的 `./styles.css?v=20260716-motion` 改为 `./styles.css?v=20260722-overhaul`(`test-theme-tokens.mjs` 用正则校验该格式,无需改测试)。

- [ ] **Step 3: 启动应用人工验收**

Run: `npm run start:dev`
核对清单:
1. 浅色(系统浅色或设置里切 light):整体暖灰日光感,紫色点缀;发一条消息 — 用户气泡右侧淡紫、Lily 有头像行、工具卡淡紫底绿勾;输入区/顶栏与 mockup(`.superpowers/brainstorm/` 留存的 `layout-v2.html`)气质一致
2. 深色(设置里切 dark):暖调深灰不泛蓝,同一紫罗兰,对比度正常
3. 边缘面至少各开一个:设置面板、PDF 查看器、diff 面板、权限卡 — 无破版、无不可读文本
4. `CAPABILITY-GATE.md`:无任何功能入口被移除(本计划纯样式 + 一处纯新增 DOM)

- [ ] **Step 4: 收尾提交(先征得用户同意)**

```bash
git add -A
git commit -m "chore: visual overhaul acceptance"
```
