/**
 * Why a client got the config it got.
 *
 * Delivery is a pipeline: rules merge, then a series of stages rewrite the
 * result (model menu expansion, collaboration and character-worlds gates, agent
 * availability, gateway runtime injection). Every stage is individually
 * fail-safe — when something is missing it keeps the previous value rather than
 * shipping an empty menu — and together they meant an operator could save a
 * rule, see it listed, and never learn that the delivered config dropped it.
 *
 * So the pipeline keeps a receipt:
 *
 *   - provenance: which rule established each field that a rule established.
 *   - decisions: which stage removed or rewrote which field, and how.
 *
 * The receipt is produced by DIFFING each stage's output against its input, so
 * a stage added later is covered without remembering to report anything. That
 * is the point: silence must not be inheritable.
 */

const MAX_DECISIONS = 200;
const MAX_VALUE_CHARS = 120;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Leaf paths of a config object. Arrays are leaves: delivery replaces them whole. */
export function leafPaths(value, prefix = "", out = new Map()) {
  if (!isPlainObject(value)) {
    if (prefix) out.set(prefix, value);
    return out;
  }
  const keys = Object.keys(value);
  if (!keys.length && prefix) out.set(prefix, value);
  for (const key of keys) leafPaths(value[key], prefix ? `${prefix}.${key}` : key, out);
  return out;
}

function describe(value) {
  if (value === undefined) return "(absent)";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.length}]`;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const body = String(text ?? "");
  return body.length > MAX_VALUE_CHARS ? `${body.slice(0, MAX_VALUE_CHARS)}…` : body;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/**
 * Merge rules in the order given, recording which rule established each field.
 * The merge itself is the delivery merge: objects deep-merge, everything else
 * (including arrays) replaces — unchanged, because delivery semantics are not
 * what this change is about.
 */
export function mergeWithProvenance(profiles = [], baseline = {}, options = {}) {
  const provenance = {};
  const source = options.sourceOf || ((profile) => ({ id: profile?.id || "", scope: profile?.scope || "", name: profile?.name || "" }));
  let config = structuredClone(baseline || {});
  for (const profile of profiles) {
    const before = leafPaths(config);
    config = deepMergeInto(config, profile?.config || {});
    const after = leafPaths(config);
    for (const [path, value] of after) {
      if (!before.has(path) || !sameValue(before.get(path), value)) provenance[path] = source(profile);
    }
  }
  return { config, provenance };
}

/** The delivery merge: plain objects deep-merge, arrays and scalars replace. */
export function deepMergeInto(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : structuredClone(patch);
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMergeInto(out[key], value) : structuredClone(value);
  }
  return out;
}

/**
 * A pipeline that cannot lose a field quietly.
 *
 * `stage(name, config, fn)` runs one transform and records every leaf that
 * disappeared or changed. `skipped` records rules that never made it into the
 * merge, with the reason.
 */
export function createDeliveryTrace(options = {}) {
  const decisions = [];
  const limit = Number.isFinite(options.maxDecisions) ? options.maxDecisions : MAX_DECISIONS;
  let provenance = {};

  function note(entry) {
    if (decisions.length >= limit) return;
    decisions.push(entry);
  }

  return {
    merge(profiles, baseline, mergeOptions) {
      const merged = mergeWithProvenance(profiles, baseline, mergeOptions);
      provenance = merged.provenance;
      return merged.config;
    },
    /** Record rules that were considered and not applied. */
    skipped(entries = []) {
      for (const entry of entries) {
        if (entry?.reason === "target_mismatch") continue; // not addressed to this client
        note({ stage: "select", field: "", reason: entry.reason, rule: entry.id || "", detail: entry.scope || "" });
      }
    },
    stage(name, config, fn) {
      const before = leafPaths(config);
      const next = fn(config);
      const after = leafPaths(next);
      for (const [path, value] of before) {
        if (!after.has(path)) note({ stage: name, field: path, reason: "removed", detail: describe(value) });
        else if (!sameValue(after.get(path), value)) {
          note({ stage: name, field: path, reason: "rewritten", detail: `${describe(value)} -> ${describe(after.get(path))}` });
        }
      }
      for (const [path] of after) {
        if (!before.has(path)) note({ stage: name, field: path, reason: "added", detail: "" });
      }
      return next;
    },
    /** What an operator needs: what a rule set, and what later took it away. */
    receipt() {
      return { provenance, decisions: decisions.slice() };
    },
  };
}
