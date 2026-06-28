#!/usr/bin/env node
"use strict";

/**
 * PHI de-identification for the Clinical Case Assistant.
 *
 * HARD REQUIREMENT (project Rule 13 applied to privacy): this runs on EVERY case
 * BEFORE it is stored or sent to any model. Its failure mode must degrade to MORE
 * redaction, never less — when the input shape is unexpected or a value can't be
 * proven clean, it scrubs aggressively rather than letting PHI through. Privacy
 * fails CLOSED.
 *
 * What it removes / transforms:
 *   - drop entirely: 姓名/name, 联系人/contact, 住址/address, 户口地址, 工作单位,
 *     出生日期/birthDate, 邮编/postcode, 健康卡号, 病史陈述者
 *   - pseudonymize (stable, non-reversible HMAC with a local salt): 病案号/caseId,
 *     住院号/admissionNo, 身份证号/idNumber, patientId — so the SAME patient links
 *     across encounters without ever storing the real identifier
 *   - scrub embedded PHI in ALL free-text values: 18/15-digit ID numbers, mainland
 *     mobile/landline numbers, and any known patient/contact name tokens
 *
 * Known limitation (surfaced, not hidden): free-text name redaction relies on the
 * names we can harvest from structured fields. Arbitrary third-party names buried
 * in prose are not guaranteed caught — keep raw scans out of the app per the
 * "PHI 不出门 / local-only" deployment decision; this module is defense-in-depth,
 * not a license to ingest unreviewed text.
 *
 * Pure logic — no network, no model. Verified by scripts/test-clinical-case-deid.mjs.
 */

const crypto = require("node:crypto");

// Keys whose VALUE is PHI and carries no clinical signal → drop outright.
// NOTE: never use a bare "name"/"contact" here — those collide with clinical
// fields (a problem's name, a lab's name). The patient name MUST live under a
// distinct key (patientName / 姓名), which the extractor is responsible for.
const DROP_KEYS = new Set([
  "patientname", "姓名", "患者姓名",
  "contact", "contactname", "联系人", "联系人姓名", "病史陈述者", "narrator",
  "address", "住址", "现住址", "户口地址", "工作单位", "workplace",
  "birthdate", "出生日期", "dob",
  "postcode", "邮编", "zip",
  "healthcard", "健康卡号",
  "phone", "电话", "contactphone", "联系电话", "tel", "mobile",
  "idnumber", "身份证号", "身份证", "idcard",
]);

// Encounter/case identifiers we KEEP as a link key, but only as a non-reversible
// pseudonym (the value is opaque; the key name carries no PHI).
const PSEUDONYMIZE_KEYS = new Set([
  "caseid", "病案号", "admissionno", "住院号", "patientid", "mrn",
]);

// Patient identifiers (id card etc.) are DROPPED raw, but first folded into a
// single stable `patientKey` so a patient's encounters can be linked WITHOUT
// keeping anything that looks like an identifier. `patientkey` itself is listed so
// re-running de-id is idempotent.
const PATIENT_ID_KEYS = new Set(["idnumber", "身份证号", "身份证", "idcard", "patientkey"]);

// Keys from which we harvest names to scrub out of free text elsewhere.
const NAME_SOURCE_KEYS = new Set(["patientname", "姓名", "患者姓名", "contactname", "联系人", "病史陈述者", "narrator"]);

const ID_18_RE = /\b\d{17}[\dXx]\b/g;          // mainland resident ID (18)
const ID_15_RE = /\b\d{15}\b/g;                 // legacy resident ID (15)
const MOBILE_RE = /\b1[3-9]\d{9}\b/g;           // mainland mobile
const LANDLINE_RE = /\b0\d{2,3}-?\d{7,8}\b/g;   // landline

const PSEUDONYM_RE = /^P-[0-9a-f]{12}$/;

function pseudonym(value, salt) {
  const v = String(value == null ? "" : value).trim();
  if (!v) return "";
  if (PSEUDONYM_RE.test(v)) return v; // already pseudonymized → don't re-hash (keeps de-id idempotent)
  return "P-" + crypto.createHmac("sha256", String(salt || "")).update(v).digest("hex").slice(0, 12);
}

/** Redact ID numbers, phones, and any supplied name tokens from a string. */
function scrubText(text, names = []) {
  if (typeof text !== "string" || !text) return text;
  let out = text
    .replace(ID_18_RE, "[身份证]")
    .replace(ID_15_RE, "[身份证]")
    .replace(MOBILE_RE, "[电话]")
    .replace(LANDLINE_RE, "[电话]");
  for (const name of names) {
    const n = String(name || "").trim();
    if (n.length >= 2) out = out.split(n).join("[姓名]");
  }
  return out;
}

/** First non-empty value under any patient-identifier key, anywhere in the tree. */
function findPatientId(node) {
  if (Array.isArray(node)) {
    for (const v of node) { const f = findPatientId(v); if (f) return f; }
    return "";
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && PATIENT_ID_KEYS.has(k.toLowerCase()) && v.trim()) return v.trim();
      const f = findPatientId(v);
      if (f) return f;
    }
  }
  return "";
}

function harvestNames(node, acc) {
  if (Array.isArray(node)) { node.forEach((v) => harvestNames(v, acc)); return; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && NAME_SOURCE_KEYS.has(k.toLowerCase())) {
        const n = v.trim();
        if (n.length >= 2 && n.length <= 8) acc.add(n);
      }
      harvestNames(v, acc);
    }
  }
}

/**
 * De-identify a case object (or any nested structure). Returns
 * { deidentified, audit:{ dropped, pseudonymized, textScrubbed } }.
 * Fail-closed: unknown keys whose value is a string are still scrubbed; objects
 * are walked fully; nothing is passed through unexamined.
 */
function deidentifyCase(input, opts = {}) {
  const salt = opts.salt || "";
  const names = new Set(Array.isArray(opts.extraNames) ? opts.extraNames : []);
  harvestNames(input, names);
  const nameList = [...names];
  const audit = { dropped: 0, pseudonymized: 0, textScrubbed: 0 };

  const patientId = findPatientId(input);

  function walk(node) {
    if (typeof node === "string") {
      const scrubbed = scrubText(node, nameList);
      if (scrubbed !== node) audit.textScrubbed += 1;
      return scrubbed;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        const key = k.toLowerCase();
        if (key === "patientkey") continue;            // re-derived below (idempotent)
        if (PSEUDONYMIZE_KEYS.has(key)) { out[k] = pseudonym(v, salt); audit.pseudonymized += 1; continue; }
        if (DROP_KEYS.has(key) || PATIENT_ID_KEYS.has(key)) { audit.dropped += 1; continue; }
        out[k] = walk(v);
      }
      return out;
    }
    return node; // numbers/booleans/null carry no PHI
  }

  const deidentified = walk(input);
  // Fold the patient identifier into a single opaque link key (never a raw ID).
  if (patientId) { deidentified.patientKey = pseudonym(patientId, salt); audit.pseudonymized += 1; }
  return { deidentified, audit };
}

/** Convenience guard for arbitrary text (e.g. a raw OCR dump) before it touches a
 *  model. Same fail-closed scrubbing; no structure assumed. */
function deidentifyText(text, opts = {}) {
  return scrubText(String(text || ""), Array.isArray(opts.extraNames) ? opts.extraNames : []);
}

module.exports = { deidentifyCase, deidentifyText, scrubText, pseudonym, DROP_KEYS, PSEUDONYMIZE_KEYS };
