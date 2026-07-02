"use strict";

// Background media-result tracker. Image/video generation is a long async task; the
// skill submits → polls → downloads → prints <generated_media>. If the turn is torn
// down (no-progress watchdog / interrupt) before that final stdout is captured, the
// file lands on disk but the workbench never shows it. The skill also drops a small
// result record at <workspace>/generated-assets/.lily-results/*.json; this tracker
// sweeps those and surfaces the media into the right session — so a finished
// generation is never lost, regardless of the turn's fate.
//
// Fully additive + fail-open: if the live turn already showed the media (normal case)
// we dedup and just delete the record; any error is swallowed.

const fs = require("node:fs");
const path = require("node:path");

const RESULTS_SUBPATH = path.join("generated-assets", ".lily-results");
// Let the live turn surface the media first; only sweep records older than this so the
// normal (turn-alive) path wins and the tracker is the safety net for orphaned results.
const GRACE_MS = 30_000;

function extractPaths(content) {
  const out = [];
  const re = /<file\s+path="([^"]+)"/g;
  let m;
  while ((m = re.exec(String(content || "")))) out.push(m[1]);
  return out;
}

// Already surfaced by the live turn? Scan the session's recent messages for the file
// path(s). If present, the in-turn render already showed it → don't double-post.
function alreadyShown(ctx, sessionId, paths) {
  if (!paths.length) return false;
  let messages = [];
  try {
    messages = ctx.sessionManager.getConversation(sessionId) || [];
  } catch {
    return false;
  }
  const recent = messages.slice(-12);
  return recent.some((message) => {
    let blob = "";
    try { blob = JSON.stringify(message?.content ?? message?.text ?? message ?? ""); } catch { blob = ""; }
    return paths.some((p) => blob.includes(p));
  });
}

function sessionForProject(ctx, project) {
  const active = ctx.sessionManager.activeSessionId;
  try {
    const a = active && ctx.sessionManager.findById?.(active);
    if (a && a.projectId === project.id) return active;
  } catch { /* fall through */ }
  let list = [];
  try { list = ctx.sessionManager.listForProject(project.id) || []; } catch { list = []; }
  return list.length ? list[list.length - 1].id : null;
}

function safeRm(p) {
  try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
}

function sessionCanReceiveFallback(ctx, sessionId) {
  let snap = null;
  try { snap = ctx.turnOrchestrator?.snapshot?.(sessionId) || null; } catch { snap = null; }
  if (!snap) return true;
  return snap.phase === "idle" && !(snap.queueLength > 0);
}

function sweep(ctx, now = Date.now()) {
  const projects = ctx.projectManager?.projects || [];
  for (const project of projects) {
    const dir = path.join(project.path || "", RESULTS_SUBPATH);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const file of files) {
      const full = path.join(dir, file);
      let record;
      try { record = JSON.parse(fs.readFileSync(full, "utf8")); } catch { safeRm(full); continue; }
      if (record.createdAt && now - record.createdAt < GRACE_MS) continue; // give the live turn a chance
      const sessionId = sessionForProject(ctx, project);
      if (!sessionId) continue; // no session to attach to yet — leave for a later sweep
      const paths = extractPaths(record.content);
      if (alreadyShown(ctx, sessionId, paths)) { safeRm(full); continue; } // dedup vs the live turn
      if (!sessionCanReceiveFallback(ctx, sessionId)) continue; // never surface fallback media as a queued user message
      try {
        const label = record.type === "video" ? "🎬 视频已生成" : "🖼️ 图片已生成";
        ctx.turnOrchestrator.completeLocalAssistantTurn(sessionId, label, [], {
          recordUser: false,
          assistant: `${label}\n${record.content || ""}`,
        });
      } catch { /* swallow — try again next sweep is avoided by the delete below only on success... */ }
      safeRm(full);
    }
  }
}

function startMediaResultTracker(ctx, { intervalMs = 5000 } = {}) {
  const timer = setInterval(() => {
    try { sweep(ctx); } catch { /* never let the tracker crash the app */ }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { startMediaResultTracker, sweep, extractPaths, alreadyShown, sessionForProject, sessionCanReceiveFallback, GRACE_MS };
