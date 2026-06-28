#!/usr/bin/env node
"use strict";

/**
 * Extraction pipeline: scanned 住院病案 (PDF/images) → structured EMR case.
 *
 * CRITICAL ORDERING (privacy): the scan itself contains PHI, so we cannot
 * de-identify BEFORE extraction — the raw scan IS the model input. Therefore the
 * model output is de-identified IMMEDIATELY, in one place (`finalizeCase`), before
 * anything is written to disk or sent to any downstream model. For the "PHI 不出门"
 * deployment, the extraction vision model must itself be local/in-house.
 *
 * Degrades safely (Rule 13): no vision model → MODEL_UNAVAILABLE; no PDF renderer
 * and no pre-rendered images → PDF_RENDER_UNAVAILABLE; model returns non-JSON →
 * EXTRACT_FAILED. It never fabricates a case, and never writes un-de-identified data.
 *
 * `finalizeCase` (validate → de-identify → render) is pure and unit-tested by
 * scripts/test-clinical-case-extract.mjs. The model + PDF rendering shell needs a
 * live vision model to verify end-to-end.
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { spawnSync } = require("node:child_process");

const { validateCase } = require("./emr_schema.cjs");
const { deidentifyCase } = require("./deidentify.cjs");
const { renderCaseMarkdown } = require("./render_case.cjs");
const { verifyExtraction } = require("./verify_extraction.cjs");

const EXTRACTION_PROMPT = [
  "你是病案结构化助手。阅读这些住院病案扫描页，抽取为 JSON，严格只输出 JSON，不要解释。",
  "字段：",
  '{ "schemaVersion":1, "caseId":<病案号/住院号字符串>, "idNumber":<身份证号原文/可空>,',
  '  "patientName":<姓名原文>, "demographics":{ "patientName":<姓名>, "sex":<性别>, "age":<数字>, "ethnicity":<民族>, "phone":<电话/可空>, "address":<住址/可空> },',
  '  "encounter":{ "department":<科室>, "admittedAt":<YYYY-MM-DD>, "dischargedAt":<YYYY-MM-DD>, "lengthOfStayDays":<数字> },',
  '  "problems":[ { "name":<诊断名>, "icd":<疾病编码/可空>, "rank":"primary"|"secondary" } ],',
  '  "labs":[ { "name":<化验名>, "value":<数字>, "unit":<单位>, "date":<YYYY-MM-DD/可空> } ],',
  '  "vitals":{ "tempC":<数字>, "pulse":<数字>, "resp":<数字>, "bpSys":<数字>, "bpDia":<数字>, "heightCm":<数字>, "weightKg":<数字> },',
  '  "imaging":[ { "modality":<检查名>, "finding":<所见> } ],',
  '  "procedures":[ { "name":<操作名>, "date":<YYYY-MM-DD/可空> } ],',
  '  "history":{ "past":[<既往史>], "medications":[<用药>], "allergies":[<过敏>], "personal":[<个人史>], "family":[<家族史>] },',
  '  "specialty":{ "findings":[<专科查体阳性所见>] },',
  '  "narrative":{ "chiefComplaint":<主诉>, "presentIllness":<现病史> } }',
  "原样照抄姓名/身份证/电话/住址等原文到对应字段（系统会在抽取后立即脱敏）。化验请保留每个时间点为一条，不要合并。看不清或缺失的字段省略，不要编造。",
].join("\n");

/**
 * The single choke-point that turns a (PHI-bearing) extracted object into a stored,
 * de-identified, validated, rendered case. EVERYTHING that produces a case must go
 * through here. Returns { ok, case, card, validation, audit } — never the raw input.
 */
function finalizeCase(rawCase, opts = {}) {
  if (!rawCase || typeof rawCase !== "object") return { ok: false, error: "EMPTY_EXTRACTION" };
  const { deidentified, audit } = deidentifyCase(rawCase, { salt: opts.salt || "" });
  if (deidentified.schemaVersion == null) deidentified.schemaVersion = 1;
  const validation = validateCase(deidentified);
  // Accuracy hardening: validate fields + (optionally) cross-check a second
  // independent extraction (dual-track). Verification runs on the DE-IDENTIFIED
  // case — it only needs clinical fields, never PHI.
  const second = opts.second ? deidentifyCase(opts.second, { salt: opts.salt || "" }).deidentified : null;
  const verification = verifyExtraction(deidentified, { second });
  const card = renderCaseMarkdown(deidentified);
  return {
    ok: validation.ok && !verification.summary.hasErrors,
    needsReview: verification.summary.needsReview > 0,
    case: deidentified,
    card,
    validation,
    verification,
    audit,
  };
}

// ----- model + PDF shell (needs a live vision model to verify end-to-end) -------

function modelConfig() {
  return {
    baseUrl: process.env.ANTHROPIC_BASE_URL || process.env.LILY_MODEL_BASE_URL || "",
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "",
    model: process.env.LILY_VISION_MODEL || process.env.LILY_MODEL || process.env.ANTHROPIC_MODEL || "",
  };
}

function renderPdfToPngs(pdfPath, outDir) {
  // Prefer poppler's pdftoppm; if unavailable, the caller must pass imagePaths.
  const probe = spawnSync("pdftoppm", ["-h"], { encoding: "utf8" });
  if (probe.error) return null;
  const prefix = path.join(outDir, "page");
  const res = spawnSync("pdftoppm", ["-png", "-r", "150", pdfPath, prefix], { encoding: "utf8" });
  if (res.status !== 0) return null;
  return fs.readdirSync(outDir).filter((f) => /^page.*\.png$/.test(f)).sort().map((f) => path.join(outDir, f));
}

function callVision(cfg, imagePaths, timeoutMs = 180000) {
  const content = [{ type: "text", text: EXTRACTION_PROMPT }];
  for (const p of imagePaths.slice(0, 20)) {
    const b64 = fs.readFileSync(p).toString("base64");
    content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });
  }
  const url = new URL(`${cfg.baseUrl.replace(/\/?$/, "/")}chat/completions`);
  const body = JSON.stringify({ model: cfg.model, messages: [{ role: "user", content }], temperature: 0, max_tokens: 4000 });
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`vision ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content || ""); } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("vision timeout")); });
    req.write(body); req.end();
  });
}

function parseCaseJson(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function emit(payload, code = 0) {
  (code === 0 ? process.stdout : process.stderr).write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const salt = input.salt || process.env.LILY_CASE_SALT || "";
  const outDir = input.outDir || path.join(process.cwd(), "cases");

  // Path A (testable / agent-supplied): a pre-extracted raw case → finalize.
  let rawCase = input.preExtracted || null;

  // Path B: extract from the scan with a vision model.
  if (!rawCase) {
    const cfg = modelConfig();
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) emit({ ok: false, code: "MODEL_UNAVAILABLE", message: "需要本地/院内视觉模型 (ANTHROPIC_BASE_URL / token / LILY_VISION_MODEL)。" }, 3);
    let imagePaths = Array.isArray(input.imagePaths) ? input.imagePaths : [];
    if (!imagePaths.length && input.pdfPath) {
      const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "case-pages-"));
      imagePaths = renderPdfToPngs(input.pdfPath, tmp) || [];
      if (!imagePaths.length) emit({ ok: false, code: "PDF_RENDER_UNAVAILABLE", message: "未找到 pdftoppm(poppler)，请安装或改传 imagePaths。" }, 4);
    }
    if (!imagePaths.length) emit({ ok: false, code: "BAD_INPUT", message: "需要 pdfPath 或 imagePaths 或 preExtracted。" }, 2);
    let content;
    try { content = await callVision(cfg, imagePaths); } catch (err) { emit({ ok: false, code: "VISION_FAILED", message: err.message }, 5); }
    rawCase = parseCaseJson(content);
    if (!rawCase) emit({ ok: false, code: "EXTRACT_FAILED", message: "视觉模型未返回可解析的病例 JSON（不编造）。" }, 6);
  }

  // De-identify IMMEDIATELY, then validate/render — single choke-point.
  const result = finalizeCase(rawCase, { salt });

  // Persist ONLY the de-identified case, inside the app's own data dir.
  fs.mkdirSync(outDir, { recursive: true });
  const key = result.case.patientKey || result.case.caseId || "case";
  const file = path.join(outDir, `${String(key).replace(/[^A-Za-z0-9_-]/g, "")}.case.json`);
  fs.writeFileSync(file, JSON.stringify(result.case, null, 2));

  emit({ ok: result.ok, needsReview: result.needsReview, file, validation: result.validation, verification: result.verification, audit: result.audit, card: result.card });
}

if (require.main === module) {
  main().catch((err) => emit({ ok: false, code: "FATAL", message: err.message }, 1));
}

module.exports = { finalizeCase, parseCaseJson, EXTRACTION_PROMPT, buildExtractionPrompt: () => EXTRACTION_PROMPT };
