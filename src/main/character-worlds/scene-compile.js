"use strict";

/**
 * §12 P3-2 group-scene compilation (extracted so context-compiler stays under
 * its line ratchet).
 * - swap (default): bounded summaries of every participant EXCEPT the active
 *   speaker (whose full card compiles as the primary revision).
 * - join: the declared safe fields of ALL members in stable participant order
 *   with per-character boundaries, plus a behaviorally-risky label (a card can
 *   never enable join; only the user scene control may).
 */

function cleanField(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function boundFieldText(raw, maxChars = 240) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const points = Array.from(text);
  return points.length > maxChars ? `${points.slice(0, maxChars).join("")}…` : text;
}

function sceneCompileCandidates(scene) {
  const participants = Array.isArray(scene.participants) ? scene.participants : [];
  const active = scene.activeSpeakerRevisionId || null;
  const safeFields = (rev) => {
    const c = rev?.canonical || {};
    return [
      ["name", cleanField(c.name)],
      ["description", cleanField(c.description)],
      ["personality", cleanField(c.personality)],
    ].filter(([, value]) => value);
  };
  if (scene.promptMode === "join") {
    const lines = [];
    for (const rev of participants) {
      const fields = safeFields(rev);
      if (!fields.length) continue;
      lines.push(`<character id="${rev.id || "?"}">`);
      for (const [field, value] of fields) lines.push(`- ${field}: ${value}`);
      lines.push("</character>");
    }
    if (!lines.length) return [];
    return [{
      type: "scene_join",
      compatibility: "imported_lower_authority",
      parts: [["members", lines.join("\n")]],
      extraFields: { risky: "behaviorally risky: models may merge identities" },
    }];
  }
  // swap: summaries of every participant except the active speaker.
  const summary = participants
    .filter((rev) => !active || rev?.id !== active)
    .map((rev) => {
      const c = rev?.canonical || {};
      const name = cleanField(c.name) || rev.id;
      const desc = boundFieldText(cleanField(c.description), 240);
      return desc ? `- ${name}: ${desc}` : `- ${name}`;
    });
  if (!summary.length) return [];
  return [{
    type: "scene_participants",
    compatibility: "imported_lower_authority",
    parts: [["participants", summary.join("\n")]],
  }];
}

module.exports = { sceneCompileCandidates };
