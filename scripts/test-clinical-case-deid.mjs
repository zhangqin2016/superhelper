#!/usr/bin/env node
// Clinical Case Assistant — foundation guards: PHI de-identification (fail-closed)
// and deterministic EMR lab flagging. No model, no network.
//
// WHY these tests (project Rule 9/13): this app ingests real hospital records, so
// the privacy module is load-bearing. A test that only checked "it ran" would be
// worthless — these assert the security property: PHI does NOT survive, clinical
// signal DOES, and when the input shape is unexpected the module redacts MORE, not
// less. Lab ↑/↓ is computed deterministically, never left to a model.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "resources/workspace-apps/clinical-case-assistant/source");
const { deidentifyCase, deidentifyText, pseudonym } = require(path.join(SRC, "deidentify.cjs"));
const { flagValue, annotateLabs, validateCase, emptyCase } = require(path.join(SRC, "emr_schema.cjs"));

// A realistic case modelled on a 风湿免疫 admission. PHI values here are FABRICATED
// (fake ID/phone/name) — never put a real patient's identifiers in a test.
const FAKE_ID = "110101195203078888";
const FAKE_PHONE = "13900008888";
const rawCase = {
  schemaVersion: 1,
  caseId: "13343209",                 // 病案号 → must become a pseudonym, not survive raw
  idNumber: FAKE_ID,                  // → pseudonymized
  demographics: { patientName: "张三花", sex: "女", age: 74, ethnicity: "汉族", phone: FAKE_PHONE, address: "山西省某市某区某街" },
  contact: { contactName: "李四", contactPhone: FAKE_PHONE },
  problems: [
    { name: "干燥综合征", icd: "M35.000", rank: "primary" },
    { name: "白细胞减少", icd: "D70.x04", rank: "secondary" },
    { name: "血小板减少", icd: "D69.600", rank: "secondary" },
  ],
  labs: [
    { name: "白细胞", value: 2.80, unit: "10^9/L", date: "2026-04-24" },
    { name: "白细胞", value: 1.89, unit: "10^9/L", date: "2026-05-08" },
    { name: "血小板", value: 71, unit: "10^9/L", date: "2026-05-08" },
    { name: "血红蛋白", value: 133, unit: "g/L", date: "2026-05-08" },
  ],
  narrative: {
    chiefComplaint: "口干、眼干1年",
    presentIllness: `病史陈述者张三花，电话${FAKE_PHONE}，身份证${FAKE_ID}。患者口干眼干逐渐加重，白细胞、血小板减低。`,
  },
};

// --- de-identification: PHI must NOT survive anywhere in the serialized output ---
const { deidentified, audit } = deidentifyCase(rawCase, { salt: "app-local-salt" });
const blob = JSON.stringify(deidentified);

assert.ok(!blob.includes(FAKE_ID), "raw ID number must not survive (structured or in prose)");
assert.ok(!blob.includes(FAKE_PHONE), "phone number must not survive anywhere");
assert.ok(!blob.includes("张三花"), "patient name must not survive (dropped + scrubbed from prose)");
assert.ok(!blob.includes("李四"), "contact name must not survive");
assert.ok(!blob.includes("某街"), "address must not survive");
assert.ok(deidentified.demographics.patientName === undefined, "patient name field is dropped, not emptied");
assert.ok(deidentified.idNumber === undefined, "raw id number field is dropped entirely");
assert.ok(/^P-[0-9a-f]{12}$/.test(deidentified.patientKey), "a stable opaque patientKey links encounters without keeping an ID");
assert.ok(audit.dropped > 0 && audit.pseudonymized > 0, "audit reports what was removed");

// the patientKey must be derived from the id (same patient → same key)
const otherEncounter = deidentifyCase({ schemaVersion: 1, idNumber: FAKE_ID, problems: [] }, { salt: "app-local-salt" });
assert.equal(otherEncounter.deidentified.patientKey, deidentified.patientKey, "same patient (same id) → same patientKey across encounters");

// --- clinical signal MUST survive (de-id must not lobotomize the case) ----------
assert.ok(blob.includes("干燥综合征") && blob.includes("M35.000"), "diagnoses + ICD codes preserved");
assert.equal(deidentified.labs[0].value, 2.80, "lab values preserved exactly");
assert.equal(deidentified.demographics.age, 74, "age preserved");
assert.ok(deidentified.narrative.presentIllness.includes("口干眼干"), "clinical narrative preserved after scrubbing PHI from it");

// --- pseudonyms: stable, non-reversible, salt-dependent -------------------------
assert.equal(pseudonym(FAKE_ID, "s1"), pseudonym(FAKE_ID, "s1"), "same id+salt → same pseudonym (links a patient across encounters)");
assert.notEqual(pseudonym(FAKE_ID, "s1"), pseudonym(FAKE_ID, "s2"), "different salt → different pseudonym");
assert.ok(!pseudonym(FAKE_ID, "s1").includes(FAKE_ID) && /^P-[0-9a-f]{12}$/.test(pseudonym(FAKE_ID, "s1")), "pseudonym is an opaque non-reversible token");

// --- idempotent: running de-id again changes nothing ----------------------------
const twice = deidentifyCase(deidentified, { salt: "app-local-salt" }).deidentified;
assert.deepEqual(twice, deidentified, "de-identification is idempotent");

// --- FAIL-CLOSED: unknown shape with PHI buried in prose is still scrubbed -------
const weird = { notes: `患者身份证${FAKE_ID} 手机${FAKE_PHONE}`, deep: { more: [`联系电话 ${FAKE_PHONE}`] } };
const weirdOut = JSON.stringify(deidentifyCase(weird, { salt: "x" }).deidentified);
assert.ok(!weirdOut.includes(FAKE_ID) && !weirdOut.includes(FAKE_PHONE), "PHI in unrecognized fields is still scrubbed (privacy fails closed)");
assert.ok(deidentifyText(`身份证${FAKE_ID}`).includes("[身份证]"), "free-text guard scrubs raw text too");

// --- deterministic lab flags (code answers, not the model) ----------------------
assert.equal(flagValue("白细胞", 2.80, "女"), "low", "WBC 2.80 flagged low");
assert.equal(flagValue("血小板", 71, "女"), "low", "platelet 71 flagged low");
assert.equal(flagValue("血红蛋白", 133, "女"), "normal", "Hb 133 normal for female range");
assert.equal(flagValue("白细胞", 6, "女"), "normal", "WBC 6 normal");
assert.equal(flagValue("某未知指标", 5, "女"), "unknown", "unknown lab → 'unknown', never silently 'normal'");
const annotated = annotateLabs(rawCase.labs, "女");
assert.ok(annotated.every((l) => ["low", "high", "normal", "unknown"].includes(l.flag)), "every lab gets a deterministic flag");
assert.equal(annotated[0].refLow, 3.5, "reference range attached deterministically");

// --- schema validation rejects PHI-bearing shapes -------------------------------
assert.equal(validateCase(deidentified).ok, true, "de-identified case passes validation");
assert.equal(validateCase({ ...emptyCase(), name: "x" }).ok, false, "a case carrying a top-level name field is rejected");

console.log("clinical-case-deid: ok");
