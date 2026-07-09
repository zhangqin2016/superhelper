"use strict";

/**
 * Generic procedure cards (程序卡): the platform's asynchronous strong→weak
 * knowledge transfer, generalized from the web-system-learning pattern.
 *
 * When a capable model completes a real multi-tool task, the SUCCESSFUL tool
 * path is distilled DETERMINISTICALLY (no model call, no tokens) from the
 * turn's tool timeline into a compact card. When a later request matches a
 * stored card by intent overlap, the card is injected as advisory platform
 * context — a weak model no longer has to plan the task from scratch; it
 * replays a proven path. Strong models may also benefit (a head start), but
 * the card is explicitly advisory so it never constrains a better plan.
 *
 * Capability-gate guard rails (Rule 13):
 * - kill switch: LILY_PROCEDURE_CARDS=0 (authoring AND injection)
 * - lite-graded models never AUTHOR cards (their tool paths are the least
 *   trustworthy); every grade consumes
 * - deterministic distillation only — zero model cost, zero new failure modes
 * - injection is a bounded advisory layer; absence of a match changes nothing
 * - store is per-project, size-capped LRU; corrupt stores reset, never throw
 */

const fs = require("node:fs");
const path = require("node:path");
const { intentOverlapScore } = require("./runtime/intent-relevance");
const { getLogger } = require("./logger");

const log = getLogger("procedure-cards");

const MAX_CARDS_PER_PROJECT = 40;
const MIN_TOOLS_FOR_CARD = 3;
const MAX_STEPS_PER_CARD = 10;
const MIN_MATCH_SCORE = 3;
const MAX_CONTEXT_CHARS = 800;

function cardsEnabled() {
  return process.env.LILY_PROCEDURE_CARDS !== "0";
}

function cardsPath(projectId) {
  const safe = String(projectId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = require("./config").userDataPath("procedure-cards");
  return path.join(dir, `${safe}.json`);
}

function readCards(projectId) {
  try {
    const file = cardsPath(projectId);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed?.cards) ? parsed.cards : [];
  } catch {
    return [];
  }
}

function writeCards(projectId, cards) {
  try {
    const file = cardsPath(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, cards }, null, 2)}\n`);
    return true;
  } catch (err) {
    log.warn(`procedure card write failed open: ${err?.message || String(err)}`);
    return false;
  }
}

function compactStepLabel(tool = {}) {
  const input = tool.input && typeof tool.input === "object" ? tool.input : {};
  const detail = input.description || input.command || input.url || input.path || input.query || "";
  const text = String(detail || "").replace(/\s+/g, " ").trim();
  const name = String(tool.name || "tool");
  return text ? `${name}: ${text.slice(0, 60)}` : name;
}

function normalizeTitle(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Deterministic distillation from a finished turn's tool timeline. Returns
 *  the stored card or null when the turn doesn't qualify. */
function recordProcedureCardFromTurn({ projectId, userText, tools, capabilityGrade = "" } = {}) {
  try {
    if (!cardsEnabled()) return null;
    // lite paths are the least trustworthy — never author from them.
    if (String(capabilityGrade) === "lite") return null;
    const title = normalizeTitle(userText);
    if (title.length < 8) return null;
    const toolList = Array.isArray(tools) ? tools : [...(tools?.values?.() || [])];
    const succeeded = toolList.filter((tool) =>
      ["done", "completed", "success"].includes(String(tool.status || "").toLowerCase()));
    if (succeeded.length < MIN_TOOLS_FOR_CARD) return null;
    // Cards describe HOW, not intermediate noise: first N successful steps.
    const steps = succeeded.slice(0, MAX_STEPS_PER_CARD).map(compactStepLabel);
    const card = {
      id: `card_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      steps,
      toolNames: [...new Set(succeeded.map((tool) => String(tool.name || "")))].slice(0, 12),
      createdAt: Date.now(),
      uses: 0,
    };
    const cards = readCards(projectId).filter((existing) => normalizeTitle(existing.title) !== title);
    cards.push(card);
    // LRU by usefulness: most recently used/created survive the cap.
    cards.sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0));
    writeCards(projectId, cards.slice(0, MAX_CARDS_PER_PROJECT));
    return card;
  } catch (err) {
    log.warn(`procedure card record failed open: ${err?.message || String(err)}`);
    return null;
  }
}

/** Best stored card for this request, or null below the match threshold. */
function matchProcedureCard({ projectId, text } = {}) {
  try {
    if (!cardsEnabled()) return null;
    const request = String(text || "").trim();
    if (request.length < 8) return null;
    let best = null;
    let bestScore = 0;
    for (const card of readCards(projectId)) {
      const score = intentOverlapScore(request, `${card.title}\n${(card.steps || []).join("\n")}`);
      if (score > bestScore) {
        best = card;
        bestScore = score;
      }
    }
    return best && bestScore >= MIN_MATCH_SCORE ? { card: best, score: bestScore } : null;
  } catch {
    return null;
  }
}

/** Advisory platform-context block for a matched card; "" when no match. */
function buildProcedureCardContext({ projectId, text } = {}) {
  const match = matchProcedureCard({ projectId, text });
  if (!match) return "";
  try {
    const { card } = match;
    const steps = (card.steps || []).map((step, index) => `${index + 1}. ${step}`).join("\n");
    const block = [
      "A previously successful procedure for a similar request (advisory: use it as a starting plan, adapt freely, skip steps that do not apply):",
      `Task: ${card.title}`,
      steps,
    ].join("\n").slice(0, MAX_CONTEXT_CHARS);
    // Touch usage so useful cards survive the LRU cap.
    const cards = readCards(projectId);
    const stored = cards.find((entry) => entry.id === card.id);
    if (stored) {
      stored.uses = (stored.uses || 0) + 1;
      stored.lastUsedAt = Date.now();
      writeCards(projectId, cards);
    }
    return block;
  } catch {
    return "";
  }
}

module.exports = {
  recordProcedureCardFromTurn,
  matchProcedureCard,
  buildProcedureCardContext,
  // exported for focused testing
  readCards,
  MAX_CARDS_PER_PROJECT,
};
