#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assessDocumentDelivery,
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
  assert.equal(shouldBufferAssistantAnswer(contract), true, "document delivery is buffered until QA is assessed");

  const renderedOnly = assessDocumentDelivery({
    taskContract: contract,
    artifacts: [artifact],
    tools: [renderTool],
  });
  assert.equal(renderedOnly.ok, false);
  assert.deepEqual(renderedOnly.missing, ["visual_inspection"]);
  assert.equal(renderedOnly.retryRecommended, true);

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

  // --- OCR over rendered pages counts as visual inspection ------------------
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
  assert.equal(ocrInspected.ok, true, "OCR of every rendered page satisfies visual inspection");
  assert.equal(ocrInspected.artifacts[0].checks.visual.inspected, 2);

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
  const { buildDocumentDeliveryRecoveryPrompt } = require("../src/main/document-delivery-gate.js");
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

  console.log("document-delivery-gate: ok");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
