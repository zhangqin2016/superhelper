#!/usr/bin/env node
/**
 * Post-edit verification loop: the hook script must catch real syntax breakage
 * (exit 2 + a message the model can act on), FAIL OPEN on anything it cannot
 * check confidently, and the settings installer must merge idempotently
 * without touching user-configured hooks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookScript = path.join(root, "resources/hooks/verify-edit.cjs");
const { ensureVerificationHooks } = require("../src/main/verification-hooks.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-hook-test-"));

function runHook(payload) {
  return spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 30_000,
  });
}

try {
  // Broken JS edited by the model → exit 2 with the file named in stderr.
  const badJs = path.join(tmp, "broken.js");
  fs.writeFileSync(badJs, "function oops( {\n");
  const badResult = runHook({ tool_name: "Edit", tool_input: { file_path: badJs } });
  if (badResult.status !== 2 || !badResult.stderr.includes("broken.js")) {
    throw new Error(`broken JS must fail with the file named: status=${badResult.status} stderr=${badResult.stderr}`);
  }

  // Valid JS → silent pass.
  const goodJs = path.join(tmp, "good.js");
  fs.writeFileSync(goodJs, "module.exports = 1;\n");
  if (runHook({ tool_name: "Write", tool_input: { file_path: goodJs } }).status !== 0) {
    throw new Error("valid JS must pass");
  }

  // Broken JSON → exit 2.
  const badJson = path.join(tmp, "broken.json");
  fs.writeFileSync(badJson, "{ nope ");
  if (runHook({ tool_name: "Write", tool_input: { file_path: badJson } }).status !== 2) {
    throw new Error("broken JSON must fail");
  }

  // Fail-open cases: unknown extension, missing file, non-edit tool, junk stdin.
  const txt = path.join(tmp, "notes.txt");
  fs.writeFileSync(txt, "anything");
  for (const [label, payload] of [
    ["unknown extension", { tool_name: "Edit", tool_input: { file_path: txt } }],
    ["missing file", { tool_name: "Edit", tool_input: { file_path: path.join(tmp, "ghost.js") } }],
    ["non-edit tool", { tool_name: "Bash", tool_input: { file_path: badJs } }],
  ]) {
    if (runHook(payload).status !== 0) throw new Error(`${label} must fail open`);
  }
  const junk = spawnSync(process.execPath, [hookScript], { input: "not json", encoding: "utf8", timeout: 30_000 });
  if (junk.status !== 0) throw new Error("junk stdin must fail open");

  // Non-code outputs: a "docx" that is not a real ZIP container is broken for
  // the user even though the Write call succeeded.
  const fakeDocx = path.join(tmp, "report.docx");
  fs.writeFileSync(fakeDocx, "plain text pretending to be a document");
  const docxResult = runHook({ tool_name: "Write", tool_input: { file_path: fakeDocx } });
  if (docxResult.status !== 2 || !docxResult.stderr.includes("report.docx")) {
    throw new Error(`fake docx must fail structure check: ${docxResult.status} ${docxResult.stderr}`);
  }
  const realZipDocx = path.join(tmp, "ok.docx");
  fs.writeFileSync(realZipDocx, Buffer.concat([Buffer.from("PK\x03\x04", "binary"), Buffer.alloc(64)]));
  if (runHook({ tool_name: "Write", tool_input: { file_path: realZipDocx } }).status !== 0) {
    throw new Error("zip-magic docx must pass");
  }
  const emptyPng = path.join(tmp, "empty.png");
  fs.writeFileSync(emptyPng, "");
  if (runHook({ tool_name: "Write", tool_input: { file_path: emptyPng } }).status !== 2) {
    throw new Error("empty generated file must fail");
  }

  // generated_media fulfillment: a skill claiming it produced an image must
  // have produced a real one.
  const realPng = path.join(tmp, "real.png");
  fs.writeFileSync(realPng, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32)]));
  const mediaOk = runHook({
    tool_name: "Bash",
    tool_response: { content: `<generated_media type="image">\n<file path="${realPng}" />\n</generated_media>` },
  });
  if (mediaOk.status !== 0) throw new Error(`valid generated_media must pass: ${mediaOk.stderr}`);
  const mediaMissing = runHook({
    tool_name: "Bash",
    tool_response: { content: `<generated_media type="image">\n<file path="${path.join(tmp, "ghost.png")}" />\n</generated_media>` },
  });
  if (mediaMissing.status !== 2 || !mediaMissing.stderr.includes("does not exist")) {
    throw new Error("missing generated_media file must fail with an actionable message");
  }
  const notAnImage = path.join(tmp, "fake-image.png");
  fs.writeFileSync(notAnImage, "actually text");
  const mediaWrong = runHook({
    tool_name: "Bash",
    tool_response: { content: `<generated_media type="image">\n<file path="${notAnImage}" />\n</generated_media>` },
  });
  if (mediaWrong.status !== 2 || !mediaWrong.stderr.includes("not a valid image")) {
    throw new Error("wrong-format generated_media must fail");
  }
  // Bash output without generated_media is none of our business.
  if (runHook({ tool_name: "Bash", tool_response: { content: "npm test passed" } }).status !== 0) {
    throw new Error("plain Bash output must fail open");
  }

  // Settings merge: installs once, idempotent on repeat, preserves user hooks,
  // and updates in place when the script path moves (app update).
  const settingsPath = path.join(tmp, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: { KEEP: "me" },
    hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }] },
  }));
  const opts = { settingsPath, nodePath: "/usr/bin/node", scriptPath: hookScript };
  if (!ensureVerificationHooks(opts)) throw new Error("first install must write");
  if (ensureVerificationHooks(opts)) throw new Error("second install must be a no-op");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (settings.env.KEEP !== "me") throw new Error("unrelated settings must be preserved");
  if (settings.hooks.PostToolUse.length !== 2) throw new Error("user hook must be preserved alongside ours");
  if (!JSON.stringify(settings.hooks.PostToolUse[1]).includes("verify-edit.cjs")) {
    throw new Error("managed hook entry missing");
  }
  if (!ensureVerificationHooks({ ...opts, nodePath: "/new/node" })) {
    throw new Error("changed node path must update the managed entry");
  }
  const updated = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (updated.hooks.PostToolUse.length !== 2 || !updated.hooks.PostToolUse[1].hooks[0].command.includes("/new/node")) {
    throw new Error("managed entry must update in place, not duplicate");
  }

  console.log("verification-hooks: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
