#!/usr/bin/env node
"use strict";

/**
 * EMR case schema for the Clinical Case Assistant app (clinician decision-support,
 * 风湿免疫 single-specialty, all data stays inside the app folder).
 *
 * This is the typed shape a scanned 住院病案 is extracted into, plus the
 * DETERMINISTIC pieces that must never be left to a model (project Rule 5: code
 * answers deterministic transforms). Specifically: lab abnormal flags (↑/↓) are
 * computed from reference ranges here, not guessed by the LLM.
 *
 * Pure logic — no model, no network, no PHI handling (that is deidentify.cjs).
 * Verified by scripts/test-clinical-case-deid.mjs.
 *
 * Case object shape (after de-identification):
 *   {
 *     schemaVersion, caseId (pseudonymous), encounter:{department, admittedAt,
 *       dischargedAt, lengthOfStayDays},
 *     demographics:{ sex, age, ethnicity, occupation },   // NO name/id/phone/address
 *     problems:[ { name, icd?, rank:"primary"|"secondary", admissionStatus? } ],
 *     labs:[ { name, value, unit, date?, refLow?, refHigh?, flag } ],
 *     vitals:{ tempC?, pulse?, resp?, bpSys?, bpDia?, heightCm?, weightKg? },
 *     imaging:[ { modality, finding } ],
 *     procedures:[ { name, date? } ],
 *     history:{ past:[], medications:[], allergies:[], personal:[], family:[] },
 *     specialty:{ findings:[] },                           // 专科情况
 *     narrative:{ chiefComplaint?, presentIllness? },      // de-identified free text
 *     provenance:{ source, extractedAt?, fieldConfidence?:{} }
 *   }
 */

const SCHEMA_VERSION = 1;

// Adult reference ranges for the CBC values this specialty leans on. Sex-specific
// where it matters (Hb). Ranges are conventional Chinese-lab adult values; they
// are configuration, not medical advice, and can be overridden per deployment.
const LAB_REFERENCE = {
  "白细胞": { unit: "10^9/L", low: 3.5, high: 9.5, aliases: ["wbc", "白细胞计数", "白细胞数"] },
  "中性粒细胞": { unit: "10^9/L", low: 1.8, high: 6.3, aliases: ["中性粒细胞计数", "neutrophil", "neut"] },
  "淋巴细胞": { unit: "10^9/L", low: 1.1, high: 3.2, aliases: ["淋巴细胞计数", "lymphocyte", "lymph"] },
  "血红蛋白": { unit: "g/L", low: 115, high: 150, lowMale: 130, highMale: 175, aliases: ["hb", "hgb", "血色素"] },
  "血小板": { unit: "10^9/L", low: 125, high: 350, aliases: ["plt", "血小板计数"] },
};

function canonicalLabName(name) {
  const key = String(name || "").trim().toLowerCase();
  for (const [canonical, ref] of Object.entries(LAB_REFERENCE)) {
    if (canonical.toLowerCase() === key) return canonical;
    if ((ref.aliases || []).some((a) => a.toLowerCase() === key)) return canonical;
  }
  return null;
}

/** Deterministic abnormal flag: "low" | "high" | "normal" | "unknown".
 *  "unknown" (never silently "normal") when we have no reference for the lab —
 *  fail loud, don't fabricate reassurance. */
function flagValue(name, value, sex) {
  const num = typeof value === "number" ? value : parseFloat(String(value).replace(/[^\d.+-]/g, ""));
  if (!Number.isFinite(num)) return "unknown";
  const canonical = canonicalLabName(name);
  const ref = canonical && LAB_REFERENCE[canonical];
  if (!ref) return "unknown";
  const male = String(sex || "").startsWith("男") || String(sex || "").toLowerCase().startsWith("m");
  const low = male && ref.lowMale != null ? ref.lowMale : ref.low;
  const high = male && ref.highMale != null ? ref.highMale : ref.high;
  if (num < low) return "low";
  if (num > high) return "high";
  return "normal";
}

/** Attach refLow/refHigh/flag to each lab using the reference table (deterministic). */
function annotateLabs(labs, sex) {
  return (Array.isArray(labs) ? labs : []).map((lab) => {
    const canonical = canonicalLabName(lab.name);
    const ref = canonical && LAB_REFERENCE[canonical];
    const male = String(sex || "").startsWith("男");
    return {
      ...lab,
      name: canonical || lab.name,
      refLow: ref ? (male && ref.lowMale != null ? ref.lowMale : ref.low) : lab.refLow,
      refHigh: ref ? (male && ref.highMale != null ? ref.highMale : ref.high) : lab.refHigh,
      flag: flagValue(lab.name, lab.value, sex),
    };
  });
}

function emptyCase() {
  return {
    schemaVersion: SCHEMA_VERSION,
    caseId: "",
    encounter: {},
    demographics: {},
    problems: [],
    labs: [],
    vitals: {},
    imaging: [],
    procedures: [],
    history: { past: [], medications: [], allergies: [], personal: [], family: [] },
    specialty: { findings: [] },
    narrative: {},
    provenance: { source: "" },
  };
}

/** Structural validation. Returns { ok, errors } — does NOT mutate. Intentionally
 *  lenient on optional fields (real scans are messy) but strict that PHI-bearing
 *  fields are absent (the schema must not even have a slot for them). */
function validateCase(input) {
  const errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["case must be an object"] };
  if (input.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  for (const banned of ["name", "idNumber", "phone", "address", "patientName"]) {
    if (banned in (input.demographics || {})) errors.push(`demographics must not carry PHI field: ${banned}`);
    if (banned in input) errors.push(`case must not carry top-level PHI field: ${banned}`);
  }
  if (!Array.isArray(input.problems)) errors.push("problems must be an array");
  if (!Array.isArray(input.labs)) errors.push("labs must be an array");
  return { ok: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  LAB_REFERENCE,
  canonicalLabName,
  flagValue,
  annotateLabs,
  emptyCase,
  validateCase,
};
