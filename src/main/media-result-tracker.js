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
const { deliverMediaResult, containsMediaPaths } = require("./media-result-delivery");

const RESULTS_SUBPATH = path.join("generated-assets", ".lily-results");
// The host-named inbox the media skills write to (LILY_MEDIA_RESULTS_DIR): a
// custom output_dir or a `cd` into a subfolder put records outside
// <workspace>/generated-assets/.lily-results, where no sweep ever looked.
// RESULTS_SUBPATH stays swept for records written by older skill copies.
const INBOX_NAME = "media-results";
// An inbox record no workspace owns (output written outside every project) is
// dropped after this, with a log line, instead of being re-read forever.
const INBOX_ORPHAN_MS = 7 * 24 * 60 * 60 * 1000;

function mediaResultsInbox(userDataDir) {
  return userDataDir ? path.join(userDataDir, INBOX_NAME) : "";
}

function defaultInbox() {
  try { return mediaResultsInbox(require("electron").app.getPath("userData")); } catch { return ""; }
}

// What the renderer shows as generated media: a complete <generated_media>
// block. A listing, a `cat`, or a marker cut off by `| tail` only mentions the
// path, so it neither shows the media nor proves it was shown.
const MARKER_BLOCK = /<generated_media\b[^>]*>[\s\S]*?<\/generated_media>/g;
function markerBlocks(value) {
  const blocks = [];
  const visit = (v) => {
    if (typeof v === "string") {
      // Tool results are often stored JSON-encoded; decoding keeps a Windows
      // path's separators single so it matches the record's path.
      if (/^\s*[{[]/.test(v)) {
        try { visit(JSON.parse(v)); return; } catch { /* plain text that starts with a brace */ }
      }
      blocks.push(...(v.match(MARKER_BLOCK) || []));
    } else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return blocks;
}
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
    messages = ctx.sessionManager.getRecentConversation?.(sessionId, { limit: 12 }) || ctx.sessionManager.getConversation(sessionId) || [];
  } catch {
    return false;
  }
  const recent = messages.slice(-12);
  return containsMediaPaths(recent.filter((message) => message?.role === "assistant"
    && !message.meta?.mediaResult).map((message) => ({
    content: message.content || message.text,
    artifacts: message.record?.artifacts,
    results: message.record?.resultBlocks,
    outputs: message.record?.tools?.filter((t) => !t.isError && t.status === "done").map((t) => markerBlocks(t.result)),
  })), paths);
}

function sessionForProject(ctx, project, record = {}) {
  if (record.sessionId) {
    const owner = ctx.sessionManager.findById?.(record.sessionId);
    return owner?.projectId === project.id ? owner.id : null;
  }
  let list = [];
  try { list = ctx.sessionManager.listForProject(project.id) || []; } catch { list = []; }
  if (list.length === 1) return list[0].id;
  const paths = extractPaths(record.content);
  if (!paths.length) return null;
  const matches = list.filter((session) => {
    try {
      const messages = ctx.sessionManager.getRecentConversation?.(session.id, { limit: 12 }) || [];
      return messages.some((m) => m.role === "assistant" && containsMediaPaths(m.record || m.content, paths));
    } catch { return false; }
  });
  // An old record with ambiguous ownership stays pending, never sent to whichever
  // conversation happens to be open when the timer fires.
  return matches.length === 1 ? matches[0].id : null;
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

function owningProject(projects, paths) {
  let best = null;
  for (const project of projects) {
    const root = project?.path ? path.resolve(project.path) : "";
    if (!root) continue;
    const owns = paths.every((p) => {
      const file = path.resolve(p);
      return file === root || file.startsWith(root + path.sep);
    });
    if (owns && (!best || root.length > path.resolve(best.path).length)) best = project;
  }
  return best;
}

function sweepRecord(ctx, full, project, now) {
  let record;
  try { record = JSON.parse(fs.readFileSync(full, "utf8")); } catch (error) {
    console.warn(`[media-result-tracker] unreadable record ${full}: ${error?.message || error}`);
    return;
  }
  if (record.createdAt && now - record.createdAt < GRACE_MS) return; // give the live turn a chance
  const paths = extractPaths(record.content);
  if (!paths.length) return;
  const owner = project || owningProject(ctx.projectManager?.projects || [], paths);
  if (!owner) {
    if (record.createdAt && now - record.createdAt > INBOX_ORPHAN_MS) {
      console.warn(`[media-result-tracker] dropping ${full}: no workspace owns ${paths.join(", ")}`);
      safeRm(full);
    }
    return;
  }
  const sessionId = sessionForProject(ctx, owner, record);
  if (!sessionId) return; // no session to attach to yet — leave for a later sweep
  if (alreadyShown(ctx, sessionId, paths)) { safeRm(full); return; } // dedup vs the live turn
  if (!sessionCanReceiveFallback(ctx, sessionId)) return; // never surface fallback media as a queued user message
  try {
    if (deliverMediaResult(ctx, sessionId, record, paths)) safeRm(full);
  } catch (error) {
    // Retain the receipt for retry after persistence or event failure.
    console.warn(`[media-result-tracker] delivery failed for ${full}: ${error?.message || error}`);
  }
}

function jsonFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)); } catch { return []; }
}

function sweep(ctx, now = Date.now(), { inbox = "" } = {}) {
  const projects = ctx.projectManager?.projects || [];
  for (const project of projects) {
    for (const full of jsonFiles(path.join(project.path || "", RESULTS_SUBPATH))) sweepRecord(ctx, full, project, now);
  }
  if (inbox) for (const full of jsonFiles(inbox)) sweepRecord(ctx, full, null, now);
}

function startMediaResultTracker(ctx, { intervalMs = 5000, inbox = defaultInbox() } = {}) {
  const timer = setInterval(() => {
    try { sweep(ctx, Date.now(), { inbox }); } catch (error) {
      // Never let the tracker crash the app.
      console.warn(`[media-result-tracker] sweep failed: ${error?.message || error}`);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { startMediaResultTracker, sweep, extractPaths, alreadyShown, sessionForProject, sessionCanReceiveFallback, mediaResultsInbox, GRACE_MS, INBOX_ORPHAN_MS };
