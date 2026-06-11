#!/usr/bin/env node
"use strict";
// Replay benchmark, renderer side (docs/turn-block-experience-plan.md M5).
// Streams a long synthetic turn through session-runtime-store and the real
// turn-view DOM render loop, measuring per-render cost as the turn grows.
//
// Primary gate: late renders must not cost wildly more than early renders
// (per-render cost growing with turn length is the O(n²) failure class).
// Absolute ceilings are generous and machine-independent only in spirit —
// they catch catastrophic breaks, not drifts.

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const root = path.join(__dirname, "..");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, "src/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  await new Promise((r) => setTimeout(r, 1500));

  const result = await win.webContents.executeJavaScript(`(
    async () => {
      const { applyRuntimeEvent, getRuntimeSession } = await import("./modules/session-runtime-store.js");
      const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");

      const sessionId = "session_bench_replay";
      const turnId = "turn_bench_replay";
      let ts = 1_000_000;
      const ev = (type, payload = {}) => applyRuntimeEvent({ sessionId, turnId, type, ts: ts++, payload });

      ev("turn.started", {});
      const runtime = getRuntimeSession(sessionId);
      const liveTurn = runtime.liveTurn;
      const article = createLiveTurnArticleShell(liveTurn);
      document.body.appendChild(article);

      const BATCHES = 80;
      const renders = [];
      let toolSeq = 0;
      for (let batch = 0; batch < BATCHES; batch += 1) {
        for (let i = 0; i < 6; i += 1) {
          ev("assistant.thinking.delta", { text: "推理推进一步，分析当前的状态。" });
        }
        for (let i = 0; i < 10; i += 1) {
          ev("assistant.delta", { text: "正文增量内容，包含中文与 code 片段。" });
        }
        if (batch % 8 === 4) {
          const id = "tool_" + (++toolSeq);
          ev("tool.started", { id, name: "Bash", input: { command: "npm test --run step " + batch } });
          ev("tool.done", { id, status: "done", result: { content: "ok" } });
        }
        const t0 = performance.now();
        renderLiveTurnArticle(article, getRuntimeSession(sessionId).liveTurn, { sessionId });
        renders.push(performance.now() - t0);
      }
      ev("turn.completed", { assistant: "", durationMs: 1000 });
      const t0 = performance.now();
      renderLiveTurnArticle(article, getRuntimeSession(sessionId).liveTurn, { sessionId, sealed: true });
      const sealMs = performance.now() - t0;
      article.remove();

      const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const early = avg(renders.slice(5, 15));
      const late = avg(renders.slice(-10));
      const max = Math.max(...renders);
      return JSON.stringify({
        batches: BATCHES,
        earlyMs: +early.toFixed(2),
        lateMs: +late.toFixed(2),
        growth: +(late / Math.max(early, 0.05)).toFixed(2),
        maxMs: +max.toFixed(2),
        sealMs: +sealMs.toFixed(2),
        entries: getRuntimeSession(sessionId).liveTurn.timeline.length,
      });
    }
  )()`);

  const metrics = JSON.parse(result);
  console.log(
    `renderer: ${metrics.batches} batches, early ${metrics.earlyMs}ms → late ${metrics.lateMs}ms ` +
    `(growth ${metrics.growth}x), max ${metrics.maxMs}ms, seal ${metrics.sealMs}ms, entries ${metrics.entries}`,
  );

  const failures = [];
  // Per-render cost must not balloon as the turn grows (quadratic class).
  if (metrics.growth > 6) failures.push(`late renders cost ${metrics.growth}x early renders (> 6x)`);
  // Catastrophic ceilings, generous for slow CI machines.
  if (metrics.maxMs > 400) failures.push(`worst live render ${metrics.maxMs}ms (> 400ms ceiling)`);
  if (metrics.sealMs > 2000) failures.push(`seal render ${metrics.sealMs}ms (> 2s ceiling)`);

  if (failures.length) {
    console.error("bench-replay-renderer FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    app.exitCode = 1;
  } else {
    console.log("bench-replay-renderer: ok");
  }
  app.quit();
});
