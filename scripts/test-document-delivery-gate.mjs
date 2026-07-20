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
  assert(!incompleteFinal.assistant.includes("fully verified"), "an unverified completion claim must not reach the user");

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

  console.log("document-delivery-gate: ok");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
