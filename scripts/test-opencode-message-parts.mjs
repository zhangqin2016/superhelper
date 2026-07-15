#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildOpencodePromptBody, fileToPart } = require("../src/main/runtime/opencode-message-parts.js");

{
  const body = buildOpencodePromptBody({
    agent: "build",
    guidance: "SYSTEM GUIDE",
    text: "user request",
    model: { providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" },
  });
  assert.equal(body.system, "SYSTEM GUIDE", "guidance must use OpenCode's system field");
  assert.deepEqual(body.parts, [{ type: "text", text: "user request" }], "user parts contain only user content");
  assert.deepEqual(body.model, { providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" }, "model ref carried");
}

{
  const body = buildOpencodePromptBody({ guidance: "  ", text: "hello" });
  assert.equal("system" in body, false, "blank guidance is omitted");
  assert.deepEqual(body.parts, [{ type: "text", text: "hello" }], "text-only prompt remains valid");
}

{
  const guidance = `${"A".repeat(2000)}\n\n${"B".repeat(2000)}`;
  const body = buildOpencodePromptBody({
    guidance,
    text: "hello",
    maxSystemPromptChars: 1200,
  });
  assert(body.system.length <= 1200, "model-specific system prompt cap is enforced");
  assert.match(body.system, /System guide truncated by Lily/, "truncated system prompt explains why content was reduced");
  assert(body.system.startsWith("AAAA"), "truncation preserves the beginning of Lily's core guidance");
}

// Section-aware truncation: guardrail protocol sections must SURVIVE a tight
// budget even when they sit at the tail (the old head-cut dropped exactly
// those), and dropped skill sections are named so the model knows the gap.
{
  const { truncateSystemGuidance } = require("../src/main/runtime/opencode-message-parts.js");
  const guide = [
    "# Lily\n\nIdentity and core rules.",
    `## Skill Alpha\n\n${"alpha ".repeat(400)}`,
    `## Skill Beta\n\n${"beta ".repeat(400)}`,
    "## Large Input Protocol\n\nUse lily_file_intelligence inspect_file first; never blind-read huge files.",
    "## Process Job Protocol\n\nUse lily_process_jobs for long-running work; verify with job_status.",
  ].join("\n\n");

  const fits = truncateSystemGuidance(guide, guide.length + 10);
  assert.equal(fits, guide.trim(), "a guide under the limit must pass through byte-identical");

  const cut = truncateSystemGuidance(guide, 1500);
  assert(cut.length <= 1500, "smart truncation still respects the measured limit");
  assert.match(cut, /Large Input Protocol/, "the large-input guardrail must survive tail-position truncation");
  assert.match(cut, /Process Job Protocol/, "the process-job guardrail must survive tail-position truncation");
  assert.match(cut, /Identity and core rules/, "the identity head is always kept");
  assert.match(cut, /Omitted for this model's input limit/, "dropped sections are named for the model");
  assert.match(cut, /Skill Alpha|Skill Beta/, "the omitted list names the dropped skill sections");
  assert.match(cut, /System guide truncated by Lily/, "the truncation notice is preserved");
  assert.doesNotMatch(cut, /(alpha ){50}/, "oversized skill bodies are what actually get dropped");

  const headOnly = truncateSystemGuidance("C".repeat(5000), 1500);
  assert(headOnly.startsWith("CCCC") && headOnly.length <= 1500 + 200,
    "guides without sections keep the legacy head-cut behavior");

  // Intent gating: within the same tight budget, the skill section RELEVANT to
  // this turn's request survives instead of whichever came first.
  const intentGuide = [
    "# Lily\n\nIdentity and core rules.",
    `## Mail Sending Skill\n\nHow to send mail with mail_send.\n${"mail rules ".repeat(150)}`,
    `## 视频生成技能\n\n如何用视频生成工具制作视频。\n${"视频规则 ".repeat(200)}`,
    "## Large Input Protocol\n\nUse lily_file_intelligence inspect_file first.",
  ].join("\n\n");
  const budget = 2600; // fits head + guardrail + ONE skill section

  const videoCut = truncateSystemGuidance(intentGuide, budget, { intentText: "帮我把这段素材做成一个视频" });
  assert.match(videoCut, /视频生成技能/, "the request-relevant skill section survives");
  assert.match(videoCut, /Omitted for this model's input limit:.*Mail Sending Skill/s, "the irrelevant section is dropped and named");
  assert.match(videoCut, /Large Input Protocol/, "guardrails still outrank intent-ranked skill sections");

  const mailCut = truncateSystemGuidance(intentGuide, budget, { intentText: "send the weekly report mail to the team" });
  assert.match(mailCut, /Mail Sending Skill/, "a different request flips which section survives");
  assert.match(mailCut, /Omitted for this model's input limit:.*视频生成技能/s, "the now-irrelevant section is dropped and named");

  const noIntentCut = truncateSystemGuidance(intentGuide, budget, { intentText: "" });
  assert.match(noIntentCut, /Mail Sending Skill/, "without an intent signal the authored order is preserved");

  // The Universal Operating Discipline block (anti-hallucination rules) is a
  // guardrail in all three locales — it must survive a tight budget alongside
  // the protocol sections, not be shed as an ordinary skill section (the bug:
  // losing "evidence first / say unknown" made the model confidently wrong).
  for (const [locale, title, needle] of [
    ["zh", "通用执行纪律（所有创作、分析、修复和子任务都必须遵守）", "证据优先"],
    ["en", "Universal Operating Discipline (Required for all work)", "Evidence first"],
    ["ar", "انضباط التنفيذ العام (مطلوب)", "الأدلة أولاً"],
  ]) {
    const disciplineGuide = [
      "# Lily\n\nIdentity and core rules.",
      `## Skill Gamma\n\n${"gamma ".repeat(500)}`,
      `## ${title}\n\n- ${needle}: never conclude without checking real material.`,
      "## Large Input Protocol\n\nUse lily_file_intelligence inspect_file first.",
    ].join("\n\n");
    const disciplineCut = truncateSystemGuidance(disciplineGuide, 1200);
    assert.match(disciplineCut, new RegExp(needle), `${locale} discipline block survives a tight budget`);
    assert.doesNotMatch(disciplineCut, /(gamma ){40}/, `${locale}: the ordinary skill body is what gets dropped, not discipline`);
  }
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-opencode-parts-"));
  // Text-like files (txt/json/xml/...) are NEVER sent as raw file parts — they
  // inline as fenced TEXT (every model reads text; no provider can reject it).
  // This is the fix for AI_UnsupportedFunctionalityError: an image-only model
  // (deepseek, most custom/BYOK) used to receive an application/json file part
  // and the engine's AI SDK threw before the request ever reached the gateway.
  const small = path.join(dir, "small.txt");
  fs.writeFileSync(small, "hello");
  const txtSkipped = [];
  const txtPart = fileToPart({ path: small, name: "small.txt" }, { maxInlineFileBytes: 16, onSkip: (i) => txtSkipped.push(i) });
  assert.equal(txtPart, null, "text files are not sent as raw model file parts");
  assert.equal(txtSkipped[0]?.reason, "txt_text_attachment", "text file is routed to the inline-text path");

  const jsonPath = path.join(dir, "data.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ places: [{ id: 1 }] }));
  const jsonPart = fileToPart({ path: jsonPath, name: "data.json", mime: "application/json" }, { maxInlineFileBytes: 1024 });
  assert.equal(jsonPart, null, "JSON is never a raw file part by default (would break image-only providers)");

  const jsonBody = buildOpencodePromptBody({
    text: "summarize this data",
    files: [{ path: jsonPath, name: "data.json", mime: "application/json" }],
    maxInlineFileBytes: 1024,
  });
  assert.equal(jsonBody.parts.filter((p) => p.type === "file").length, 0, "JSON attachment produces no file part");
  assert.match(jsonBody.parts.at(-1).text, /\[Attached JSON: data\.json\]/, "JSON content is inlined as labeled text");
  assert.match(jsonBody.parts.at(-1).text, /```json/, "JSON inline text is fenced as json");
  assert.match(jsonBody.parts.at(-1).text, /"places"/, "JSON content survives inline — nothing is lost");

  // Oversized JSON exceeds the inline text limit → falls back to a source-path
  // note, still NEVER a file part (so it can't poison an image-only model).
  const bigJson = path.join(dir, "big.json");
  fs.writeFileSync(bigJson, JSON.stringify({ blob: "x".repeat(5000) }));
  const bigJsonBody = buildOpencodePromptBody({
    text: "load it",
    files: [{ path: bigJson, name: "big.json", mime: "application/json" }],
    maxInlineFileBytes: 64,
    maxTextAttachmentChars: 64,
  });
  assert.equal(bigJsonBody.parts.filter((p) => p.type === "file").length, 0, "oversized JSON still never becomes a file part");
  assert.match(bigJsonBody.parts.at(-1).text, /big\.json/, "oversized JSON is named in the fallback note");

  // Default DENY for a pre-staged (uri) non-image attachment: no capability
  // declared → not forwarded as a raw file part.
  const uriDefault = fileToPart(
    { uri: "data:application/json;base64,e30=", mime: "application/json", name: "d.json" },
    {},
  );
  assert.equal(uriDefault, null, "a uri attachment is not a file part unless the model declares support");

  // Capability OPT-IN: a model that DECLARES it accepts a mime as a file part
  // (capabilities.filePartMimes → allowedFilePartMimes) may send it — keeps
  // strong models capable without endangering unknown/custom ones.
  const optInPart = fileToPart(
    { uri: "data:application/json;base64,e30=", mime: "application/json", name: "d.json" },
    { allowedFilePartMimes: ["application/json"] },
  );
  assert.equal(optInPart?.type, "file", "a declared-supported mime opts back into file parts");
  assert.equal(optInPart.mime, "application/json", "opt-in file part keeps its mime");

  const png = path.join(dir, "image.png");
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const pngSkipped = [];
  const pngPart = fileToPart(
    { path: png, name: "image.png", type: "image/png" },
    { maxInlineFileBytes: 1024, onSkip: (item) => pngSkipped.push(item) },
  );
  assert.equal(pngPart, null, "raster images are not uploaded as raw model file parts by default");
  assert.match(pngSkipped[0]?.reason || "", /image handled through Lily vision extraction/, "image skip reason points to the vision extraction path");
  const nativePngPart = fileToPart(
    { path: png, name: "image.png", type: "image/png" },
    { maxInlineFileBytes: 1024, allowImageFileParts: true },
  );
  assert.equal(nativePngPart?.type, "file", "native-vision sends may explicitly allow image file parts");
  assert.match(nativePngPart.url, /^data:image\/png;base64,/, "allowed raster images keep their image MIME");

  const pngBody = buildOpencodePromptBody({
    text: "change the background to white",
    files: [{ path: png, name: "image.png", sourcePath: "/wechat/cache/image.png", isImage: true }],
    maxInlineFileBytes: 1024,
  });
  assert.equal(pngBody.parts.filter((part) => part.type === "file").length, 0, "non-native image prompts stay text-only after vision preflight");
  assert.match(pngBody.parts.at(-1).text, /Attachment note/, "image prompt explains why raw bytes were not uploaded");
  assert.match(pngBody.parts.at(-1).text, /image handled through Lily vision extraction/, "image prompt points to the extracted vision path");
  assert.match(pngBody.parts.at(-1).text, /Attachment index/, "image prompt includes a local attachment index");
  assert.match(pngBody.parts.at(-1).text, new RegExp(png.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "image prompt preserves staged source path");
  assert.match(pngBody.parts.at(-1).text, /original path: \/wechat\/cache\/image\.png/, "image prompt preserves original clipboard path when available");
  const nativePngBody = buildOpencodePromptBody({
    text: "inspect pixels",
    files: [{ path: png, name: "image.png", isImage: true }],
    maxInlineFileBytes: 1024,
    allowImageFileParts: true,
  });
  assert.equal(nativePngBody.parts.filter((part) => part.type === "file").length, 1, "native-vision image prompts may upload an image file part");

  const binary = path.join(dir, "payload.bin");
  fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  const binarySkipped = [];
  const binaryPart = fileToPart(
    { path: binary, name: "payload.bin" },
    { maxInlineFileBytes: 1024, onSkip: (item) => binarySkipped.push(item) },
  );
  assert.equal(binaryPart, null, "unknown binary files are path-first instead of raw model uploads");
  assert.match(binarySkipped[0]?.reason || "", /not an explicitly safe inline type/, "unknown binary skip reason is explicit");

  const zip = path.join(dir, "archive.zip");
  fs.writeFileSync(zip, Buffer.from([0x50, 0x4b, 3, 4]));
  const zipPart = fileToPart({ path: zip, name: "archive.zip" }, { maxInlineFileBytes: 1024 });
  assert.equal(zipPart, null, "archives are path-first even when small");

  const unknownTemp = path.join(dir, "clipboard-unknown");
  fs.writeFileSync(unknownTemp, Buffer.from([4, 5, 6]));
  const unknownTempPart = fileToPart(
    { path: unknownTemp, name: "clipboard-unknown", mime: "application/octet-stream" },
    { maxInlineFileBytes: 1024 },
  );
  assert.equal(unknownTempPart, null, "extensionless clipboard binaries are path-first");

  const unsafeUriSkipped = [];
  const unsafeUriPart = fileToPart(
    { uri: "data:application/octet-stream;base64,AAECAw==", mime: "application/octet-stream", name: "payload.bin" },
    { onSkip: (item) => unsafeUriSkipped.push(item) },
  );
  assert.equal(unsafeUriPart, null, "unsafe URI attachments are not forwarded as raw model file parts");
  assert.equal(unsafeUriSkipped[0]?.filename, "payload.bin", "unsafe URI skip keeps the filename");

  const svg = path.join(dir, "chart.svg");
  fs.writeFileSync(svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
  const svgSkipped = [];
  const svgPart = fileToPart(
    { path: svg, name: "chart.svg" },
    { maxInlineFileBytes: 1024, onSkip: (item) => svgSkipped.push(item) },
  );
  assert.equal(svgPart, null, "SVG files are not sent as model file parts");
  assert.equal(svgSkipped[0]?.reason, "svg_text_attachment", "SVG skip reason is explicit");

  const svgBody = buildOpencodePromptBody({
    text: "analyze svg",
    files: [{ path: svg, name: "chart.svg" }],
    maxInlineFileBytes: 1024,
  });
  assert.equal(svgBody.parts.length, 1, "SVG is folded into the text prompt, not sent as a file part");
  assert.match(svgBody.parts[0].text, /\[Attached SVG: chart\.svg\]/, "SVG text attachment is labeled");
  assert.match(svgBody.parts[0].text, /<svg xmlns=/, "SVG source is included for analysis");
  assert.doesNotMatch(svgBody.parts[0].text, new RegExp("data:image/svg\\\\+xml"), "SVG is not converted to a data URL");

  const docx = path.join(dir, "sample.docx");
  fs.writeFileSync(docx, "fake-docx");
  const docxSkipped = [];
  const docxPart = fileToPart(
    { path: docx, name: "sample.docx" },
    { maxInlineFileBytes: 1024, onSkip: (item) => docxSkipped.push(item) },
  );
  assert.equal(docxPart, null, "Office documents are not uploaded as raw model file parts");
  assert.match(docxSkipped[0]?.reason || "", /document extraction\/source path/, "Office skip reason points the CLI at local document handling");

  const docxBody = buildOpencodePromptBody({
    text: "read this office document",
    files: [{ path: docx, name: "sample.docx" }],
    maxInlineFileBytes: 1024,
  });
  assert.equal(docxBody.parts.length, 1, "Office fallback keeps prompt text-only");
  assert.match(docxBody.parts[0].text, /Attachment note/, "Office fallback explains why the raw file was skipped");
  assert.match(docxBody.parts[0].text, /sample\.docx/, "Office fallback preserves filename");
  assert.match(docxBody.parts[0].text, new RegExp(docx.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Office fallback preserves source path");

  const stagedNoExt = path.join(dir, "clipboard-staged-file");
  fs.writeFileSync(stagedNoExt, "fake-docx");
  const stagedByName = fileToPart(
    { path: stagedNoExt, name: "clipboard-report.docx", type: "docx" },
    { maxInlineFileBytes: 1024 },
  );
  assert.equal(stagedByName, null, "clipboard-staged documents are detected by original filename/type even when the temp path has no extension");

  const stagedByMime = fileToPart(
    { path: stagedNoExt, name: "clipboard-file", mime: "application/pdf" },
    { maxInlineFileBytes: 1024 },
  );
  assert.equal(stagedByMime, null, "clipboard-staged documents are detected by MIME even when the temp path has no extension");

  const large = path.join(dir, "large.pdf");
  fs.writeFileSync(large, Buffer.alloc(32, 7));
  const skipped = [];
  const skippedPart = fileToPart(
    { path: large, name: "large.pdf" },
    { maxInlineFileBytes: 16, onSkip: (item) => skipped.push(item) },
  );
  assert.equal(skippedPart, null, "large local files are not inlined");
  assert.equal(skipped.length, 1, "document skip is reported");
  assert.equal(skipped[0].filename, "large.pdf", "skip report carries filename");

  const body = buildOpencodePromptBody({
    text: "read this",
    files: [{ path: large, name: "large.pdf" }],
    maxInlineFileBytes: 16,
  });
  assert.equal(body.parts.length, 1, "skipped file does not create a file part");
  assert.match(body.parts[0].text, /Attachment note/, "skipped file is explained to the model");
  assert.match(body.parts[0].text, /large\.pdf/, "skipped file name is included in the note");
  assert.match(body.parts[0].text, new RegExp(large.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "skipped file source path is included in the note");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("opencode-message-parts: ok");
