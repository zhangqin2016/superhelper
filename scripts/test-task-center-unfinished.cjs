"use strict";
/**
 * Task center "未完成任务" section + the three sibling renderer changes that
 * shipped with it (steer-first busy-send dialog, silent-model badge, new i18n).
 *
 * [gate: task-completion-integrity]
 *
 * Runs the real index.html body + styles.css in a sandboxed BrowserWindow with a
 * fake `window.assistantClient.tasks` facade. Intent under test:
 *   - the dock is reachable when only unfinished tasks exist (no live runtime items)
 *   - rows render status pill / one-line request / session · project · relative time
 *   - resume calls the facade with the row's ids, toasts, and refreshes the list
 *   - BUSY toasts the busy message and re-arms the button
 *   - non-resumable rows keep a disabled button with a reason
 *   - the busy-send dialog lists steer first, marked primary; interrupt last, danger
 *   - a model with `unavailable.no_response` gets a badge, stays selectable
 *   - every new key resolves in zh-CN / en / ar
 *
 * Run: npx electron scripts/test-task-center-unfinished.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
if (!app?.whenReady) throw new Error("Run with Electron");

const ROOT = path.resolve(__dirname, "..");
const RENDERER = path.join(ROOT, "src/renderer");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "task-center-unfinished-"));
app.setPath("userData", path.join(temp, "profile"));
app.disableHardwareAcceleration();

let win;
const timer = setTimeout(() => finish(1, new Error("timeout")), 45000);
function finish(code, error) {
  clearTimeout(timer);
  if (error) console.error(error);
  require('./electron-test-cleanup.cjs').exitAndRemove({ app, window: win, directory: temp, timer, code });
}

// --- i18n: every new key must exist in all three dictionaries -----------------
const NEW_KEYS = [
  "taskCenter.unfinishedTitle", "taskCenter.unfinishedEmpty", "taskCenter.summaryUnfinished",
  "taskCenter.unfinished.outcome_unknown", "taskCenter.unfinished.failed", "taskCenter.unfinished.unverified",
  "taskCenter.unfinished.blocked", "taskCenter.unfinished.waiting_user", "taskCenter.untitledRequest",
  "taskCenter.resume", "taskCenter.resumeUnavailable", "taskCenter.resumeSessionMissing", "taskCenter.resumed",
  "taskCenter.resumeBusy", "taskCenter.resumeAlready", "taskCenter.resumeFailed",
  "composer.busyChoiceMessage", "composer.modelSilentBadge", "composer.modelSilentTitle",
  "toast.sessionDeletedStoppedJobs",
];
for (const locale of ["zh-CN", "en", "ar"]) {
  const dict = JSON.parse(fs.readFileSync(path.join(RENDERER, `i18n/locales/${locale}.json`), "utf8"));
  const missing = NEW_KEYS.filter((key) => typeof dict[key] !== "string" || !dict[key].trim());
  assert.deepEqual(missing, [], `${locale} must define every new key`);
  assert.match(dict["composer.modelSilentTitle"], /\{n\}[\s\S]*\{s\}/, `${locale} silent title keeps {n} and {s}`);
  assert.match(dict["toast.sessionDeletedStoppedJobs"], /\{n\}/, `${locale} delete toast keeps {n}`);
}
const zh = JSON.parse(fs.readFileSync(path.join(RENDERER, "i18n/locales/zh-CN.json"), "utf8"));
assert.match(zh["composer.busyChoiceMessage"], /插话/, "zh busy message recommends steer");
assert.match(zh["composer.busyChoiceMessage"], /停止并发送/, "zh busy message explains interrupt");

const modUrl = (rel) => JSON.stringify(pathToFileURL(path.join(RENDERER, rel)).href);

app.whenReady().then(async () => {
  const source = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
  const body = source.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const fixture = path.join(temp, "fixture.html");
  fs.writeFileSync(fixture, `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(RENDERER, "styles.css")).href}"><style>*{transition:none!important;animation:none!important}</style></head><body>${body}</body></html>`);
  win = new BrowserWindow({ show: true, width: 1100, height: 820, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(fixture);

  // Fake facade + module bootstrap. Everything the modules touch at import time
  // is stubbed; anything else is a test bug, not a product path.
  await win.webContents.executeJavaScript(`(async () => {
    const now = Date.now();
    const calls = { list: 0, resume: [] };
    let tasks = [
      { sessionId: "s1", turnId: "t1", taskId: "task-1", status: "failed", terminalType: "failed",
        userText: "把季度报表整理成 PPT，并把关键数字做成图表 " + "很长很长的需求".repeat(12),
        sessionTitle: "季度报表", projectId: "p1", projectName: "财务", updatedAt: now - 3 * 60 * 1000, createdAt: now - 10 * 60 * 1000,
        verification: null, resumable: true, sessionMissing: false },
      { sessionId: "s2", turnId: "t2", taskId: "task-2", status: "waiting_user", terminalType: "completed",
        userText: "检查合同条款", sessionTitle: "合同", projectId: "p1", projectName: "财务",
        updatedAt: now - 2 * 60 * 60 * 1000, createdAt: now - 3 * 60 * 60 * 1000, verification: null, resumable: false, sessionMissing: false },
      { sessionId: "s3", turnId: "t3", taskId: "task-3", status: "outcome_unknown", terminalType: "interrupted",
        userText: "", sessionTitle: "", projectId: "", projectName: "", updatedAt: now - 26 * 60 * 60 * 1000, createdAt: 0,
        verification: null, resumable: false, sessionMissing: true },
    ];
    let resumeResult = { ok: true, sessionId: "s1", turnId: "t1", projectId: "p1" };
    window.__fx = { calls, setResumeResult: (r) => { resumeResult = r; }, dropFirst: () => { tasks = tasks.slice(1); } };
    window.assistantClient = {
      tasks: {
        listUnfinished: async () => { calls.list += 1; return { ok: true, tasks }; },
        resume: async (payload) => { calls.resume.push(payload); return resumeResult; },
      },
      getFeatureFlags: async () => ({ steer: true }),
      switchSession: async (id) => ({ ok: true, sessionId: id }),
      getFullState: async () => ({ ok: true, projects: [], activeSessionId: "" }),
      getSessionConversation: async () => ({ ok: true, messages: [] }),
      listModelSelection: async () => ({ ok: true, selection: { mode: "auto", autoPoolMode: "recommended", autoModelIds: ["m1", "m2"], manualModelId: "" },
        models: [
          { id: "m1", label: "Fast Model", modelID: "fast-1" },
          { id: "m2", label: "Quiet Model", modelID: "quiet-9", unavailable: { reason: "no_response", until: now + 600000, count: 3, silentMs: 90000 } },
        ] }),
      setModelSelection: async (selection) => ({ ok: true, selection }),
    };
    const { setLocale } = await import(${modUrl("i18n/index.js")});
    await setLocale("zh-CN", { persist: false });
    const tc = await import(${modUrl("modules/task-center.js")});
    tc.initTaskCenter();
    window.__tc = tc;
  })()`);
  const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  await tick(120);

  // 1. Dock reachable with zero live runtime items; section renders rows/pills/time.
  const rendered = await win.webContents.executeJavaScript(`(async () => {
    const dock = document.getElementById("taskCenterDock");
    const toggle = document.getElementById("taskCenterToggle");
    const panel = document.getElementById("taskCenterPanel");
    const out = { dockHidden: dock.hidden, summary: document.getElementById("taskCenterSummary").textContent, count: document.getElementById("taskCenterCount").textContent, listCallsBeforeOpen: window.__fx.calls.list };
    toggle.click();
    await new Promise((r) => setTimeout(r, 80));
    out.listCallsAfterOpen = window.__fx.calls.list;
    out.panelVisible = !panel.hidden && panel.getClientRects().length > 0;
    const section = panel.querySelector(".task-center-unfinished");
    out.heading = section?.querySelector(".task-center-section-head strong")?.textContent;
    out.sectionCount = section?.querySelector(".task-center-section-count")?.textContent;
    const rows = [...(section?.querySelectorAll(".task-center-task") || [])];
    out.rows = rows.map((row) => {
      const text = row.querySelector(".task-center-task-text");
      const btn = row.querySelector(".task-center-task-resume");
      return {
        cls: row.className, sessionId: row.dataset.sessionId, turnId: row.dataset.turnId,
        pill: row.querySelector(".task-center-task-status").textContent,
        text: text.textContent, textOneLine: text.scrollHeight <= text.clientHeight + 1 && getComputedStyle(text).whiteSpace === "nowrap",
        meta: row.querySelector(".task-center-task-meta").textContent,
        btn: btn.textContent, disabled: btn.disabled, title: btn.title,
      };
    });
    out.rowOverflow = rows.some((row) => row.scrollWidth > row.clientWidth + 1);
    out.panelOverflow = panel.scrollWidth > panel.clientWidth + 1;
    return out;
  })()`);
  assert.equal(rendered.dockHidden, false, "dock must be visible when only unfinished tasks exist");
  assert.equal(rendered.summary, "3 个任务未完成");
  assert.equal(rendered.count, "3");
  assert.ok(rendered.listCallsBeforeOpen >= 1, "list loads at init");
  assert.ok(rendered.listCallsAfterOpen > rendered.listCallsBeforeOpen, "list reloads on panel open");
  assert.equal(rendered.panelVisible, true);
  assert.equal(rendered.heading, "未完成任务");
  assert.equal(rendered.sectionCount, "3");
  assert.equal(rendered.rows.length, 3);
  assert.deepEqual(rendered.rows.map((r) => r.pill), ["失败", "等待确认", "未确认结果"], "status pills in main's order");
  assert.deepEqual(rendered.rows.map((r) => [r.sessionId, r.turnId]), [["s1", "t1"], ["s2", "t2"], ["s3", "t3"]]);
  assert.match(rendered.rows[0].cls, /is-failed/);
  assert.ok(rendered.rows[0].text.startsWith("把季度报表整理成 PPT"), "request text shown");
  assert.equal(rendered.rows[0].textOneLine, true, "request text is one ellipsized line");
  assert.match(rendered.rows[0].meta, /^季度报表 · 财务 · .*3.*分钟/, `meta = session · project · relative time, got ${rendered.rows[0].meta}`);
  assert.match(rendered.rows[1].meta, /^合同 · 财务 · .*2.*小时/, rendered.rows[1].meta);
  assert.deepEqual(rendered.rows.map((r) => r.btn), ["恢复", "恢复", "恢复"]);
  assert.deepEqual(rendered.rows.map((r) => r.disabled), [false, true, true], "only resumable rows arm the button");
  assert.equal(rendered.rows[1].title, "该任务当前无法恢复");
  assert.equal(rendered.rows[2].title, "原对话已不存在");
  assert.equal(rendered.rows[2].text, "（未记录请求内容）");
  assert.match(rendered.rows[2].meta, /^未命名对话 · 未知工作区 · /);
  assert.equal(rendered.rowOverflow, false, "rows must not overflow horizontally");
  assert.equal(rendered.panelOverflow, false);

  // Narrow width + both themes: layout stays inside the panel, pill stays legible.
  for (const [width, theme] of [[420, "light"], [420, "dark"], [1100, "dark"]]) {
    win.setSize(width, 760);
    // The real main window is >=1024px; isolate the task surface below that
    // width instead of leaving its fixed-width desktop sidebar in the fixture.
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.getElementById('appShell').classList.toggle('left-collapsed', ${width < 1024})`);
    await tick(150);
    const geo = await win.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById("taskCenterPanel");
      const rows = [...panel.querySelectorAll(".task-center-task")];
      const pill = rows[0].querySelector(".task-center-task-status");
      const pr = panel.getBoundingClientRect();
      return {
        bounds: { panel: pr.toJSON(), rows: rows.map(row => row.getBoundingClientRect().toJSON()), viewport: innerWidth },
        inside: rows.every((row) => { const r = row.getBoundingClientRect(); return r.left >= pr.left - 1 && r.right <= pr.right + 1; }),
        overflow: rows.some((row) => row.scrollWidth > row.clientWidth + 1) || panel.scrollWidth > panel.clientWidth + 1,
        pillColor: getComputedStyle(pill).color, pillBg: getComputedStyle(pill).backgroundColor,
        btnVisible: rows[0].querySelector(".task-center-task-resume").getClientRects().length > 0,
      };
    })()`);
    assert.equal(geo.inside, true, `${width}/${theme}: rows inside panel ${JSON.stringify(geo.bounds)}`);
    assert.equal(geo.overflow, false, `${width}/${theme}: no horizontal overflow`);
    assert.notEqual(geo.pillColor, geo.pillBg, `${width}/${theme}: pill legible`);
    assert.equal(geo.btnVisible, true);
  }
  win.setSize(1100, 820);
  await tick(100);

  // 2. Resume: facade gets the row's ids, toast, list refreshes (row gone).
  const resumed = await win.webContents.executeJavaScript(`(async () => {
    window.__fx.dropFirst(); // main will report the task as claimed on the next list
    const before = window.__fx.calls.list;
    document.querySelector('.task-center-task[data-session-id="s1"] .task-center-task-resume').click();
    await new Promise((r) => setTimeout(r, 250));
    const toasts = [...document.querySelectorAll(".toast .toast-msg")].map((n) => n.textContent);
    return { resume: window.__fx.calls.resume, toasts, listAfter: window.__fx.calls.list, before,
      remaining: [...document.querySelectorAll(".task-center-task")].map((r) => r.dataset.sessionId),
      panelHidden: document.getElementById("taskCenterPanel").hidden };
  })()`);
  assert.deepEqual(resumed.resume, [{ sessionId: "s1", turnId: "t1" }], "resume called with the row's ids");
  assert.ok(resumed.toasts.includes("已在原对话中继续"), `success toast, got ${JSON.stringify(resumed.toasts)}`);
  assert.ok(resumed.listAfter > resumed.before, "list refreshed after resume");
  assert.deepEqual(resumed.remaining, ["s2", "s3"], "resumed row is gone after refresh");
  assert.equal(resumed.panelHidden, true, "panel closes on resume");

  // 3. BUSY → busy toast, button re-armed, row stays.
  const busy = await win.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll(".toast").forEach((n) => n.remove());
    window.__fx.setResumeResult({ ok: false, error: "BUSY" });
    // make s2 resumable for this step by re-listing with a resumable row
    const facade = window.assistantClient.tasks;
    const orig = facade.listUnfinished;
    facade.listUnfinished = async () => { const r = await orig(); return { ok: true, tasks: r.tasks.map((t) => t.sessionId === "s2" ? { ...t, resumable: true } : t) }; };
    document.getElementById("taskCenterToggle").click();
    await new Promise((r) => setTimeout(r, 120));
    const btn = document.querySelector('.task-center-task[data-session-id="s2"] .task-center-task-resume');
    const armed = !btn.disabled;
    btn.click();
    await new Promise((r) => setTimeout(r, 150));
    return { armed, toasts: [...document.querySelectorAll(".toast .toast-msg")].map((n) => n.textContent), reArmed: !btn.disabled,
      lastResume: window.__fx.calls.resume.at(-1), stillThere: !!document.querySelector('.task-center-task[data-session-id="s2"]') };
  })()`);
  assert.equal(busy.armed, true);
  assert.deepEqual(busy.lastResume, { sessionId: "s2", turnId: "t2" });
  assert.ok(busy.toasts.includes("该对话正在运行，稍后再试"), `busy toast, got ${JSON.stringify(busy.toasts)}`);
  assert.equal(busy.reArmed, true, "button re-armed after BUSY");
  assert.equal(busy.stillThere, true);

  // 4. Facade missing → section absent, nothing thrown, dock hidden with no live items.
  const failOpen = await win.webContents.executeJavaScript(`(async () => {
    const saved = window.assistantClient.tasks;
    delete window.assistantClient.tasks;
    await window.__tc.loadUnfinishedTasks();
    const out = { dockHidden: document.getElementById("taskCenterDock").hidden, tasks: window.__tc.getUnfinishedTasks().length };
    window.assistantClient.tasks = saved;
    return out;
  })()`);
  assert.deepEqual(failOpen, { dockHidden: true, tasks: 0 }, "no facade → no section, no dock");

  // 5. Busy-send dialog: steer first + primary, queue, interrupt last + danger.
  const dialog = await win.webContents.executeJavaScript(`(async () => {
    const { buildBusySendOptions } = await import(${modUrl("modules/composer.js")});
    const { chooseDialog } = await import(${modUrl("modules/confirm-dialog.js")});
    const withSteer = buildBusySendOptions({ steerEnabled: true, characterAuthoringKind: null });
    const noSteer = buildBusySendOptions({ steerEnabled: false, characterAuthoringKind: null });
    const authoring = buildBusySendOptions({ steerEnabled: true, characterAuthoringKind: "character" });
    const pending = chooseDialog({ title: "t", message: "m", options: withSteer });
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    const btns = [...document.querySelectorAll(".choose-dialog-action")];
    const out = {
      withSteer: withSteer.map((o) => [o.value, !!o.primary, !!o.danger]),
      noSteer: noSteer.map((o) => [o.value, !!o.primary, !!o.danger]),
      authoring: authoring.map((o) => o.value),
      labels: btns.map((b) => b.textContent),
      classes: btns.map((b) => b.className),
      focusedFirst: document.activeElement === btns[0],
      primaryBg: getComputedStyle(btns[0]).backgroundColor,
      secondaryBg: getComputedStyle(btns[1]).backgroundColor,
    };
    btns[0].click();
    out.resolved = await pending;
    return out;
  })()`);
  assert.deepEqual(dialog.withSteer, [["steer", true, false], ["queue", false, false], ["interrupt", false, true]]);
  assert.deepEqual(dialog.noSteer, [["queue", false, false], ["interrupt", false, true]], "without steer: today's queue/interrupt form");
  assert.deepEqual(dialog.authoring, ["queue", "interrupt"], "character authoring never offers steer");
  assert.deepEqual(dialog.labels, ["插话（补充给当前任务）", "稍后发送", "停止并发送"]);
  assert.match(dialog.classes[0], /choose-dialog-action-primary/);
  assert.match(dialog.classes[1], /choose-dialog-action-secondary/);
  assert.match(dialog.classes[2], /choose-dialog-action-danger/);
  assert.equal(dialog.focusedFirst, true, "recommended (steer) button takes focus");
  assert.notEqual(dialog.primaryBg, dialog.secondaryBg, "primary is visually distinct from secondary");
  assert.equal(dialog.resolved, "steer");

  // 6. Model picker: silent-model badge, informational only.
  const picker = await win.webContents.executeJavaScript(`(async () => {
    const { initModelPicker } = await import(${modUrl("modules/model-picker.js")});
    initModelPicker();
    document.getElementById("modelSelectionBtn").click();
    await new Promise((r) => setTimeout(r, 120));
    const rows = [...document.querySelectorAll("#modelSelectionAutoList .model-selection-option")];
    return rows.map((row) => ({
      cls: row.className, title: row.title,
      badge: row.querySelector(".model-selection-option-badge")?.textContent ?? null,
      disabled: row.querySelector("input").disabled,
      name: row.querySelector("strong").textContent,
    }));
  })()`);
  assert.equal(picker.length, 2, `two model options, got ${JSON.stringify(picker)}`);
  assert.equal(picker[0].badge, null, "healthy model has no badge");
  assert.equal(picker[0].title, "Fast Model (fast-1)");
  assert.equal(picker[1].badge, "暂无响应");
  assert.match(picker[1].cls, /is-unavailable/);
  assert.equal(picker[1].title, "该模型最近 3 次在 90 秒内没有任何响应，可能暂时不可用");
  assert.equal(picker[1].disabled, false, "silent model stays selectable");
  assert.ok(picker[1].name.startsWith("Quiet Model"));

  // 7. Locale switch re-resolves the section in en (keys are not leaking as raw ids).
  const english = await win.webContents.executeJavaScript(`(async () => {
    const { setLocale } = await import(${modUrl("i18n/index.js")});
    await setLocale("en", { persist: false });
    await window.__tc.loadUnfinishedTasks(); // step 4 emptied it to prove fail-open
    window.__tc.renderTaskCenter();
    document.getElementById("taskCenterPanel").hidden = false;
    await new Promise((r) => setTimeout(r, 30));
    const s = document.querySelector(".task-center-unfinished");
    return { heading: s.querySelector("strong").textContent, pills: [...s.querySelectorAll(".task-center-task-status")].map((n) => n.textContent),
      btn: s.querySelector(".task-center-task-resume").textContent, summary: document.getElementById("taskCenterSummary").textContent };
  })()`);
  assert.equal(english.heading, "Unfinished tasks");
  assert.deepEqual(english.pills, ["Awaiting you", "Outcome unknown"]);
  assert.equal(english.btn, "Resume");
  assert.equal(english.summary, "2 unfinished task(s)");

  console.log("task center unfinished: dock reachable without live items, rows/pills/relative time, resume facade + refresh + toasts (ok/BUSY), disabled non-resumable, steer-first primary busy dialog, silent-model badge, i18n zh/en/ar");
  finish(0);
}).catch((error) => finish(1, error));
