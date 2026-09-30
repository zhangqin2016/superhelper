"use strict";

const path = require("node:path");
const { z } = require("zod");

// The delivery gate, available to the agent while it works — as Codex and
// Claude Code run the tests themselves before they answer. Without it the
// agent learned the bar only after answering: it spot-checked 4 of 7 pages,
// the platform judged the delivery incomplete, and a second round had to run
// (2026-09-30). This is the SAME judgement the turn's final gate makes
// (assessDocumentDelivery), fed from what the platform's scripts recorded
// (delivery-ledgers), so passing here is passing there.
const LEDGER_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_PAGES_LISTED = 24;

function insideWorkspace(root, file) {
  if (!root) return true;
  const rel = path.relative(path.resolve(root), file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function nextSteps(item) {
  const steps = [];
  const missing = new Set(item.missing || []);
  if (missing.has("structure")) steps.push("Fix the generating code and regenerate the file; it does not open cleanly (see structure).");
  if (missing.has("render")) steps.push(`Render it: python3 "$LILY_RUNTIME_SCRIPTS/render_document.py" "${item.path}" <out_dir>.`);
  if (missing.has("visual_inspection")) steps.push("Inspect each page image listed in uninspectedPages with lily-vision (vision.js), then fix what you see and re-render the affected pages.");
  if (missing.has("formula_recalculation")) steps.push(`Recalculate: python3 "$LILY_RUNTIME_SCRIPTS/lily_xlsx_recalc.py" "${item.path}" --out-dir <dir>, then replace the file with the verified copy it writes; fix any formula errors it reports.`);
  return steps;
}

function describe(result) {
  const checks = result.checks || {};
  const uninspected = checks.uninspectedPages || [];
  return {
    path: result.path,
    ok: result.ok,
    missing: result.missing,
    pages: checks.pageCount || 0,
    inspected: checks.visual?.inspected ?? 0,
    ...(uninspected.length && (result.missing || []).includes("visual_inspection") ? { uninspectedPages: uninspected.slice(0, MAX_PAGES_LISTED) } : {}),
    ...(checks.structure && !checks.structure.ok ? { structure: checks.structure } : {}),
    ...(checks.recalculation ? { recalculation: checks.recalculation } : {}),
    ...(result.ok ? {} : { next: nextSteps(result) }),
  };
}

function buildDeliveryCheckToolDefinition({ executionSurface, mcpServerName } = {}) {
  return {
    id: "lily_delivery_check",
    name: "lily_delivery_check",
    group: "documents",
    requiredSkillIds: [],
    executionSurface,
    mcpServerName,
    description: "Check the documents you are about to deliver (docx/xlsx/pptx/pdf/md…) against the platform's delivery gate — the same check your final answer receives. Call it BEFORE your final answer whenever you created or changed documents, fix whatever it reports (render, uninspectedPages, formula recalculation, structure), and call it again until every file is ok. Evidence comes from what render_document.py, lily-vision and lily_xlsx_recalc.py recorded, so filtering their output does not matter.",
    inputSchema: {
      paths: z.array(z.string().min(1)).min(1).max(20).describe("the files you deliver: absolute, or relative to the workspace"),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ paths }, context = {}) => {
      const { assessDocumentDelivery, documentArtifacts } = require("../document-delivery-gate");
      const { deliveryEvidenceSince } = require("../delivery-ledgers");
      const root = String(context?.workspacePath || "");
      const files = [...new Set((paths || []).map((item) => path.resolve(root || process.cwd(), String(item))))];
      const outside = files.filter((file) => !insideWorkspace(root, file));
      const artifacts = files.filter((file) => insideWorkspace(root, file))
        .map((file) => ({ path: file, ext: path.extname(file).toLowerCase(), fileName: path.basename(file), source: "tool_write" }));
      const documents = documentArtifacts(artifacts);
      const notDocuments = artifacts.filter((item) => !documents.includes(item)).map((item) => item.path);
      const evidence = deliveryEvidenceSince(Date.now() - LEDGER_WINDOW_MS, {
        vision: process.env.LILY_VISION_RECEIPTS_DIR || "",
        render: process.env.LILY_RENDER_RECEIPTS_DIR || "",
        recalc: process.env.LILY_RECALC_RECEIPTS_DIR || "",
      });
      const verdict = documents.length
        ? assessDocumentDelivery({ artifacts: documents, tools: [], ...evidence, detail: true })
        : { ok: true, artifacts: [], missing: [] };
      return {
        ok: Boolean(verdict.ok) && !outside.length,
        files: (verdict.artifacts || []).map((item) => describe(item)),
        ...(notDocuments.length ? { notChecked: notDocuments } : {}),
        ...(outside.length ? { outsideWorkspace: outside } : {}),
        message: verdict.ok
          ? "Every document passes the delivery gate. Deliver them as they are now; changing a file afterwards needs a new render and inspection."
          : "Some documents do not pass yet. Do what `next` says for each, then call lily_delivery_check again.",
      };
    },
  };
}

module.exports = { buildDeliveryCheckToolDefinition };
