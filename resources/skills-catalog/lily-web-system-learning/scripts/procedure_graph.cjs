#!/usr/bin/env node
"use strict";

/**
 * Skill graph for procedure cards (BrowserBC's "skill graph"): organize many
 * distilled cards so the library scales without turning into a pile of duplicate,
 * conflicting entries. Each new card is reconciled against the graph as one of:
 *   - merge      : same intent + same step sequence → fold in (runs++, union
 *                  pitfalls/recovery/criteria; keep the richer steps).
 *   - specialize : same intent but a strict superset of steps/constraints → add as
 *                  a child node (edge kind "specialize") of the more general one.
 *   - alternative: same intent, a different way to do it → add + edge "alternative".
 *   - add        : new intent → new node.
 *
 * Pure + unit-testable. The basic reusable unit stays the natural-language card;
 * the graph just stores/retrieves/updates them. Verified by
 * scripts/test-web-system-procedure-cards.mjs.
 */

function emptyGraph() {
  return { schemaVersion: 1, nodes: [], edges: [] };
}

function intentKey(card) {
  return String(card?.intent || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stepSig(card) {
  return (Array.isArray(card?.steps) ? card.steps : []).map((s) => String(s.action || "")).join(">");
}

function uniq(...lists) {
  return [...new Set(lists.flat().filter(Boolean))];
}

// Fold `incoming` into the stored `card` (same intent + step sequence).
function mergeCards(card, incoming) {
  return {
    ...card,
    preconditions: uniq(card.preconditions, incoming.preconditions),
    steps: (incoming.steps?.length || 0) > (card.steps?.length || 0) ? incoming.steps : card.steps,
    completionCriteria: uniq(card.completionCriteria, incoming.completionCriteria),
    pitfalls: uniq(card.pitfalls, incoming.pitfalls),
    recovery: uniq(card.recovery, incoming.recovery),
    provenance: {
      source: card.provenance?.source || incoming.provenance?.source || "demonstration",
      runs: Number(card.provenance?.runs || 0) + Number(incoming.provenance?.runs || 1),
      // A failure run still strengthens the card (exposes preconditions); success
      // stays sticky once observed.
      success: Boolean(card.provenance?.success || incoming.provenance?.success),
    },
  };
}

function isPrefix(shortSig, longSig) {
  if (!shortSig) return false;
  return longSig === shortSig || longSig.startsWith(`${shortSig}>`);
}

/**
 * Reconcile a card into the graph. Returns { graph, action, nodeId }.
 * The graph is treated immutably (a new object is returned).
 */
function mergeCardIntoGraph(graph, card) {
  const g = graph && Array.isArray(graph.nodes) ? { schemaVersion: 1, nodes: [...graph.nodes], edges: [...(graph.edges || [])] } : emptyGraph();
  const key = intentKey(card);
  const sig = stepSig(card);
  const sameIntent = g.nodes.filter((n) => intentKey(n.card) === key);

  // 1) exact same procedure → merge into the existing node.
  const exact = sameIntent.find((n) => stepSig(n.card) === sig);
  if (exact) {
    exact.card = mergeCards(exact.card, card);
    return { graph: g, action: "merge", nodeId: exact.id };
  }

  const id = uniqueId(g, card.id || key.replace(/\s+/g, "-") || "procedure");
  const node = { id, card: { ...card, id }, parents: [] };

  // 2) strict superset of an existing procedure → specialization (child).
  const parent = sameIntent.find((n) => isPrefix(stepSig(n.card), sig) && stepSig(n.card) !== sig);
  if (parent) {
    node.parents = [parent.id];
    g.nodes.push(node);
    g.edges.push({ from: parent.id, to: id, kind: "specialize" });
    return { graph: g, action: "specialize", nodeId: id };
  }

  // 3) same intent, different path → alternative.
  if (sameIntent.length) {
    g.nodes.push(node);
    g.edges.push({ from: sameIntent[0].id, to: id, kind: "alternative" });
    return { graph: g, action: "alternative", nodeId: id };
  }

  // 4) brand-new intent.
  g.nodes.push(node);
  return { graph: g, action: "add", nodeId: id };
}

function uniqueId(graph, base) {
  let id = base;
  let n = 2;
  const taken = new Set(graph.nodes.map((node) => node.id));
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/** Lightweight retrieval: rank nodes by intent-term overlap with the query (and an
 *  optional page-context string), return the top few cards (BrowserBC keeps
 *  retrieval cheap; grounding is left to the executor). */
function retrieveCards(graph, query, opts = {}) {
  const limit = Number(opts.limit || 3);
  const terms = new Set(String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const ctx = String(opts.pageContext || "").toLowerCase();
  const scored = (graph?.nodes || []).map((node) => {
    const text = `${intentKey(node.card)} ${node.card.steps?.map((s) => s.target).join(" ") || ""}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (text.includes(t)) score += 1;
    if (ctx && node.card.preconditions?.some((p) => ctx.includes(String(p).toLowerCase().slice(0, 12)))) score += 0.5;
    return { card: node.card, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.card);
}

module.exports = { emptyGraph, mergeCardIntoGraph, retrieveCards, mergeCards, intentKey, stepSig };
