"use strict";

/**
 * A guide section that is a LIST of entries — the skill catalog is one — still
 * helps as a subset: its heading and intro plus the entries that fit tell the
 * model what exists. The guide truncator used to keep or drop each section
 * whole, so on a tight (lite) budget the catalog went entirely and the model
 * no longer knew any skill existed (2026-09-28 audit). The shape is read from
 * the markdown itself — lines starting "- " after the intro — never from a
 * section title.
 */

const ENTRY_RE = /^- /;

function splitListSection(section) {
  const lines = section.lines.map((line) => line.replace(/\s+$/, ""));
  const first = lines.findIndex((line, index) => index > 0 && ENTRY_RE.test(line));
  if (first < 0) return null;
  const entries = lines.slice(first).filter((line) => ENTRY_RE.test(line));
  // Anything after the list that is not an entry (another paragraph) makes the
  // section something other than a plain list: keep the whole-or-nothing rule.
  if (entries.length < 2 || lines.slice(first).some((line) => line.trim() && !ENTRY_RE.test(line))) return null;
  return { preamble: lines.slice(0, first).join("\n").trim(), entries };
}

/**
 * The largest subset of a list section that fits `fits(body)`: entries ranked
 * by `score` (authored order on ties), rendered in authored order, with a line
 * naming how many were left out. Returns "" when not even one entry fits.
 */
function fitListSection(section, fits, score = () => 0) {
  const list = splitListSection(section);
  if (!list) return "";
  const ranked = list.entries
    .map((entry, index) => ({ entry, index, score: Number(score(entry)) || 0 }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));
  const chosen = [];
  const render = (picked) => {
    const omitted = list.entries.length - picked.length;
    const ordered = [...picked].sort((a, b) => a.index - b.index).map((item) => item.entry);
    return [list.preamble, "", ...ordered, `- (${omitted} more entries omitted for this model's input limit)`].join("\n");
  };
  for (const item of ranked) {
    if (fits(render([...chosen, item]))) chosen.push(item);
  }
  return chosen.length ? render(chosen) : "";
}

/**
 * Second pass of the guide truncator: every omitted list section keeps the
 * entries that fit — most relevant to this turn first — instead of vanishing.
 * Mutates kept/omitted like the whole-section pass; returns the new render, or
 * "" when nothing changed. LILY_GUIDE_PARTIAL_LISTS=0 restores whole-or-nothing.
 */
function fitOmittedListSections({ kept, omitted, render, limit, intentText = "" }) {
  if (process.env.LILY_GUIDE_PARTIAL_LISTS === "0") return "";
  const { intentOverlapScore } = require("./intent-relevance");
  const scoreEntry = String(intentText || "").trim() ? (entry) => intentOverlapScore(intentText, entry) : undefined;
  let result = "";
  for (const section of [...omitted]) {
    const nextOmitted = omitted.filter((item) => item !== section);
    const partial = fitListSection(section, (body) => render([...kept, body], nextOmitted).length <= limit, scoreEntry);
    if (!partial) continue;
    kept.push(partial);
    omitted.splice(omitted.indexOf(section), 1);
    result = render(kept, omitted);
  }
  return result;
}

module.exports = { fitListSection, fitOmittedListSections, splitListSection };
