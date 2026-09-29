#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assessDocumentDelivery,
  buildDocumentDeliveryRecoveryPrompt,
  safeDocumentDeliveryFallback,
  visualCoverage,
} = require("../src/main/document-delivery-gate.js");
const { evaluateAnswerEvidence, shouldBufferAssistantAnswer } = require("../src/main/answer-evidence-finalizer.js");
const { documentDeliveryTurnIntelligence } = require("../src/main/document-delivery-turn.js");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lily-document-delivery-"));
const pdfPath = path.join(workspace, "quarterly-report.pdf");
const page1 = path.join(workspace, "quarterly-report", "page-1.png");
const page2 = path.join(workspace, "quarterly-report", "page-2.png");
fs.writeFileSync(pdfPath, "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

const contract = {
  taskType: "document_work",
  semanticIntent: { operation: "create", outputMode: "artifact" },
  evidencePolicy: { required: true, requiredEvidenceKinds: ["document_output"] },
};
const artifact = { path: pdfPath, ext: ".pdf", fileName: path.basename(pdfPath) };
const renderTool = {
  name: "Bash",
  status: "done",
  input: { command: `python render_document.py "${pdfPath}"` },
  result: { pages: 2, output: [page1, page2] },
};

try {
  const textPath = path.join(workspace, "report.md");
  fs.writeFileSync(textPath, "# Report\n\nTotal: 520000\n");
  const textArtifact = { path: textPath, ext: ".md", source: "file_change" };
  const textDelivery = assessDocumentDelivery({ taskContract: contract, artifacts: [textArtifact] });
  // The gate checks readable UTF-8 text itself; it no longer reports a check
  // that nothing could ever satisfy (every Markdown delivery ended "not fully checked").
  assert.deepEqual(textDelivery.missing, [], "readable UTF-8 text is verified by the gate");
  assert.equal(textDelivery.ok, true);
  assert.equal(textDelivery.retryRecommended, false, "text output must not enter Office render recovery");
  const brokenText = path.join(workspace, "broken.md");
  fs.writeFileSync(brokenText, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  assert.deepEqual(assessDocumentDelivery({ taskContract: contract, artifacts: [{ path: brokenText, ext: ".md" }] }).missing, ["structure"],
    "text that is not valid UTF-8 fails structure");
  const textAnswer = evaluateAnswerEvidence({ assistant: "Created report.md with total 520000.", taskContract: contract,
    artifacts: [textArtifact], tools: [], evidenceSummary: { counts: {} }, userText: "Create report.md" });
  assert(textAnswer.assistant.includes("Created report.md"), "text artifact delivery preserves the real answer");
  assert(!textAnswer.assistant.includes("No generated Office"));
  const mixed = assessDocumentDelivery({ taskContract: contract, artifacts: [textArtifact, artifact] });
  assert(mixed.missing.includes("render"), "a Markdown sidecar cannot bypass PDF verification");
  assert.equal(mixed.retryRecommended, true);

  assert.equal(shouldBufferAssistantAnswer(contract), true, "document delivery is buffered until QA is assessed");

  const renderedOnly = assessDocumentDelivery({
    taskContract: contract,
    artifacts: [artifact],
    tools: [renderTool],
  });
  assert.equal(renderedOnly.ok, false);
  assert.deepEqual(renderedOnly.missing, ["visual_inspection"]);
  assert.equal(renderedOnly.retryRecommended, true);

  const receipt = (image, ok = true) => ({ name: "bash", status: "done", input: { command: "node $vision $image" },
    result: "actual description\nLILY_VISION_RECEIPT " + JSON.stringify({ version: 1, kind: "image_inspection", ok, path: image }) });
  const withReceipts = (tools) => assessDocumentDelivery({ taskContract: contract, artifacts: [artifact], tools });
  assert.equal(withReceipts([renderTool, receipt(page1), receipt(page2)]).ok, true);
  assert.equal(withReceipts([renderTool, receipt(page1)]).ok, false, "receipt does not bypass all-page coverage");
  assert.equal(withReceipts([receipt(page1), receipt(page2), renderTool]).ok, false, "stale inspections do not count");
  assert.equal(withReceipts([renderTool, receipt(page1), receipt(page2, false)]).ok, false);
  assert.equal(withReceipts([renderTool, receipt(page1), { ...receipt(page2), status: "error" }]).ok, false);
  assert.equal(withReceipts([renderTool, receipt(path.join(workspace, "unrelated.png"))]).ok, false);

  const failedRender = assessDocumentDelivery({
    taskContract: contract,
    artifacts: [artifact],
    tools: [
      { ...renderTool, result: { ok: false, error: "LIBREOFFICE_FAILED", output: [page1] } },
      { name: "view_image", status: "done", input: { path: page1 }, result: { ok: true } },
    ],
  });
  assert(failedRender.missing.includes("render"), "a failed renderer cannot be upgraded by inspecting an unrelated image");

  const incompleteFinal = evaluateAnswerEvidence({
    assistant: "The report is complete and fully verified.",
    taskContract: contract,
    evidenceSummary: { counts: {} },
    tools: [renderTool],
    artifacts: [artifact],
    userText: "Create a polished quarterly report PDF",
  });
  assert.equal(incompleteFinal.assessment.ok, false);
  assert.equal(incompleteFinal.triggerDocumentVerifyRetry, true);
  // Fail-open delivery: the original answer reaches the user with one
  // plain-language note about the incomplete automatic checks — the gate
  // never rewrites or withholds a good-faith answer (2026-07-20 model-first).
  assert(incompleteFinal.assistant.includes("fully verified"), "the original answer is delivered, never rewritten");
  assert.match(incompleteFinal.assistant, /Note: the file was created, but automatic checks are incomplete/);
  assert.equal(incompleteFinal.assessment.deliveredUnverifiedWithNote, true);

  const inspectedTools = [
    renderTool,
    { name: "view_image", status: "done", input: { path: page1 }, result: { ok: true } },
    { name: "view_image", status: "done", input: { path: page2 }, result: { ok: true } },
  ];
  const verified = assessDocumentDelivery({ taskContract: contract, artifacts: [artifact], tools: inspectedTools });
  assert.equal(verified.ok, true);
  assert.equal(verified.status, "verified");
  assert.equal(verified.artifacts[0].checks.visual.inspected, 2);

  const verifiedFinal = evaluateAnswerEvidence({
    assistant: `Created and verified ${pdfPath}`,
    taskContract: contract,
    evidenceSummary: { counts: {} },
    tools: inspectedTools,
    artifacts: [artifact],
    userText: "Create a polished quarterly report PDF",
  });
  assert.equal(verifiedFinal.assessment.ok, true);
  assert.equal(verifiedFinal.evidenceSummary.hasDocumentOutputEvidence, true);
  assert.equal(verifiedFinal.evidenceSummary.counts.documentOutputs, 1);

  const missingOutput = assessDocumentDelivery({ taskContract: contract, artifacts: [], tools: [] });
  assert.equal(missingOutput.retryRecommended, false, "verification continuation cannot recover a file that was never created");
  assert.match(safeDocumentDeliveryFallback({ assessment: missingOutput }), /No generated Office or PDF output file/);

  const longPages = Array.from({ length: 20 }, (_, index) => `C:/render/page-${index + 1}.png`);
  assert.equal(
    visualCoverage(longPages, [longPages[0], ...longPages.slice(4, 9), longPages.at(-1)], 20).ok,
    true,
    "long documents require first, last, and at least six inspected pages",
  );
  assert.equal(visualCoverage(longPages, longPages.slice(0, 6), 20).ok, false, "missing the last page fails coverage");
  assert.equal(
    visualCoverage(["C:/render/a/page-1.png"], ["C:/render/b/page-1.png"], 1).ok,
    false,
    "same-named pages from another artifact cannot satisfy visual coverage",
  );

  const extractionClassification = {
    taskContract: {
      active: true,
      taskType: "content_extraction",
      evidencePolicy: { required: true, requiredEvidenceKinds: ["source_content"] },
      semanticIntent: { operation: "extract", outputMode: "answer" },
    },
    turnPolicy: { taskType: "content_extraction", rigor: "grounded" },
  };
  assert.equal(documentDeliveryTurnIntelligence(extractionClassification, false), extractionClassification);
  const recoveryClassification = documentDeliveryTurnIntelligence(extractionClassification, true);
  assert.equal(recoveryClassification.taskContract.taskType, "document_work");
  assert.equal(recoveryClassification.taskContract.semanticIntent.outputMode, "artifact");
  assert.deepEqual(recoveryClassification.taskContract.evidencePolicy.requiredEvidenceKinds, ["document_output"]);
  assert.equal(recoveryClassification.turnPolicy.taskType, "document_work");

  // --- OCR over rendered pages is text coverage, not visual inspection -------
  const ocrTools = [
    renderTool,
    {
      name: "Bash",
      status: "done",
      input: { command: `python ocr_pages.py "${page1}" "${page2}"  # rapidocr_onnxruntime` },
      result: { ok: true, output: `recognized text of ${page1}\nrecognized text of ${page2}` },
    },
  ];
  const ocrInspected = assessDocumentDelivery({ taskContract: contract, artifacts: [artifact], tools: ocrTools });
  assert.equal(ocrInspected.ok, false, "OCR of every rendered page must not satisfy visual inspection");
  assert.deepEqual(ocrInspected.missing, ["visual_inspection"]);
  assert.equal(ocrInspected.artifacts[0].checks.visual.inspected, 0);

  const ocrUnrelated = assessDocumentDelivery({
    taskContract: contract,
    artifacts: [artifact],
    tools: [
      renderTool,
      { name: "Bash", status: "done", input: { command: "python ocr.py /tmp/other.png  # tesseract" }, result: { ok: true } },
    ],
  });
  assert.equal(ocrUnrelated.ok, false, "OCR of unrelated images does not count");
  assert.deepEqual(ocrUnrelated.missing, ["visual_inspection"]);

  const zhRecoveryPrompt = buildDocumentDeliveryRecoveryPrompt({ artifacts: [artifact] }, "把 Word 重新转换成 PDF，不要修改源文件");
  assert(zhRecoveryPrompt.includes("先调用 lily_capability_status"), "recovery prompt should make capability discovery the first repair step");
  assert(zhRecoveryPrompt.includes("runtime_pack_install"), "recovery prompt should route dependency repair through managed tools");
  assert(zhRecoveryPrompt.includes("repair: true"), "recovery prompt should force repair unhealthy installed packs");
  assert(zhRecoveryPrompt.includes("不要传 wait: true"), "recovery prompt should prevent MCP timeout-prone synchronous installs");
  assert(zhRecoveryPrompt.includes("runtime_pack_list 观察进度"), "recovery prompt should observe background install progress");
  assert(zhRecoveryPrompt.includes("优先使用平台已有的图像读取/视觉通道"), "recovery prompt should prefer available visual capability before giving up");
  assert(zhRecoveryPrompt.includes("OCR 只能作为文字覆盖检查"), "recovery prompt must not present OCR as visual QA");
  assert(zhRecoveryPrompt.includes("全部失败后"), "recovery prompt should fail loud only after managed repair routes fail");
  assert(!/OCR（如 RapidOCR）逐页识别渲染图文字/.test(zhRecoveryPrompt), "old OCR-as-visual route must not return");

  // --- recalc requirement is artifact-driven, not prompt-keyword-driven -----
  const JSZip = require("jszip");
  async function buildXlsx(file, sheetXml) {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>");
    zip.file("xl/worksheets/sheet1.xml", sheetXml);
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  }
  const plainXlsx = path.join(workspace, "plain.xlsx");
  await buildXlsx(plainXlsx, "<?xml version=\"1.0\"?><worksheet><sheetData><row><c><v>42</v></c></row></sheetData></worksheet>");
  const formulaXlsx = path.join(workspace, "formula.xlsx");
  await buildXlsx(formulaXlsx, "<?xml version=\"1.0\"?><worksheet><sheetData><row><c><f>SUM(A1:A2)</f><v>3</v></c></row></sheetData></worksheet>");

  const { xlsxContainsFormulas } = require("../src/main/document-delivery-gate.js");
  assert.equal(xlsxContainsFormulas(plainXlsx), false);
  assert.equal(xlsxContainsFormulas(formulaXlsx), true);

  const plainArtifact = { path: plainXlsx, ext: ".xlsx", fileName: "plain.xlsx" };
  const formulaArtifact = { path: formulaXlsx, ext: ".xlsx", fileName: "formula.xlsx" };
  const xlsxRender = (target) => ({
    name: "Bash",
    status: "done",
    input: { command: `python render_document.py "${target.path}"` },
    result: { pages: 1, output: [page1] },
  });
  const viewPage = { name: "view_image", status: "done", input: { path: page1 }, result: { ok: true } };

  // The internal recovery prompt mentions formulas/recalc — it must NOT create
  // a recalc requirement for a formula-free workbook (the 报销 case).
  const internalPrompt = buildDocumentDeliveryRecoveryPrompt({ artifacts: [plainArtifact] }, "重新生成excel 格式缺失");
  const plainResult = assessDocumentDelivery({
    taskContract: contract,
    artifacts: [plainArtifact],
    tools: [xlsxRender(plainArtifact), viewPage],
    userText: internalPrompt,
  });
  assert.equal(plainResult.ok, true, "formula-free xlsx never requires recalc, even from internal prompt text");

  // A workbook WITH formulas requires recalc evidence — regardless of keywords.
  const formulaUnrecalced = assessDocumentDelivery({
    taskContract: contract,
    artifacts: [formulaArtifact],
    tools: [xlsxRender(formulaArtifact), viewPage],
    userText: "merge these receipts into one sheet",
  });
  assert.deepEqual(formulaUnrecalced.missing, ["formula_recalculation"]);
  const formulaRecalced = assessDocumentDelivery({
    taskContract: contract,
    artifacts: [formulaArtifact],
    tools: [
      xlsxRender(formulaArtifact),
      viewPage,
      { name: "Bash", status: "done", input: { command: `python recalc.py "${formulaXlsx}"` }, result: { ok: true } },
    ],
  });
  assert.equal(formulaRecalced.ok, true, "recalc.py over the artifact satisfies the requirement");

  // --- fallback speaks the user's language, not internal identifiers --------
  const zhFallback = safeDocumentDeliveryFallback({
    assessment: { artifacts: [plainArtifact], missing: ["visual_inspection", "formula_recalculation"] },
    userText: "重新生成excel 格式缺失",
  });
  assert(zhFallback.includes("视觉检查、公式重算"), "zh fallback uses plain labels");
  assert(!zhFallback.includes("visual_inspection"), "no internal identifiers leak to users");

  const generalOutput = assessDocumentDelivery({
    taskContract: { taskType: "general" },
    artifacts: [{ ...plainArtifact, source: "tool_output" }],
    tools: [],
  });
  assert.equal(generalOutput.required, true, "real outputs trigger QA even for short general follow-ups");
  assert.equal(generalOutput.status, "unverified");
  for (const artifact of [plainArtifact, { ...plainArtifact, source: "assistant_text" },
    { ...plainArtifact, source: "tool_output", display: "compact" }]) {
    assert.equal(assessDocumentDelivery({ taskContract: { taskType: "general" }, artifacts: [artifact] }).required,
      false, "references and scratch files do not turn ordinary questions into document tasks");
  }
  // Field regression 2026-09-29: a script wrapped render_document.py and
  // printed only "xlsx pages 18"; eleven platform vision receipts then matched
  // no page image, so the gate reported render/visual missing and every
  // finished task started a "文档交付续检". The render receipt that
  // render_document.py leaves beside its pages is the evidence now.
  {
    const { RECEIPT_NAME } = require("../src/main/document-render-receipt.js");
    const book = path.join(workspace, "02_经营分析模型.xlsx");
    fs.writeFileSync(book, Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.from("[Content_Types].xml")]));
    const pagesDir = path.join(workspace, "verify6", "render_xlsx");
    fs.mkdirSync(pagesDir, { recursive: true });
    const pages = Array.from({ length: 18 }, (_, i) => path.join(pagesDir, `page-${i + 1}.png`));
    for (const page of pages) fs.writeFileSync(page, "png");
    const writeReceipt = (source) => {
      const stat = fs.statSync(book);
      fs.writeFileSync(path.join(pagesDir, RECEIPT_NAME), JSON.stringify({ version: 1, kind: "document_render", source,
        sourceMtimeMs: Math.floor(stat.mtimeMs), sourceBytes: stat.size, images: pages, pages: pages.length, renderedAtMs: Date.now() }));
    };
    const bookArtifact = { path: book, ext: ".xlsx", fileName: path.basename(book) };
    const wrappedRender = { name: "bash", status: "done", input: { command: `python3 "$RD" ${book} render_xlsx 1.5 | python3 -c "print('xlsx pages', 18)"` }, result: { content: "xlsx pages 18 None" } };
    const vision = (indexes) => indexes.map((i) => ({ name: "bash", status: "done", input: { command: "node vision.js" },
      result: `===xlsx p${i}=== ok\nLILY_VISION_RECEIPT ${JSON.stringify({ version: 1, kind: "image_inspection", ok: true, path: pages[i - 1] })}` }));
    const sampled = vision([1, 3, 5, 8, 11, 14, 17, 18]);
    const verdict = (tools) => assessDocumentDelivery({ taskContract: contract, artifacts: [bookArtifact], tools });

    const before = verdict([wrappedRender, ...sampled]);
    assert.ok(before.missing.includes("render") || before.missing.includes("visual_inspection"), "without a receipt the wrapped render is unproven");

    writeReceipt(book);
    const after = verdict([wrappedRender, ...sampled]);
    assert.ok(!after.missing.includes("render") && !after.missing.includes("visual_inspection"),
      `the render receipt proves the render and the vision receipts cover it: ${JSON.stringify(after.missing)}`);
    assert.equal(after.artifacts[0].checks.pageCount, 18);
    assert.equal(after.artifacts[0].checks.visual.inspected, 8);

    assert.ok(verdict([wrappedRender, ...vision([1, 2, 3])]).missing.includes("visual_inspection"),
      "three of eighteen pages is not visual coverage");
    writeReceipt(book.normalize("NFD"));
    assert.ok(!verdict([wrappedRender, ...sampled]).missing.includes("render"), "a decomposed (NFD) path names the same file");

    fs.appendFileSync(book, "edited after rendering");
    assert.ok(verdict([...sampled]).missing.includes("render"), "a receipt older than the file's last edit proves nothing");
  }

  console.log("document-delivery-gate: ok");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
