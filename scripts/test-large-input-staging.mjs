#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { stageLargeInputText, headTailPreview, DEFAULT_THRESHOLD_CHARS } =
  require("../src/main/large-input-staging.js");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lily-input-stage-"));

// --- normal-sized messages pass through UNTOUCHED (never dumber) ------------
{
  const small = "Please summarize the attached report and flag risks.";
  const r = stageLargeInputText({ text: small, cwd });
  assert.equal(r.staged, false, "a normal message is not staged");
  assert.equal(r.text, small, "a normal message is sent verbatim");
  assert.equal(r.file, null, "no file written for a normal message");
  assert.equal(fs.existsSync(path.join(cwd, ".lily-work", "inbox")), false, "no inbox created for small input");
}

// --- a huge data dump is staged to the workspace + replaced by a directive ---
{
  const instruction = "Summarize these support tickets and cluster by root cause:\n\n";
  const bulk = "TICKET ".repeat(20_000); // ~140k chars
  const message = instruction + bulk;
  const r = stageLargeInputText({ text: message, cwd });

  assert.equal(r.staged, true, "an oversized data dump is staged");
  assert.ok(r.text.length < message.length / 5, "the model-facing text is a small fraction of the dump");
  assert.ok(r.text.includes("lily_file_intelligence"), "the directive routes the model to retrieval, not blind read");
  assert.ok(r.text.includes("Source path:"), "the directive names the workspace path");
  assert.ok(r.text.includes("Summarize these support tickets"), "the user's instruction (at the head) survives in the preview");

  // full content is on disk, byte-exact, retrievable
  assert.ok(r.file && fs.existsSync(r.file.path), "the full input is written to a workspace file");
  assert.equal(fs.readFileSync(r.file.path, "utf8"), message, "the staged file holds the COMPLETE original input — nothing lost");
  assert.ok(r.file.path.includes(path.join(".lily-work", "inbox")), "staged under the workspace inbox");
}

// --- content-addressed: identical re-send (a retry) reuses the same file -----
{
  const message = "X".repeat(60_000);
  const a = stageLargeInputText({ text: message, cwd });
  const before = fs.readdirSync(path.join(cwd, ".lily-work", "inbox")).length;
  const b = stageLargeInputText({ text: message, cwd });
  const after = fs.readdirSync(path.join(cwd, ".lily-work", "inbox")).length;
  assert.equal(a.file.path, b.file.path, "identical input maps to the same content-addressed file");
  assert.equal(before, after, "a retry does not create a duplicate staged file");
}

// --- instruction at the TAIL also survives the preview ----------------------
{
  const message = "DATA ".repeat(20_000) + "\n\nNow: extract every email address above.";
  const r = stageLargeInputText({ text: message, cwd });
  assert.ok(r.text.includes("extract every email address"), "a trailing instruction survives via the tail preview");
}

// --- ENFORCEMENT for weak (lite) models: smaller preview + hard recipe ------
{
  const message = "Summarize:\n\n" + "ROW ".repeat(30_000);
  const normal = stageLargeInputText({ text: message, cwd });
  const lite = stageLargeInputText({ text: message, cwd, grade: "lite" });

  // lite gets a MUCH smaller preview so it can't answer from the head — it is
  // forced through retrieval.
  assert.ok(lite.text.length < normal.text.length, "lite gets a smaller model-facing directive than a strong model");
  assert.ok(lite.text.includes("MUST retrieve") && lite.text.includes("do NOT read the whole file"),
    "lite gets a hard, explicit ban on blind-reading the whole file");
  assert.ok(/inspect_file[\s\S]*index[\s\S]*query/.test(lite.text),
    "lite gets a numbered inspect→index→query recipe to follow");
  assert.ok(!normal.text.includes("MUST retrieve"),
    "a strong model keeps the lighter guidance + larger preview (not dumbed down)");
  // the instruction still survives in the small lite preview
  assert.ok(lite.text.includes("Summarize:"), "the user's instruction survives even the small lite preview");
}

// --- headTailPreview keeps head + tail, drops the middle --------------------
{
  const p = headTailPreview("A".repeat(1000) + "MIDDLE" + "Z".repeat(1000), 200);
  assert.ok(p.startsWith("A"), "preview keeps the head");
  assert.ok(p.trimEnd().endsWith("Z"), "preview keeps the tail");
  assert.ok(!p.includes("MIDDLE"), "preview drops the middle");
  assert.ok(/chars omitted/.test(p), "preview discloses the omission");
}

// --- fail-open: no cwd, non-string, and errors never throw / never lose text -
{
  const msg = "Y".repeat(60_000);
  assert.equal(stageLargeInputText({ text: msg, cwd: null }).staged, false, "no cwd → not staged");
  assert.equal(stageLargeInputText({ text: msg, cwd: null }).text, msg, "no cwd → original text preserved");
  assert.equal(stageLargeInputText({ text: 123, cwd }).text, "", "non-string text → empty string, no throw");
  assert.equal(stageLargeInputText({}).staged, false, "empty args → not staged, no throw");
}

// --- kill switch ------------------------------------------------------------
{
  process.env.LILY_LARGE_INPUT_STAGE = "0";
  const msg = "K".repeat(60_000);
  const r = stageLargeInputText({ text: msg, cwd });
  assert.equal(r.staged, false, "kill switch disables staging");
  assert.equal(r.text, msg, "kill switch sends the original text");
  delete process.env.LILY_LARGE_INPUT_STAGE;
}

// --- configurable threshold -------------------------------------------------
{
  assert.equal(DEFAULT_THRESHOLD_CHARS >= 20_000, true, "default threshold is high enough to leave normal messages alone");
  const msg = "Z".repeat(5_000);
  assert.equal(stageLargeInputText({ text: msg, cwd, threshold: 1_000 }).staged, true, "a lower threshold stages smaller input");
}

// wired into the engine send path
const smSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../src/main/runtime/opencode-server-manager.js"), "utf8");
assert.ok(/stageLargeInputText/.test(smSrc) && /promptText/.test(smSrc), "staging must be wired into sendPrompt before buildOpencodePromptBody");
assert.ok(/LILY_MODEL_CAPABILITY_GRADE/.test(smSrc), "sendPrompt must pass the capability grade so weak models get enforced retrieval");

fs.rmSync(cwd, { recursive: true, force: true });
console.log("large-input-staging: ok");
