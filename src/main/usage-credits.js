"use strict";

/**
 * Estimated Lily credits for the device usage page (2026-09-30).
 *
 * The page shows credits, never money: Lily charges official models in credits,
 * each model at its own rate. The rates come from the server (the same pricing
 * rules the gateway charges with); the client keeps no price table. A device
 * usage row carries input and output tokens only — no cache split — so every
 * input token is priced as uncached: the estimate is at or above the real
 * charge, never below it.
 *
 * Per row, `creditState` says what the page may claim:
 *   "estimated"  — a model routed through the Lily gateway, with a rate
 *   "notCharged" — the user's own connection (their provider bills them)
 *   "unknown"    — no rate yet, or a row whose connection is not identified
 */

function rateValue(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeRate(raw) {
  const input = rateValue(raw?.input);
  const output = rateValue(raw?.output);
  return input === null || output === null ? null : { input, output };
}

/** Server `creditRates` → { models, default } or null when unusable. */
function normalizeCreditRates(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fallback = normalizeRate(raw.default);
  if (!fallback) return null;
  const models = {};
  for (const [model, rate] of Object.entries(raw.models || {})) {
    const normalized = normalizeRate(rate);
    if (normalized) models[model] = normalized;
  }
  return { models, default: fallback };
}

/** Whole credits, rounded up, all input priced as uncached. */
function estimateCredits(row, rate) {
  const input = Math.max(0, Math.trunc(Number(row?.inputTokens) || 0));
  const output = Math.max(0, Math.trunc(Number(row?.outputTokens) || 0));
  const micro = input * rate.input + output * rate.output;
  return micro > 0 ? Math.ceil(micro / 1_000_000) : 0;
}

/** row.billedInCredits: true (Lily gateway) | false (own connection) | null (unknown). */
function creditRow(row, rates) {
  if (row.billedInCredits === false) return { ...row, creditState: "notCharged", estimatedCredits: null };
  if (row.billedInCredits !== true || !rates) return { ...row, creditState: "unknown", estimatedCredits: null };
  const rate = Object.hasOwn(rates.models, row.model) ? rates.models[row.model] : rates.default;
  return { ...row, creditState: "estimated", estimatedCredits: estimateCredits(row, rate) };
}

/** A total is the sum of its estimated rows; null when no rates are known. */
function creditTotal(target, rows, rates) {
  const estimatedCredits = rates ? rows.reduce((sum, row) => sum + (row.estimatedCredits || 0), 0) : null;
  return { ...target, estimatedCredits };
}

function applyCreditEstimates(summary, rawRates) {
  const rates = normalizeCreditRates(rawRates);
  const day = (value) => {
    const models = (value.models || []).map(row => creditRow(row, rates));
    return creditTotal({ ...value, models }, models, rates);
  };
  const modelTotals = (summary.modelTotals || []).map(row => creditRow(row, rates));
  const today = day(summary.today);
  const history = (summary.history || []).map(day);
  return {
    ...summary,
    today,
    history,
    modelTotals,
    rangeTotals: creditTotal(summary.rangeTotals, modelTotals, rates),
    credits: { available: Boolean(rates) },
  };
}

module.exports = { applyCreditEstimates, normalizeCreditRates, estimateCredits };
