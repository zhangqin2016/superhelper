# 智能工作台性能与架构优化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三个独立优化阶段 — Phase 1 流式渲染性能（降低 CPU 50%+），Phase 2 代码架构整理（拆分巨型模块），Phase 3 可靠性与内存（防泄漏、规范化）。

**Architecture:** 每个 Phase 独立可交付，改动不同文件无冲突。执行顺序：Phase 1 → Phase 2 → Phase 3。

**Tech Stack:** Vanilla JS (Electron main + renderer), DOMPurify, marked, highlight.js

---

## Phase 1 — 流式渲染性能优化

### 现状

`markdown.js` 的 `renderMarkdown(element, markdownText)` 每次收到 chunk 就做：
1. `marked.parse(全文)` — 重新解析整个累积 Markdown
2. `hl.highlight()` / `hl.highlightAuto()` — 对同一代码块重复高亮
3. `DOMPurify.sanitize(html)` — 全文 HTML 清洗
4. `element.innerHTML = html` — 全量 DOM 替换

流式场景下每秒 10-20 个 chunk，每个 chunk 触发上述 4 步，CPU 严重浪费。

### 目标

- 纯文本 chunk 仅追加 `textContent`，不触发 Markdown 解析
- 代码块按内容 hash 缓存高亮结果，内容不变则复用
- 仅在确实包含 HTML 标签时才走 `DOMPurify.sanitize`

---

### Task 1: 新增纯文本判断与缓存函数

**Files:**
- Modify: `src/renderer/modules/markdown.js`

- [ ] **Step 1: 验证现有行为**

```bash
# 启动应用，发一条消息，观察 DevTools Performance 面板中 renderMarkdown 的调用频率
npm run start:dev
```

手动发送消息，在 DevTools Console 中观察流式回复时 UI 是否流畅。记录基准感受。

- [ ] **Step 2: 在 markdown.js 新增代码块缓存和纯文本追加逻辑**

在文件末尾追加以下新函数（不改动现有 `renderMarkdown`）：

```javascript
// --- 新增：流式渲染优化 ---

/** @type {Map<string, string>} 代码块内容hash → 已高亮的HTML */
const codeCache = new Map();

function hashContent(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function hasHtmlTags(text) {
  return /<[a-zA-Z][^>]*>/.test(text);
}

/**
 * 纯文本追加，不走 Markdown 解析和 Sanitize。
 * 仅在内容包含 HTML 标签时才走完整渲染流程。
 */
export function appendTextContent(element, text) {
  if (!element) return;
  element.textContent += text;
}

/**
 * 流式场景专用：对已渲染过的代码块复用缓存高亮结果。
 * 需要调用方自己维护 markdownText 的追加逻辑，此处只做最终渲染。
 * 返回是否走了缓存（用于调试/测量）。
 */
export function renderMarkdownWithCache(element, markdownText) {
  const parser = window.marked && (window.marked.parse || window.marked);
  if (typeof parser !== "function" || !window.DOMPurify) {
    element.textContent = markdownText || "";
    return { cached: false };
  }

  let cachedCount = 0;
  const renderer = new window.marked.Renderer();

  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    if (!href) return text;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
  };

  renderer.code = function ({ text, lang }) {
    const key = hashContent(`${lang || ""}:${text}`);
    const cached = codeCache.get(key);
    if (cached) {
      cachedCount++;
      return cached;
    }
    let result;
    if (window.hljs && lang && window.hljs.getLanguage(lang)) {
      try {
        result = `<pre><code class="hljs language-${lang}">${window.hljs.highlight(text, { language: lang }).value}</code></pre>`;
      } catch {
        result = `<pre><code>${escapeHtml(text)}</code></pre>`;
      }
    } else {
      result = `<pre><code>${escapeHtml(text)}</code></pre>`;
    }
    codeCache.set(key, result);
    return result;
  };

  const html = parser(markdownText || "", { renderer });

  if (hasHtmlTags(html)) {
    element.innerHTML = window.DOMPurify.sanitize(html);
  } else {
    element.textContent = markdownText || "";
  }

  return { cached: cachedCount > 0, cachedCount };
}

/**
 * 清理代码高亮缓存（切换会话或清空对话时调用）。
 */
export function clearHighlightCache() {
  codeCache.clear();
}
```

> 注意：保留原有 `escapeHtml` 函数不变。

- [ ] **Step 3: 在 message.js 的 onChunk 处理器中接入增量逻辑**

修改 `src/renderer/modules/message.js`，将 `onChunk` 回调中的 `renderMarkdown` 调用替换为增量追加方式。

找到 `wireMessageIpc` 函数中的 `onChunk` 回调（约第 604 行）：

```javascript
// 原代码:
window.assistantClient.onChunk((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    const v = view(sessionId);

    let bubble = v.activeBubble;
    if (!bubble) {
      bubble = beginAssistantTurn(sessionId);
    }
    v.activeMarkdown = softenStreamGlue(
      appendMarkdownSegment(v.activeMarkdown, payload.text),
    );
    renderMarkdown(bubble, v.activeMarkdown);  // <-- 每次chunk都全量渲染
    // ...
```

修改为：

```javascript
// 新代码:
import { renderMarkdownWithCache, appendTextContent, clearHighlightCache } from "./markdown.js";

// 在 onChunk 回调中:
window.assistantClient.onChunk((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    const v = view(sessionId);

    let bubble = v.activeBubble;
    if (!bubble) {
      bubble = beginAssistantTurn(sessionId);
    }
    v.activeMarkdown = softenStreamGlue(
      appendMarkdownSegment(v.activeMarkdown, payload.text),
    );

    // 如果当前 bubble 是纯文本（无HTML），增量追加文本即可
    // 只有在文本包含代码块标记或HTML标签时才走完整渲染
    const hasCodeFence = v.activeMarkdown.includes("```");
    const hasHtmlInNew = hasHtmlTags(payload.text);
    const threshold = v.activeMarkdown.length - v._lastRenderedLength > 200;

    if (hasCodeFence || hasHtmlInNew || threshold) {
      renderMarkdownWithCache(bubble, v.activeMarkdown);
      v._lastRenderedLength = v.activeMarkdown.length;
    } else {
      // 纯文本增量追加
      // bubble 已经是 pending 状态，直接追加 textContent
      bubble.textContent += (bubble.textContent ? "\n\n" : "") + payload.text;
    }
    // ...
```

> 注意：需要在 `beginAssistantTurn` 中初始化 `_lastRenderedLength = 0`。

在 `beginAssistantTurn` 函数的 `v.activeTurn` 赋值之后添加：

```javascript
v._lastRenderedLength = 0;
```

- [ ] **Step 4: 在 renderConversation 和 finishActiveTurn 中清理缓存**

在 `renderConversation` 函数开头（进入新会话渲染历史消息时）添加：

```javascript
clearHighlightCache();
```

在 `finishActiveTurn` 函数中重置渲染计数：

```javascript
v._lastRenderedLength = 0;
```

- [ ] **Step 5: 提交**

```bash
git add src/renderer/modules/markdown.js src/renderer/modules/message.js
git commit -m "perf: 流式渲染增量优化 — 纯文本追加不走 Markdown 解析、代码高亮缓存复用、避免重复 DOMPurify

- 纯文本 chunk 直接用 textContent 追加，不触发 marked.parse
- 代码块按 (lang + content) hash 缓存高亮结果
- 仅在文本含 HTML 标签时才走 DOMPurify.sanitize
- 每 200 字符或遇到代码块时做一次完整渲染作为保底"
```

---

## Phase 2 — 代码架构整理

### 现状

- `ipc-handlers.js`: 940 行，包含所有领域的 IPC 处理器 + runner wiring + 诊断 + 发送逻辑
- `message.js`: 772 行，混合 DOM 渲染 + 工具卡片 + 忙碌状态 + 重试 + 滚动
- 忙碌检查+terminateAll 模式在 ipc-handlers.js 中重复出现 8 次
- 延迟 import (`await import("./toast.js")`) 在 message.js 中出现 4 次

### 目标

- ipc-handlers 拆为 5 个按领域划分的文件，原文件变为薄编排层
- message.js 中工具卡片逻辑独立为 tool-cards.js
- 抽取 `withRunnerChange` 高阶函数消除重复
- 预加载动态 import 消除运行时延迟

---

### Task 2: 抽取 withRunnerChange 消除重复模式

**Files:**
- Modify: `src/main/ipc-handlers.js`

- [ ] **Step 1: 在 ipc-handlers.js 顶部新增 withRunnerChange 函数**

在文件顶部（`registerAll` 函数之前）添加：

```javascript
/**
 * 执行一个会改变 runner 状态的操作：
 * - 如果任何 runner 正忙 → 直接返回 BUSY
 * - 操作成功后 → 终止所有 runner（下次发消息时重建）
 * @param {object} ctx
 * @param {() => { ok: boolean } | { ok: boolean, [key: string]: any }} action
 * @param {{ refreshState?: boolean }} [opts]
 */
function withRunnerChange(ctx, action, opts = {}) {
  if (anyRunnerBusy(ctx.runnerPool)) {
    return { ok: false, error: "BUSY" };
  }
  const result = action();
  if (result.ok) {
    ctx.runnerPool.terminateAll();
    if (opts.refreshState && ctx.agentBootstrap?.agentDefaults) {
      ctx.agentBootstrap.agentDefaults.disallowedTools =
        require("./skill-manager").getDisallowedTools();
    }
  }
  return result;
}
```

- [ ] **Step 2: 替换现有 8 处重复模式**

以下每个 handler 替换前对比确认。以 `models:set-active` 为例：

```javascript
// 替换前:
ipcMain.handle("models:set-active", (_event, presetId) => {
  if (anyRunnerBusy(runnerPool)) {
    return { ok: false, error: "BUSY" };
  }
  const result = setActivePreset(presetId);
  if (result.ok) {
    runnerPool.terminateAll();
  }
  return result.ok ? { ok: true, ...listPresetsPublic() } : result;
});

// 替换后:
ipcMain.handle("models:set-active", (_event, presetId) => {
  return withRunnerChange(ctx, () => {
    const r = setActivePreset(presetId);
    return r.ok ? { ok: true, ...listPresetsPublic() } : r;
  });
});
```

需要替换的 handler 列表：
1. `models:set-active` (L493-501)
2. `models:delete-custom` (L512-521)
3. `models:set-api-gateway` (L523-532)
4. `permissions:set-active` (L539-550)
5. `search:set-provider` (L557-565)
6. `search:set-searxng-url` (L567-574)
7. `skills:set-enabled` (L584-598) — 特殊处理，需额外设置 disallowedTools
8. `skills:refresh` (L601-608)

对于 `skills:set-enabled` 这种需要额外操作的，传入 `{ refreshState: true }`。

- [ ] **Step 3: 验证运行正常**

```bash
npm start
```

手动测试：切换模型、切换权限模式、切换搜索设置、开关技能，确认提示"设置已生效"且下次对话正常。

- [ ] **Step 4: 提交**

```bash
git add src/main/ipc-handlers.js
git commit -m "refactor: 抽取 withRunnerChange 消除 8 处重复的 runner 忙检查+重启模式"
```

---

### Task 3: 拆分 ipc-handlers.js 为 5 个子模块

**Files:**
- Create: `src/main/ipc-files.js`
- Create: `src/main/ipc-models.js`
- Create: `src/main/ipc-projects.js`
- Create: `src/main/ipc-sessions.js`
- Create: `src/main/ipc-assistant.js`
- Modify: `src/main/ipc-handlers.js`

- [ ] **Step 1: 创建 src/main/ipc-files.js**

包含文件 staging 相关的 6 个 handler：`files:pick`, `files:stage`, `files:paste`, `files:thumbnail`, `files:dimensions`, `files:clear-staging`。

```javascript
"use strict";

const { ipcMain, dialog } = require("electron");
const FileStagingManager = require("./file-staging-manager");
const { fileStagingDir } = require("./config");

function registerFileHandlers(mainWindow, stagingManager) {
  ipcMain.handle("files:pick", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择文件",
      properties: ["openFile", "multiSelections"],
      filters: FileStagingManager.getFileFilters(),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const staged = [];
    const errors = [];
    for (const filePath of result.filePaths) {
      try {
        const meta = stagingManager.stageFromPath(filePath);
        staged.push(meta);
      } catch (err) {
        errors.push({ path: filePath, error: err.message });
      }
    }
    return { ok: true, files: staged, errors };
  });

  ipcMain.handle("files:stage", (_event, filePath) => {
    try {
      const meta = stagingManager.stageFromPath(filePath);
      return { ok: true, file: meta };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("files:paste", (_event, buffer, fileName) => {
    try {
      const meta = stagingManager.stageFromBuffer(buffer, fileName);
      return { ok: true, file: meta };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("files:thumbnail", (_event, fileId) => {
    const dataUrl = stagingManager.getThumbnail(fileId);
    return { ok: true, dataUrl };
  });

  ipcMain.handle("files:dimensions", (_event, filePath) => {
    const dims = stagingManager.getDimensions(filePath);
    return dims ? { ok: true, ...dims } : { ok: false };
  });

  ipcMain.handle("files:clear-staging", () => {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const dir = fileStagingDir();
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
          fs.unlinkSync(path.join(dir, name));
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerFileHandlers };
```

- [ ] **Step 2: 创建 src/main/ipc-models.js**

包含模型、权限、搜索设置相关的 6 个 handler。

```javascript
"use strict";

const { ipcMain } = require("electron");
const { listPresetsPublic, setActivePreset, saveCustomPreset, deleteCustomPreset, setApiGateway } = require("./model-presets");

function registerModelHandlers(runnerPool) {
  const { withRunnerChange } = require("./ipc-handlers");

  ipcMain.handle("models:list", () => ({ ok: true, ...listPresetsPublic() }));

  ipcMain.handle("models:set-active", (_event, presetId) => {
    return withRunnerChange({ runnerPool }, () => {
      const r = setActivePreset(presetId);
      return r.ok ? { ok: true, ...listPresetsPublic() } : r;
    });
  });

  ipcMain.handle("models:save-custom", (_event, payload) => {
    if (require("./ipc-handlers").anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    return saveCustomPreset(payload || {});
  });

  ipcMain.handle("models:delete-custom", (_event, presetId) => {
    return withRunnerChange({ runnerPool }, () => deleteCustomPreset(presetId));
  });

  ipcMain.handle("models:set-api-gateway", (_event, payload) => {
    return withRunnerChange({ runnerPool }, () => setApiGateway(payload || {}));
  });
}

function registerPermissionHandlers(runnerPool) {
  const { withRunnerChange } = require("./ipc-handlers");
  const perm = require("./permission-settings");

  ipcMain.handle("permissions:list", () => ({
    ok: true,
    ...perm.listPermissionsPublic(),
  }));

  ipcMain.handle("permissions:set-active", (_event, modeId) => {
    return withRunnerChange({ runnerPool }, () => {
      const r = perm.setActivePermissionMode(modeId);
      return r.ok ? { ok: true, ...perm.listPermissionsPublic() } : r;
    });
  });
}

function registerSearchHandlers(runnerPool) {
  const { withRunnerChange } = require("./ipc-handlers");
  const search = require("./search-settings");

  ipcMain.handle("search:list", () => ({
    ok: true,
    ...search.listSearchSettingsPublic(),
  }));

  ipcMain.handle("search:set-provider", (_event, providerId) => {
    return withRunnerChange({ runnerPool }, () => {
      const r = search.setSearchProvider(providerId);
      return r.ok ? { ok: true, ...search.listSearchSettingsPublic() } : r;
    });
  });

  ipcMain.handle("search:set-searxng-url", (_event, url) => {
    return withRunnerChange({ runnerPool }, () => {
      const r = search.setSearxngUrl(url);
      return r.ok ? { ok: true, ...search.listSearchSettingsPublic() } : r;
    });
  });
}

module.exports = { registerModelHandlers, registerPermissionHandlers, registerSearchHandlers };
```

- [ ] **Step 3: 创建 src/main/ipc-projects.js**

包含项目相关的 6 个 handler。

```javascript
"use strict";

const { ipcMain, dialog, shell } = require("electron");

function registerProjectHandlers(ctx) {
  const { mainWindow, projectManager, sessionManager, runnerPool } = ctx;

  ipcMain.handle("project:list", () => projectManager.getAppState());

  ipcMain.handle("project:add", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择文件夹",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const project = projectManager.add(result.filePaths[0]);
    sessionManager.create(project.id, "默认对话");
    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:switch", (_event, projectId) => {
    if (!projectManager.switchTo(projectId)) {
      return { ok: false, error: "NOT_FOUND" };
    }
    const sessions = sessionManager.listForProject(projectId);
    if (sessions.length > 0) {
      sessionManager.activeSessionId = sessions[0].id;
      sessionManager.save();
      require("./ipc-handlers").ensureSessionRunner(ctx, sessions[0].id);
    }
    return { ok: true, state: projectManager.getAppState(), sessions };
  });

  ipcMain.handle("project:rename", (_event, projectId, name) => {
    const trimmed = String(name || "").trim();
    if (!projectManager.rename(projectId, trimmed)) return { ok: false, error: "INVALID" };
    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:pin", (_event, projectId) => {
    if (!projectManager.togglePin(projectId)) return { ok: false, error: "NOT_FOUND" };
    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:open", async (_event, projectId) => {
    const project = projectManager.find(projectId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    const error = await shell.openPath(project.path);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle("project:remove", (_event, projectId) => {
    const sessionIds = sessionManager.purgeProject(projectId);
    for (const sessionId of sessionIds) {
      runnerPool.terminateSession(sessionId);
    }
    const result = projectManager.remove(projectId);
    if (result !== "OK") return { ok: false, error: result };

    const active = projectManager.getActive();
    if (!active) {
      sessionManager.activeSessionId = null;
      sessionManager.save();
    } else {
      sessionManager.ensureDefaultForProject(active.id);
      if (!sessionManager.findById(sessionManager.activeSessionId)) {
        const remaining = sessionManager.listForProject(active.id);
        if (remaining.length > 0) {
          sessionManager.switchTo(remaining[0].id);
        }
      }
    }
    return { ok: true, state: projectManager.getAppState() };
  });
}

module.exports = { registerProjectHandlers };
```

- [ ] **Step 4: 创建 src/main/ipc-sessions.js**

包含会话和技能相关的 10 个 handler。

```javascript
"use strict";

const { ipcMain } = require("electron");
const skillManager = require("./skill-manager");

function registerSessionHandlers(ctx) {
  const { sessionManager, projectManager, runnerPool } = ctx;

  ipcMain.handle("session:list", () => {
    const project = projectManager.getActive();
    if (!project) {
      return { sessions: [], activeSessionId: null };
    }
    return {
      sessions: sessionManager.listForProject(project.id),
      activeSessionId: sessionManager.activeSessionId,
    };
  });

  ipcMain.handle("session:create", (_event, title, projectId) => {
    const pid = projectId || projectManager.getActive()?.id;
    if (!pid) return { ok: false, error: "NO_PROJECT" };
    const session = sessionManager.create(pid, title);
    require("./ipc-handlers").ensureSessionRunner(ctx, session.id);
    return { ok: true, session: { id: session.id, title: session.title, projectId: pid } };
  });

  ipcMain.handle("session:switch", (_event, sessionId) => {
    sessionManager.switchTo(sessionId);
    require("./ipc-handlers").ensureSessionRunner(ctx, sessionId);
    const session = sessionManager.findById(sessionId);
    return {
      ok: true,
      sessionId,
      conversation: session?.messages || [],
      runnerActive: runnerPool.has(sessionId),
    };
  });

  ipcMain.handle("session:rename", (_event, sessionId, title) => {
    const trimmed = String(title || "").trim();
    if (!trimmed) return { ok: false, error: "INVALID" };
    if (!sessionManager.rename(sessionId, trimmed)) return { ok: false, error: "NOT_FOUND" };
    return { ok: true };
  });

  ipcMain.handle("session:delete", (_event, sessionId) => {
    runnerPool.terminateSession(sessionId);
    const result = sessionManager.delete(sessionId);
    if (result !== "OK") return { ok: false, error: result };
    return { ok: true };
  });

  ipcMain.handle("session:archive", (_event, sessionId) => {
    runnerPool.terminateSession(sessionId);
    sessionManager.archive(sessionId);
    return { ok: true };
  });

  ipcMain.handle("session:get-skills", (_event, sessionId) => {
    const sid = sessionId || sessionManager.activeSessionId;
    const session = sid ? sessionManager.findById(sid) : null;
    if (!session) return { ok: false, error: "NOT_FOUND" };
    return {
      ok: true,
      sessionId: sid,
      ...skillManager.listSkillsForSessionPublic(session),
    };
  });

  ipcMain.handle("session:set-skills", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.activeSessionId;
    const session = sessionId ? sessionManager.findById(sessionId) : null;
    if (!session) return { ok: false, error: "NOT_FOUND" };
    const { isSessionBusy } = require("./ipc-handlers");
    if (isSessionBusy(runnerPool, sessionId)) {
      return { ok: false, error: "BUSY" };
    }
    const normalized = skillManager.normalizeSessionSkillSelection(payload?.enabledSkillIds);
    if (!sessionManager.setEnabledSkillIds(sessionId, normalized)) {
      return { ok: false, error: "NOT_FOUND" };
    }
    const updated = sessionManager.findById(sessionId);
    skillManager.writeSessionAgentGuide(sessionId, updated);
    runnerPool.terminateSession(sessionId);
    return {
      ok: true,
      sessionId,
      ...skillManager.listSkillsForSessionPublic(updated),
    };
  });
}

function registerSkillHandlers(ctx) {
  const { runnerPool } = ctx;
  const { withRunnerChange } = require("./ipc-handlers");

  ipcMain.handle("skills:list", () => ({
    ok: true,
    skills: skillManager.listSkillsPublic(),
  }));

  ipcMain.handle("skills:set-enabled", (_event, payload) => {
    const id = payload?.id;
    const enabled = Boolean(payload?.enabled);
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => {
      return skillManager.setSkillEnabledWithSessions(id, enabled, ctx.sessionManager);
    }, { refreshState: true });
  });

  ipcMain.handle("skills:refresh", () => {
    return withRunnerChange(ctx, () => skillManager.refreshSkillsConfig());
  });

  ipcMain.handle("skills:restore-bundled", (_event, payload) => {
    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.restoreBundledSkill(id));
  });

  ipcMain.handle("skills:get-registry-url", () => ({
    ok: true,
    registryUrl: skillManager.getRegistryUrl(),
  }));

  ipcMain.handle("skills:set-registry-url", (_event, payload) => {
    const url = payload?.url ?? payload;
    return skillManager.setRegistryUrl(url);
  });

  ipcMain.handle("skills:check-updates", async () => {
    if (require("./ipc-handlers").anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    return skillManager.checkRegistryUpdates({ fetch: true });
  });

  ipcMain.handle("skills:install", async (_event, payload) => {
    const id = payload?.id;
    const version = payload?.version;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.installFromRegistry(id, version));
  });

  ipcMain.handle("skills:update", async (_event, payload) => {
    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.updateFromRegistry(id));
  });

  ipcMain.handle("skills:uninstall", (_event, payload) => {
    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.uninstallRemoteSkill(id));
  });
}

module.exports = { registerSessionHandlers, registerSkillHandlers };
```

- [ ] **Step 5: 创建 src/main/ipc-assistant.js**

包含 assistant 消息收发、runner wiring、状态查询。从 ipc-handlers.js 中提取 `wireRunner`, `ensureSessionRunner`, `diagnoseSendBlocker`, `dispatchUserLine` 和相关的 handler。

```javascript
"use strict";

const fs = require("node:fs");
const { ipcMain } = require("electron");
const { resolveAgentCommand } = require("./agent-command");
const { sanitizeError, appendTextSegment } = require("./agent-runner");
const { notifySessionFinished } = require("./background-notify");
const { fileStagingDir } = require("./config");
const skillManager = require("./skill-manager");
const {
  migrateGlobalResumeArtifacts,
  resetSessionEngineCache,
} = require("./session-engine-recovery");

/** @type {Map<string, string>} */
const lastRunnerStderr = new Map();

function sendToRenderer(window, channel, payload) {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

/** Sessions with an in-flight assistant turn (guards duplicate done/error). */
const activeTurns = new Set();
/** @type {Map<string, string>} */
const turnOutputs = new Map();

function wireRunner(ctx, runner) {
  if (runner._ipcWired) return;
  runner._ipcWired = true;

  const sessionId = runner.sessionId;
  const { sessionManager } = ctx;

  runner.on("chunk", (text) => {
    const prev = turnOutputs.get(sessionId) || "";
    const next = appendTextSegment(prev, text);
    turnOutputs.set(sessionId, next);
    sendToRenderer(ctx.mainWindow, "assistant:chunk", { sessionId, text });
  });

  runner.on("stderr", (text) => {
    const trimmed = String(text || "").trim();
    if (trimmed) lastRunnerStderr.set(sessionId, trimmed);
    console.error(`[agent stderr ${sessionId}]`, text);
  });

  runner.on("tool-using", (data) => {
    sendToRenderer(ctx.mainWindow, "assistant:tool", { sessionId, ...data });
  });

  runner.on("tool-done", (data) => {
    sendToRenderer(ctx.mainWindow, "assistant:tool-done", { sessionId, ...data });
  });

  runner.on("status", (state) => {
    if (state === "thinking") {
      sessionManager.setStatus(sessionId, "running");
    }
    sendToRenderer(ctx.mainWindow, "assistant:status", { state, sessionId });
  });

  runner.on("agent-resume-id", (agentResumeId) => {
    sessionManager.setAgentResumeId(sessionId, agentResumeId);
  });

  runner.on("done", ({ code, output, interrupted }) => {
    const inTurn = activeTurns.has(sessionId);
    activeTurns.delete(sessionId);

    const finalOutput = (output || turnOutputs.get(sessionId) || "").trim();
    turnOutputs.delete(sessionId);

    if (inTurn) {
      if (finalOutput) {
        sessionManager.pushMessageTo(sessionId, "assistant", finalOutput);
        lastRunnerStderr.delete(sessionId);
      } else if (!interrupted && code !== 0 && code !== null) {
        const stderrHint = lastRunnerStderr.get(sessionId);
        lastRunnerStderr.delete(sessionId);
        sessionManager.clearAgentResumeId(sessionId);
        resetSessionEngineCache(sessionId);
        ctx.runnerPool.terminateSession(sessionId);
        const friendly = stderrHint
          ? sanitizeError(stderrHint)
          : "这次没有收到有效回复。对话连接已重置，请再发一次（可简要说明要继续的内容）。";
        sessionManager.pushMessageTo(sessionId, "assistant", friendly, null, {
          failed: true,
        });
      } else {
        lastRunnerStderr.delete(sessionId);
      }
    }

    sessionManager.setStatus(sessionId, "idle");
    sendToRenderer(ctx.mainWindow, "assistant:done", { code, sessionId, interrupted });

    const session = sessionManager.findById(sessionId);
    const wasFocused = ctx.mainWindow?.isFocused?.() ?? true;
    if (!wasFocused) {
      notifySessionFinished(ctx.mainWindow, {
        sessionId,
        sessionTitle: session?.title,
        ok: Boolean(finalOutput),
        body: finalOutput,
      });
    }
  });

  runner.on("error", (message) => {
    if (!activeTurns.has(sessionId)) return;
    activeTurns.delete(sessionId);
    turnOutputs.delete(sessionId);
    const friendly =
      message === "BUSY"
        ? "上一条消息还在处理中，请稍后再试。"
        : sanitizeError(String(message));
    sessionManager.pushMessageTo(sessionId, "assistant", friendly, null, {
      failed: true,
    });
    sessionManager.setStatus(sessionId, "idle");
    sendToRenderer(ctx.mainWindow, "assistant:error", {
      sessionId,
      message: friendly,
    });
  });
}

function resolveProjectForSession(projectManager, session) {
  if (!session) return null;
  const project = projectManager.find(session.projectId);
  if (project) return project;
  return null;
}

function diagnoseSendBlocker(ctx, sessionId) {
  const cliPath = resolveAgentCommand();
  if (!cliPath) {
    return {
      error: "NO_CLI",
      detail: "内置助手引擎未安装。请完全退出应用后重新打开。",
    };
  }
  if (!fs.existsSync(cliPath)) {
    return {
      error: "NO_CLI",
      detail: `引擎文件不存在：${cliPath}`,
    };
  }

  const { sessionManager, projectManager } = ctx;
  const session =
    sessionManager.findById(sessionId) || sessionManager.getActive();
  if (!session) {
    return { error: "NO_SESSION", detail: "请先创建或选择一个对话。" };
  }

  const project = resolveProjectForSession(projectManager, session);
  if (!project) {
    return { error: "NO_PROJECT", detail: "对话所属的文件夹已不存在，请重新添加文件夹。" };
  }
  if (!fs.existsSync(project.path)) {
    return {
      error: "INVALID_WORKDIR",
      detail: `工作目录不存在：${project.path}`,
    };
  }

  return null;
}

function ensureSessionRunner(ctx, sessionId) {
  const { sessionManager, projectManager, runnerPool } = ctx;
  const session = sessionManager.findById(sessionId);
  if (!session) {
    return {
      runner: null,
      error: "NO_SESSION",
      detail: "对话不存在或已删除，请重新选择或新建对话。",
    };
  }

  const project = resolveProjectForSession(projectManager, session);
  if (!project) {
    return {
      runner: null,
      error: "NO_PROJECT",
      detail: "对话所属的文件夹已不存在，请重新添加文件夹。",
    };
  }

  const cliPath = resolveAgentCommand();
  if (!cliPath) {
    return {
      runner: null,
      error: "NO_CLI",
      detail: "内置助手引擎未安装。请完全退出应用后重新打开。",
    };
  }
  if (!fs.existsSync(cliPath)) {
    return {
      runner: null,
      error: "NO_CLI",
      detail: `引擎文件不存在：${cliPath}`,
    };
  }
  if (!fs.existsSync(project.path)) {
    return {
      runner: null,
      error: "INVALID_WORKDIR",
      detail: `工作目录不存在：${project.path}`,
    };
  }

  const stagingDir = fileStagingDir();
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
  } catch (err) {
    console.warn("[runner] could not create staging dir:", err.message);
  }
  const configDir = skillManager.writeSessionAgentGuide(sessionId, session);
  if (session.agentResumeId) {
    migrateGlobalResumeArtifacts(sessionId, session.agentResumeId);
  }
  const extra = {
    disallowedTools: skillManager.getDisallowedTools(),
    stagingDir,
    resumeSessionId: session.agentResumeId || null,
    configDir,
  };

  try {
    const runner = runnerPool.ensure(sessionId, project.path, extra);
    wireRunner(ctx, runner);
    return { runner };
  } catch (err) {
    console.error("[runner]", sessionId, err.message);
    if (err.stack) console.error(err.stack);
    const detail =
      err.message && !/^(RUNNER_|AGENT_|NO_)/.test(err.message)
        ? err.message
        : sanitizeError(err.message);
    return { runner: null, error: "RUNNER_ERROR", detail };
  }
}

function warmupActiveRunner(ctx) {
  const session = ctx.sessionManager.getActive();
  if (!session) return;
  const result = ensureSessionRunner(ctx, session.id);
  if (!result.runner) {
    console.error("[runner] warmup failed:", result.error, result.detail);
  }
}

function buildInputLine(text, files = []) {
  const parts = [String(text || "").trim()];
  for (const f of files) {
    if (f.path) parts.push(f.path);
  }
  return parts.filter(Boolean).join(" ");
}

function fileMetadataFromPayload(files = []) {
  return files.map((f) => ({
    id: f.id,
    name: f.name,
    path: f.path,
    type: f.type,
    size: f.size,
    isImage: f.isImage,
  }));
}

function dispatchUserLine(ctx, session, text, files = [], opts = {}) {
  const { sessionManager } = ctx;
  const recordUser = opts.recordUser !== false;

  const blocked = diagnoseSendBlocker(ctx, session.id);
  if (blocked) {
    console.error("[assistant:send]", blocked.error, blocked.detail);
    return { ok: false, error: blocked.error, detail: blocked.detail };
  }

  const line = buildInputLine(text, files);
  if (!line) return { ok: false, error: "EMPTY" };

  const ensured = ensureSessionRunner(ctx, session.id);
  const runner = ensured.runner;
  if (!runner) {
    return {
      ok: false,
      error: ensured.error || "RUNNER_ERROR",
      detail:
        ensured.detail ||
        "无法启动助手进程，请查看终端日志或重启应用。",
    };
  }

  if (runner.isBusy() || activeTurns.has(session.id)) {
    return { ok: false, error: "BUSY" };
  }

  turnOutputs.set(session.id, "");
  activeTurns.add(session.id);

  const sent = runner.sendUserMessage(line);
  if (!sent) {
    activeTurns.delete(session.id);
    turnOutputs.delete(session.id);
    return { ok: false, error: "BUSY" };
  }

  if (recordUser) {
    const fileMetadata = fileMetadataFromPayload(files);
    sessionManager.pushMessageTo(
      session.id,
      "user",
      String(text || "").trim(),
      fileMetadata,
    );
  }

  return { ok: true };
}

function registerAssistantHandlers(ctx) {
  const { sessionManager, runnerPool } = ctx;

  ipcMain.handle("assistant:input", (_event, payload) => {
    const text = typeof payload === "string" ? payload : payload.text;
    const files = typeof payload === "object" && payload.files ? payload.files : [];

    const session = sessionManager.getActive();
    if (!session) return { ok: false, error: "NO_SESSION" };

    return dispatchUserLine(ctx, session, text, files, { recordUser: true });
  });

  ipcMain.handle("assistant:retry", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    const session = sessionId ? sessionManager.findById(sessionId) : null;
    if (!session) return { ok: false, error: "NO_SESSION" };

    const lastUser = sessionManager.getLastUserMessage(session.id);
    if (!lastUser) return { ok: false, error: "NO_USER_MESSAGE" };

    const lastMsg = session.messages[session.messages.length - 1];
    if (lastMsg?.role !== "assistant") {
      return { ok: false, error: "NOTHING_TO_RETRY" };
    }

    const storedFiles = lastUser.files || [];
    const files = [];
    const missing = [];
    for (const f of storedFiles) {
      if (f.path && fs.existsSync(f.path)) {
        files.push(f);
      } else if (storedFiles.length > 0) {
        missing.push(f.name || f.path || "file");
      }
    }
    if (storedFiles.length > 0 && files.length !== storedFiles.length) {
      return {
        ok: false,
        error: "FILES_UNAVAILABLE",
        detail: missing.length
          ? `附件已失效：${missing.join("、")}`
          : "原消息含附件，但路径已不可用，请重新添加附件后发送。",
      };
    }

    sessionManager.popLastAssistantMessage(session.id);

    const result = dispatchUserLine(ctx, session, lastUser.content, files, {
      recordUser: false,
    });
    if (!result.ok) {
      sessionManager.pushMessageTo(
        session.id,
        "assistant",
        lastMsg.content,
        lastMsg.files || null,
        lastMsg.failed ? { failed: true } : null,
      );
    }
    return result;
  });

  ipcMain.handle("assistant:interrupt", () => {
    const session = sessionManager.getActive();
    if (!session) return { ok: false, error: "NO_SESSION" };

    const hadTurn = activeTurns.has(session.id);
    const runner = runnerPool.get(session.id);
    runner?.interrupt();

    sessionManager.setStatus(session.id, "idle");

    if (hadTurn && activeTurns.has(session.id)) {
      activeTurns.delete(session.id);
      turnOutputs.delete(session.id);
      sendToRenderer(ctx.mainWindow, "assistant:done", {
        code: null,
        sessionId: session.id,
        interrupted: true,
      });
    } else if (!hadTurn) {
      sendToRenderer(ctx.mainWindow, "assistant:done", {
        code: null,
        sessionId: session.id,
        interrupted: true,
      });
    }
    return { ok: true };
  });

  warmupActiveRunner(ctx);
}

module.exports = {
  registerAssistantHandlers,
  ensureSessionRunner,
  warmupActiveRunner,
  activeTurns,
  turnOutputs,
  sendToRenderer,
};
```

- [ ] **Step 6: 重写 ipc-handlers.js 为薄编排层**

将原文件改为只做导入和编排，所有原 handler 代码替换为对子模块的调用。

```javascript
"use strict";

const { ipcMain } = require("electron");
const { resolveAgentCommand } = require("./agent-command");
const { listPresetsPublic } = require("./model-presets");
const { SessionRunnerPool } = require("./session-runner-pool");
const { resolveRuntimeIconDataUrl } = require("./app-icon");
const { listLocalesPublic, setLocale } = require("./locale-settings");
const { registerFileHandlers } = require("./ipc-files");
const { registerModelHandlers, registerPermissionHandlers, registerSearchHandlers } = require("./ipc-models");
const { registerProjectHandlers } = require("./ipc-projects");
const { registerSessionHandlers, registerSkillHandlers } = require("./ipc-sessions");
const { registerAssistantHandlers, ensureSessionRunner, warmupActiveRunner, activeTurns } = require("./ipc-assistant");

function anyRunnerBusy(runnerPool) {
  for (const sessionId of runnerPool.getSessionIds()) {
    const runner = runnerPool.get(sessionId);
    if (runner?.isBusy()) return true;
  }
  return false;
}

function isSessionBusy(runnerPool, sessionId, activeTurnIds = activeTurns) {
  if (!sessionId) return false;
  if (activeTurnIds.has(sessionId)) return true;
  return Boolean(runnerPool.get(sessionId)?.isBusy());
}

function getRunningSessionIds(runnerPool, sessionManager) {
  const ids = new Set(activeTurns);
  for (const sessionId of runnerPool.getSessionIds()) {
    if (runnerPool.get(sessionId)?.isBusy()) ids.add(sessionId);
  }
  for (const list of Object.values(sessionManager.sessions)) {
    for (const session of list) {
      if (session.status === "running") ids.add(session.id);
    }
  }
  return [...ids];
}

/**
 * 执行会改变 runner 状态的操作。
 */
function withRunnerChange(ctx, action, opts = {}) {
  if (anyRunnerBusy(ctx.runnerPool)) {
    return { ok: false, error: "BUSY" };
  }
  const result = action();
  if (result.ok) {
    ctx.runnerPool.terminateAll();
    if (opts.refreshState && ctx.agentBootstrap?.agentDefaults) {
      ctx.agentBootstrap.agentDefaults.disallowedTools =
        require("./skill-manager").getDisallowedTools();
    }
  }
  return result;
}

function registerAll(ctx) {
  const {
    mainWindow, projectManager, sessionManager,
    stagingManager, runnerPool,
  } = ctx;

  // --- App ---------------------------------------------------------------

  ipcMain.handle("app:get-icon-url", () => resolveRuntimeIconDataUrl());
  ipcMain.handle("app:get-locale", () => ({ ok: true, ...listLocalesPublic() }));
  ipcMain.handle("app:set-locale", (_event, locale) => {
    const result = setLocale(locale);
    return { ok: true, locale: result.locale, supported: listLocalesPublic().supported };
  });

  // --- State ---------------------------------------------------------------

  ipcMain.handle("state:full", () => {
    const projectState = projectManager.getAppState();
    const active = sessionManager.getActive();
    const projectsWithSessions = projectState.projects.map((p) => ({
      ...p,
      sessions: sessionManager.listForProject(p.id).map((s) => {
        const full = sessionManager.findById(s.id);
        return { ...s, messages: full?.messages || [] };
      }),
    }));
    const cliPath = resolveAgentCommand();
    const agent = ctx.agentBootstrap || { ok: false };
    const cliReady = Boolean(cliPath && fs.existsSync(cliPath));
    return {
      activeProjectId: projectState.activeProjectId,
      activeSessionId: sessionManager.activeSessionId,
      projects: projectsWithSessions,
      conversation: active?.messages || [],
      runnerSessionIds: runnerPool.getSessionIds(),
      runningSessionIds: getRunningSessionIds(runnerPool, sessionManager),
      agent: {
        ...agent,
        ok: cliReady,
        cliPath: cliPath || agent.cliPath || null,
        ready: cliReady,
      },
      models: listPresetsPublic(),
      permissions: require("./permission-settings").listPermissionsPublic(),
    };
  });

  // --- Sub-module registrations ---

  registerFileHandlers(mainWindow, stagingManager);
  registerModelHandlers(runnerPool);
  registerPermissionHandlers(runnerPool);
  registerSearchHandlers(runnerPool);
  registerProjectHandlers(ctx);
  registerSessionHandlers(ctx);
  registerSkillHandlers(ctx);
  registerAssistantHandlers(ctx);

  warmupActiveRunner(ctx);
}

module.exports = {
  registerAll,
  ensureSessionRunner,
  warmupActiveRunner,
  anyRunnerBusy,
  isSessionBusy,
  getRunningSessionIds,
  withRunnerChange,
};
```

> 注意：`ipc-assistant.js` 和 `ipc-handlers.js` 之间有循环引用（`ipc-assistant.js` ⇄ `ipc-handlers.js` 互相引用帮助函数），Node.js 的 CommonJS 可以处理部分完成导出的循环引用，但需要验证。如果出问题，可以将 `ensureSessionRunner` 和 `withRunnerChange` 等共享函数提取到 `src/main/ipc-utils.js`。

- [ ] **Step 7: 运行验证**

```bash
npm start
```

验证所有功能：添加项目、创建会话、发送消息、切换模型/权限/搜索、管理技能、文件附件、重试、中断。

- [ ] **Step 8: 提交**

```bash
git add src/main/ipc-handlers.js src/main/ipc-files.js src/main/ipc-models.js src/main/ipc-projects.js src/main/ipc-sessions.js src/main/ipc-assistant.js
git commit -m "refactor: 拆分 ipc-handlers.js (940行) 为 5 个按领域划分的子模块

- ipc-files.js: 文件暂存 6 个 handler
- ipc-models.js: 模型/权限/搜索 10 个 handler
- ipc-projects.js: 项目 6 个 handler
- ipc-sessions.js: 会话/技能 17 个 handler
- ipc-assistant.js: 消息收发 + runner wiring
- ipc-handlers.js: 薄编排层 (~120 行)"
```

---

### Task 4: 拆分 message.js 工具卡片逻辑

**Files:**
- Create: `src/renderer/modules/tool-cards.js`
- Modify: `src/renderer/modules/message.js`

- [ ] **Step 1: 创建 src/renderer/modules/tool-cards.js**

从 message.js 中提取所有工具卡片相关函数：`toolSummary`, `basename`, `clip`, `addToolCard`, `updateToolCard`, `clearToolCards`, `countRunningTools`, `syncTurnProgress`, `syncActivityVisibility`, `refreshRunningActivityLabel`, `updateBusyMeta`。

```javascript
/**
 * Tool card rendering — displayed during assistant tool execution.
 */
import { $, scrollToBottom } from "./dom.js";
import store from "./state.js";
import { t } from "../i18n/index.js";

function basename(path) {
  if (!path) return "";
  const parts = String(path).split(/[/\\]/);
  return parts[parts.length - 1] || String(path);
}

function clip(text, max = 72) {
  const value = String(text || "").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function toolSummary(name, input = {}) {
  switch (name) {
    case "Read":
      return { title: t("tool.readFile"), detail: basename(input.file_path || input.path || input.target_file) };
    case "Write":
      return { title: t("tool.writeFile"), detail: basename(input.file_path || input.path) };
    case "Edit":
    case "MultiEdit":
      return { title: t("tool.editFile"), detail: basename(input.file_path || input.path) };
    case "Bash":
      return { title: t("tool.runCommand"), detail: clip(input.command || input.description) };
    case "Grep":
      return { title: t("tool.searchContent"), detail: clip(input.pattern || input.query) };
    case "Glob":
      return { title: t("tool.findFiles"), detail: clip(input.pattern || input.glob_pattern) };
    case "WebSearch":
    case "web_search_prime":
      return { title: t("tool.webSearch"), detail: clip(input.query || input.search_query) };
    case "webReader":
      return { title: t("tool.readWeb"), detail: clip(input.url) };
    default:
      return {
        title: name || t("tool.processing"),
        detail: clip(input.query || input.prompt || input.description || input.file_path || input.path),
      };
  }
}

function renderToolCardContent(card, name, input) {
  const { title, detail } = toolSummary(name, input);
  card.replaceChildren();

  const dot = document.createElement("span");
  dot.className = "tool-card-dot";

  const textWrap = document.createElement("div");
  textWrap.style.minWidth = "0";
  textWrap.style.flex = "1";

  const label = document.createElement("span");
  label.className = "tool-card-label";
  label.textContent = title;

  textWrap.appendChild(label);
  if (detail) {
    const detailEl = document.createElement("span");
    detailEl.className = "tool-card-detail";
    detailEl.textContent = detail;
    textWrap.appendChild(detailEl);
  }

  card.append(dot, textWrap);
}

export function countRunningTools(toolCards) {
  let n = 0;
  for (const entry of toolCards.values()) {
    if (entry.status === "running") n++;
  }
  return n;
}

export function addToolCard(viewState, toolCards, sessionId, id, name, input) {
  if (!viewState.activeTurn) return;

  const summary = toolSummary(name, input);
  viewState.activityLabel = summary.detail
    ? `${summary.title}：${summary.detail}`
    : summary.title;

  const card = document.createElement("div");
  card.className = "tool-card tool-card-running";
  card.dataset.toolId = id;
  renderToolCardContent(card, name, input);

  viewState.activeTurn.activity.appendChild(card);
  viewState.activeTurn.activity.hidden = false;
  scrollToBottom(false, viewState.panel);
  toolCards.set(id, { card, name, input, status: "running" });
}

export function updateToolCard(viewState, toolCards, sessionId, id, status) {
  const entry = toolCards.get(id);
  if (!entry) return;

  if (status === "failed") {
    entry.card.classList.remove("tool-card-running");
    entry.card.classList.add("tool-card-failed");
    entry.card.querySelector(".tool-card-label").textContent =
      t("message.toolFailed", { title: toolSummary(entry.name, entry.input).title });
    entry.status = "failed";
    toolCards.delete(id);
    viewState.activityLabel = t("message.adjusting");
    window.setTimeout(() => {
      entry.card.remove();
      syncActivityVisibility(viewState);
    }, 4000);
  } else {
    entry.card.classList.remove("tool-card-running");
    entry.card.classList.add("tool-card-done");
    entry.card.querySelector(".tool-card-dot")?.classList.add("tool-card-dot-done");
    entry.status = "done";
  }
}

export function syncActivityVisibility(viewState) {
  const turn = viewState.activeTurn;
  if (!turn) return;
  turn.activity.hidden = turn.activity.childElementCount === 0;
}

export function clearToolCards(toolCards, viewState) {
  for (const { card } of toolCards.values()) {
    card.remove();
  }
  toolCards.clear();
  viewState.activeTurn?.activity?.querySelectorAll(".turn-progress").forEach((el) => el.remove());
  syncActivityVisibility(viewState);
}

export function syncTurnProgress(viewState, toolCards) {
  if (!viewState.activeTurn?.activity) return;

  const progress = viewState.activeTurn.activity.querySelector(".turn-progress");
  const waiting = isActiveSession(sessionId) && store.get("isBusy") && countRunningTools(toolCards) === 0;

  if (waiting) {
    if (!progress) {
      const row = document.createElement("div");
      row.className = "turn-progress tool-card tool-card-running";
      const dot = document.createElement("span");
      dot.className = "tool-card-dot";
      const label = document.createElement("span");
      label.className = "tool-card-label";
      label.textContent = t("message.continuing");
      row.append(dot, label);
      viewState.activeTurn.activity.appendChild(row);
    }
    viewState.activeTurn.activity.hidden = false;
  } else if (progress) {
    progress.remove();
  }
}

export function updateBusyMeta(viewState) {
  const meta = $("sessionMeta");
  if (!meta || !store.get("isBusy")) return;
  meta.textContent = viewState.activityLabel || t("message.processing");
}

export function refreshRunningActivityLabel(viewState, toolCards) {
  for (const entry of toolCards.values()) {
    if (entry.status !== "running") continue;
    const summary = toolSummary(entry.name, entry.input);
    viewState.activityLabel = summary.detail
      ? `${summary.title}：${summary.detail}`
      : summary.title;
    return;
  }
  if (store.get("isBusy")) {
    viewState.activityLabel = t("message.continuing");
  }
}
```

- [ ] **Step 2: 从 message.js 中移除已提取的函数，改为从 tool-cards.js 导入**

在 message.js 中：
- 删除 `toolSummary`, `basename`, `clip`, `addToolCard`, `updateToolCard`, `clearToolCards`, `countRunningTools`, `syncTurnProgress`, `syncActivityVisibility`, `refreshRunningActivityLabel`, `updateBusyMeta`
- 在文件顶部添加导入：

```javascript
import {
  toolSummary,
  addToolCard,
  updateToolCard,
  clearToolCards,
  countRunningTools,
  syncTurnProgress,
  syncActivityVisibility,
  refreshRunningActivityLabel,
  updateBusyMeta,
} from "./tool-cards.js";
```

- 修改 `addToolCard` 的调用点，传入 `viewState` 和 `toolCards`：

```javascript
// 原: addToolCard(sessionId, payload.id, payload.name, payload.input);
// 新: addToolCard(v, v.toolCards, sessionId, payload.id, payload.name, payload.input);
```

- 同样修改 `updateToolCard`、`clearToolCards`、`syncTurnProgress` 的调用。

- [ ] **Step 3: 将延迟 import 改为顶层导入**

在 message.js 中，将以下动态 import 改为顶层静态 import：

```javascript
// 删除这些行:
// const { showToast } = await import("./toast.js");
// const { refreshStateLight } = await import("./session-chrome.js");
// import("./project-tree.js").then(...)

// 改为顶层导入:
import { showToast } from "./toast.js";
import { refreshStateLight, activeProject, updateTopbarTitles } from "./session-chrome.js";
import { updateSessionRunningIndicators } from "./project-tree.js";
```

如果存在循环引用问题，用函数参数注入或事件总线解耦，不要保留动态 import。

- [ ] **Step 4: 运行验证**

```bash
npm start
```

发送消息触发工具调用，观察工具卡片是否正常显示（running → done/failed → 消失），忙碌状态指示器是否正常。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/modules/tool-cards.js src/renderer/modules/message.js
git commit -m "refactor: 从 message.js 提取 tool-cards.js，预加载延迟 import

- 工具卡片逻辑独立为 tool-cards.js (~180 行)
- message.js 减少 ~200 行
- 将 4 处 await import() 改为顶层静态 import"
```

---

## Phase 3 — 可靠性与内存优化

### 现状

- 9 处空 catch 块静默吞异常
- 日志无结构、无级别控制
- `turnOutputs`/`activeTurns` 模块级可变状态，生命周期不可控
- `sessionViews` Map 永不清除已删除会话
- 每次 `pushMessage` 都同步写磁盘

### 目标

- 所有 catch 块至少 `console.warn`
- 创建统一的 logger 包装
- 将模块级状态封装到类实例中
- sessionViews 在会话删除时清理
- 会话保存加 debounce

---

### Task 5: 创建结构化 Logger

**Files:**
- Create: `src/main/logger.js`
- Modify: `src/main/agent-session.js` (3 处)
- Modify: `src/main/agent-bootstrap.js` (3 处)
- Modify: `src/main/ipc-assistant.js` (新增)

- [ ] **Step 1: 创建 src/main/logger.js**

```javascript
"use strict";

const levels = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  constructor(namespace) {
    this.namespace = namespace;
  }

  _log(level, message, ...args) {
    const timestamp = new Date().toISOString().split("T")[1].slice(0, 12);
    const prefix = `[${timestamp} ${level.toUpperCase()} ${this.namespace}]`;
    if (level === "error") {
      console.error(prefix, message, ...args);
    } else if (level === "warn") {
      console.warn(prefix, message, ...args);
    } else {
      console.log(prefix, message, ...args);
    }
  }

  debug(msg, ...args) { this._log("debug", msg, ...args); }
  info(msg, ...args) { this._log("info", msg, ...args); }
  warn(msg, ...args) { this._log("warn", msg, ...args); }
  error(msg, ...args) { this._log("error", msg, ...args); }
}

const loggers = new Map();

function getLogger(namespace) {
  if (!loggers.has(namespace)) {
    loggers.set(namespace, new Logger(namespace));
  }
  return loggers.get(namespace);
}

module.exports = { Logger, getLogger };
```

- [ ] **Step 2: 在 agent-session.js 中替换空 catch 块**

共 3 处空 catch（sendUserMessage 的 write 回调、interrupt 的 kill、terminate 的 kill）。

```javascript
// 在文件顶部添加:
const { getLogger } = require("./logger");
const log = getLogger("agent-session");

// 修改 interrupt (L203):
  try {
    this.process.kill("SIGINT");
  } catch {
    log.warn("interrupt kill failed");
  }

// 修改 terminate (L228):
  try {
    this.process.kill("SIGTERM");
  } catch {
    log.warn("terminate kill failed (process already dead)");
  }
```

> `sendUserMessage` 中 `stdin.write` 的回调错误已经通过 `this._failTurn` 处理，无需额外日志。

- [ ] **Step 3: 在 agent-bootstrap.js 中替换空 catch 块**

共 3 处空 catch（xattr 失败、legacy 删除失败、migrate rename 失败 — 最后这个已有 fallback copy）。

```javascript
const { getLogger } = require("./logger");
const log = getLogger("agent-bootstrap");

// xattr (L108):
  } catch {
    log.warn("xattr cleanup failed (non-critical)");
  }

// removeLegacyInstalledCli (L121):
  } catch {
    log.warn("legacy cli removal failed", legacy);
  }
```

- [ ] **Step 4: 在 ipc-assistant.js 中替换现有 console.error 为 logger**

在 `ensureSessionRunner` 和 `warmupActiveRunner` 中：

```javascript
const { getLogger } = require("./logger");
const log = getLogger("ipc-assistant");

// 替换:
log.error("[runner]", sessionId, err.message);
// 等等
```

- [ ] **Step 5: 提交**

```bash
git add src/main/logger.js src/main/agent-session.js src/main/agent-bootstrap.js src/main/ipc-assistant.js
git commit -m "feat: 新增结构化 Logger，空 catch 块改为 warn 日志"
```

---

### Task 6: 封装模块级可变状态 + 清理会话视图

**Files:**
- Modify: `src/main/ipc-assistant.js` — 将 `activeTurns`/`turnOutputs` 封装为 `TurnState` 类
- Modify: `src/renderer/modules/message.js` — 在 `removeSessionMessages` 时清理 toolCards

- [ ] **Step 1: 在 ipc-assistant.js 中封装 TurnState**

将模块级的 `activeTurns` Set 和 `turnOutputs` Map 封装：

```javascript
class TurnState {
  constructor() {
    this.activeTurns = new Set();
    this.turnOutputs = new Map();
  }

  start(sessionId) {
    this.activeTurns.add(sessionId);
    this.turnOutputs.set(sessionId, "");
  }

  end(sessionId) {
    this.activeTurns.delete(sessionId);
    const output = this.turnOutputs.get(sessionId) || "";
    this.turnOutputs.delete(sessionId);
    return output;
  }

  has(sessionId) {
    return this.activeTurns.has(sessionId);
  }

  getOutput(sessionId) {
    return this.turnOutputs.get(sessionId) || "";
  }

  appendOutput(sessionId, text) {
    const prev = this.turnOutputs.get(sessionId) || "";
    const next = appendTextSegment(prev, text);
    this.turnOutputs.set(sessionId, next);
    return next;
  }
}

const turnState = new TurnState();
```

然后更新 `dispatchUserLine` 和 `wireRunner` 中对 `activeTurns`/`turnOutputs` 的引用，全部改为 `turnState.start()/turnState.end()/turnState.has()/turnState.getOutput()/turnState.appendOutput()`。

- [ ] **Step 2: 在 message.js 中清理视图时一并清理 toolCards**

在 `removeSessionMessages` 函数中添加：

```javascript
export function removeSessionMessages(sessionId) {
  const v = sessionViews.get(sessionId);
  if (!v) return;
  // 清理未完成的工具卡片
  for (const { card } of v.toolCards.values()) {
    card.remove();
  }
  v.toolCards.clear();
  v.panel?.remove();
  sessionViews.delete(sessionId);
}
```

- [ ] **Step 3: 提交**

```bash
git add src/main/ipc-assistant.js src/renderer/modules/message.js
git commit -m "refactor: TurnState 封装 turn 生命周期状态，删除会话时清理 toolCards"
```

---

### Task 7: 会话保存加 debounce

**Files:**
- Modify: `src/main/session-manager.js`

- [ ] **Step 1: 在 SessionManager 中添加 debounce 保存**

在 `SessionManager` 类中添加：

```javascript
class SessionManager {
  constructor(projectManager) {
    this.pm = projectManager;
    this.sessions = {};
    this.activeSessionId = null;
    this._saveTimer = null;
    this._savePending = false;
  }

  /** 延迟写入磁盘，合并高频 save() 调用 */
  _scheduleSave() {
    if (this._saveTimer) {
      this._savePending = true;
      return;
    }
    this._doSave();
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._savePending) {
        this._savePending = false;
        this._doSave();
      }
    }, 500);
  }

  _doSave() {
    const dir = path.dirname(sessionsConfigPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      sessionsConfigPath(),
      JSON.stringify(
        { activeSessionId: this.activeSessionId, sessions: this.sessions },
        null,
        2,
      ),
    );
  }

  /** 立即刷盘（关键操作如创建/删除/切换会话时不延迟） */
  saveImmediate() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._savePending = false;
    }
    this._doSave();
  }

  save() {
    this._scheduleSave();
  }
```

然后将 `create`, `delete`, `switchTo`, `archive`, `purgeProject`, `clearConversation`, `rename` 等关键操作中的 `this.save()` 改为 `this.saveImmediate()`，将 `pushMessage`, `setStatus`, `setEnabledSkillIds`, `updateAt` 等高频操作中的 `this.save()` 保持为 `this.save()`（走 debounce）。

- [ ] **Step 2: 验证**

```bash
npm start
```

发送多条消息，确认消息被正确保存。重启应用确认历史消息不丢失。

- [ ] **Step 3: 提交**

```bash
git add src/main/session-manager.js
git commit -m "perf: session-manager 写入防抖 — 高频 pushMessage 合并写入，关键操作立即刷盘"
```

---

## 执行顺序与依赖

```
Phase 1 (渲染性能)
  ├── Task 1: 增量渲染 + 代码缓存  ← 无依赖，先做
  └── (完成)
        │
Phase 2 (架构整理)
  ├── Task 2: withRunnerChange      ← 无依赖
  ├── Task 3: ipc-handlers 拆分      ← 依赖 Task 2（用了 withRunnerChange）
  ├── Task 4: message.js 拆分        ← 无依赖（独立渲染进程改动）
  └── (完成)
        │
Phase 3 (可靠性)
  ├── Task 5: Logger                ← 无依赖
  ├── Task 6: TurnState + 视图清理   ← 依赖 Task 3（ipc-assistant.js 已存在）
  ├── Task 7: session debounce      ← 无依赖
  └── (完成)
```

每个 Phase 完成后可独立交付测试，三个 Phase 共 7 个 Task。
