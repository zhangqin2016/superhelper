"use strict";

const { performance } = require("node:perf_hooks");
const { DEFAULT_MACRO_LIMITS } = require("./constants");
const { formatDateMacro, snapshotContext } = require("./macro-context");
const { resolveMacroLimits } = require("./macro-limits");
const { lexMacroTokens, lexMacros, parseMacros } = require("./macro-parser");
const { createMacroPrng, uniformInt } = require("./macro-prng");
const { isWellFormedUtf16 } = require("./macro-unicode");
const { createWarningCollector } = require("./macro-warnings");

const BLOCKED_NAMES = new Set([
  "api", "command", "env", "eval", "exec", "fetch", "file",
  "http", "js", "shell", "system", "tool",
]);
const HANDLER_NAMES = new Set([
  "char", "date", "idle_duration", "isodate", "isotime", "lowercase",
  "original", "pick", "random", "roll", "time", "trim", "uppercase", "user", "weekday",
]);

function warningFor(node, limits) {
  if (BLOCKED_NAMES.has(node.name)) return { code: "MACRO_BLOCKED", name: node.name };
  const warning = { code: "MACRO_UNKNOWN" };
  if (node.name.length <= limits.maxNameBytes) warning.name = node.name;
  return warning;
}

function formatIdleDuration(milliseconds) {
  let remaining = Math.floor(milliseconds / 1000);
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function parseUnsigned(text, state) {
  const start = state.index;
  let value = 0;
  while (state.index < text.length) {
    const code = text.charCodeAt(state.index) - 48;
    if (code < 0 || code > 9) break;
    value = (value * 10) + code;
    if (!Number.isSafeInteger(value)) return null;
    state.index += 1;
  }
  return state.index === start ? null : value;
}

function parseDice(text, limits) {
  const state = { index: 0 };
  let count = 1;
  if (text[0] !== "d" && text[0] !== "D") {
    count = parseUnsigned(text, state);
    if (count === null) return null;
  }
  if (text[state.index] !== "d" && text[state.index] !== "D") return null;
  state.index += 1;
  const sides = parseUnsigned(text, state);
  if (sides === null) return null;
  let modifier = 0;
  if (state.index < text.length) {
    const sign = text[state.index] === "+" ? 1 : text[state.index] === "-" ? -1 : 0;
    if (!sign) return null;
    state.index += 1;
    const magnitude = parseUnsigned(text, state);
    if (magnitude === null) return null;
    modifier = sign * magnitude;
  }
  if (state.index !== text.length
      || count < 1
      || count > limits.maxDiceCount
      || sides < 1
      || sides > limits.maxDiceSides
      || Math.abs(modifier) > limits.maxDiceModifierAbs) {
    return null;
  }
  return { count, modifier, sides };
}

function initialStats(inputBytes = 0) {
  return {
    expansionCount: 0,
    inputBytes,
    maxDepth: 0,
    operationCount: 0,
    outputBytes: 0,
    randomDrawCount: 0,
    tokenCount: 0,
  };
}

function literalResult(
  text,
  code,
  stats = initialStats(Buffer.byteLength(text, "utf8")),
  maxWarnings = DEFAULT_MACRO_LIMITS.maxWarnings,
  maxOutputBytes = DEFAULT_MACRO_LIMITS.maxOutputBytes,
) {
  const output = Buffer.byteLength(text, "utf8") <= maxOutputBytes ? text : "";
  stats.outputBytes = Buffer.byteLength(output, "utf8");
  return { text: output, warnings: maxWarnings > 0 ? [{ code }] : [], stats };
}

function invalidUnicodeResult(text, limits) {
  const result = emptyFailureResult("MACRO_INPUT_UNICODE_INVALID", limits, text.length);
  result.stats.invalidUnicode = true;
  return result;
}

function emptyFailureResult(code, limits, inputCodeUnits = 0) {
  const stats = initialStats();
  stats.failureCode = code;
  stats.inputCodeUnits = inputCodeUnits;
  return {
    text: "",
    warnings: limits.maxWarnings > 0 ? [{ code }] : [],
    stats,
  };
}

function expandSafeMacrosInternal(text, context, limits) {
  if (typeof text !== "string") {
    return {
      text: "",
      warnings: limits.maxWarnings > 0 ? [{ code: "MACRO_INPUT_INVALID" }] : [],
      stats: initialStats(),
    };
  }
  if (text.length > limits.maxInputBytes) {
    return emptyFailureResult("MACRO_LIMIT_INPUT", limits, text.length);
  }
  if (limits.maxElapsedMs === 0) {
    return emptyFailureResult("MACRO_LIMIT_ELAPSED", limits, text.length);
  }
  const started = performance.now();
  if (!isWellFormedUtf16(text)) return invalidUnicodeResult(text, limits);
  const inputBytes = Buffer.byteLength(text, "utf8");
  const stats = initialStats(inputBytes);
  if (inputBytes > limits.maxInputBytes) {
    return literalResult(
      text,
      "MACRO_LIMIT_INPUT",
      stats,
      limits.maxWarnings,
      limits.maxOutputBytes,
    );
  }
  if (performance.now() - started > limits.maxElapsedMs) {
    return literalResult(text, "MACRO_LIMIT_ELAPSED", stats, limits.maxWarnings);
  }
  const snapshot = snapshotContext(context, limits);
  const tokens = lexMacroTokens(text);
  stats.tokenCount = tokens.length;
  stats.operationCount = text.length + tokens.length;
  if (tokens.length > limits.maxTokens) {
    return literalResult(text, "MACRO_LIMIT_TOKENS", stats, limits.maxWarnings);
  }
  if (stats.operationCount > limits.maxOperations) {
    return literalResult(text, "MACRO_LIMIT_OPERATIONS", stats, limits.maxWarnings);
  }
  if (performance.now() - started > limits.maxElapsedMs) {
    return literalResult(text, "MACRO_LIMIT_ELAPSED", stats, limits.maxWarnings);
  }
  const ast = parseMacros(tokens, limits);
  const warningCollector = createWarningCollector(limits.maxWarnings);
  let haltedCode = null;

  function addWarning(warning) {
    warningCollector.add(warning);
  }

  function spendOperations(count = 1) {
    if (haltedCode) return false;
    stats.operationCount += count;
    if (stats.operationCount > limits.maxOperations) {
      haltedCode = "MACRO_LIMIT_OPERATIONS";
    } else if (performance.now() - started > limits.maxElapsedMs) {
      haltedCode = "MACRO_LIMIT_ELAPSED";
    }
    if (haltedCode) addWarning({ code: haltedCode });
    return !haltedCode;
  }

  function drawUniform(prng, upperExclusive) {
    try {
      const value = uniformInt(prng, upperExclusive, {
        maxDraws: limits.maxRandomDrawsPerChoice,
        reserveDraw() {
          if (!spendOperations()) return false;
          stats.randomDrawCount += 1;
          return true;
        },
      });
      if (value !== null) return { ok: true, value };
      return { ok: false, code: haltedCode || "MACRO_PRNG_EXHAUSTED" };
    } catch {
      return { ok: false, code: "MACRO_PRNG_ERROR" };
    }
  }

  // Each owner reserves first; its arguments then expand left-to-right.
  function evaluateNodes(nodes, byteLimit, topLevel = false) {
    const parts = [];
    let bytes = 0;
    let ok = true;
    let overflow = false;
    let outputLimited = false;
    let literalRemainder = false;

    function append(value) {
      const valueBytes = Buffer.byteLength(value, "utf8");
      if (bytes + valueBytes <= byteLimit) {
        parts.push(value);
        bytes += valueBytes;
        return true;
      }
      return false;
    }

    function appendRequired(value) {
      if (!append(value)) overflow = true;
    }

    for (const node of nodes) {
      if (overflow) break;
      if (literalRemainder) {
        appendRequired(node.source);
        continue;
      }
      if (haltedCode) {
        appendRequired(node.source);
        ok = false;
        continue;
      }
      if (node.type === "macro" && !HANDLER_NAMES.has(node.name)) {
        appendRequired(node.source);
        addWarning(warningFor(node, limits));
        ok = false;
        continue;
      }
      if (!spendOperations()) {
        appendRequired(node.source);
        ok = false;
        continue;
      }
      if (node.type === "text") {
        appendRequired(node.value);
        continue;
      }
      if (node.type === "limit") {
        appendRequired(node.source);
        addWarning({ code: node.code });
        ok = false;
        continue;
      }
      if (node.type === "malformed") {
        appendRequired(node.source);
        addWarning({ code: "MACRO_MALFORMED" });
        ok = false;
        continue;
      }
      stats.maxDepth = Math.max(stats.maxDepth, node.depth);
      if (Buffer.byteLength(node.name, "utf8") > limits.maxNameBytes) {
        appendRequired(node.source);
        addWarning({ code: "MACRO_LIMIT_NAME" });
        ok = false;
        continue;
      }
      if (node.args.length > limits.maxArgs) {
        appendRequired(node.source);
        addWarning({ code: "MACRO_LIMIT_ARGS", name: node.name });
        ok = false;
        continue;
      }
      const rawArgBytes = node.args.map((arg) => Buffer.byteLength(
        arg.map((child) => child.source).join(""),
        "utf8",
      ));
      if (rawArgBytes.some((bytes) => bytes > limits.maxArgBytes)
          || rawArgBytes.reduce((sum, bytes) => sum + bytes, 0) > limits.maxTotalArgBytes) {
        appendRequired(node.source);
        addWarning({ code: "MACRO_LIMIT_ARG_BYTES", name: node.name });
        ok = false;
        continue;
      }
      if (stats.expansionCount >= limits.maxExpansions) {
        appendRequired(node.source);
        addWarning({ code: "MACRO_LIMIT_EXPANSIONS" });
        ok = false;
        continue;
      }
      stats.expansionCount += 1;
      const evaluatedArgs = node.args.map((arg) => evaluateNodes(arg, limits.maxArgBytes));
      if (evaluatedArgs.some((arg) => !arg.ok || arg.overflow)) {
        appendRequired(node.source);
        if (evaluatedArgs.some((arg) => arg.overflow)) {
          addWarning({ code: "MACRO_LIMIT_ARG_BYTES", name: node.name });
        }
        ok = false;
        continue;
      }
      const args = evaluatedArgs.map((arg) => arg.text);
      const expandedArgBytes = args.map((arg) => Buffer.byteLength(arg, "utf8"));
      if (expandedArgBytes.some((bytes) => bytes > limits.maxArgBytes)
          || expandedArgBytes.reduce((sum, bytes) => sum + bytes, 0) > limits.maxTotalArgBytes) {
        appendRequired(node.source);
        addWarning({ code: "MACRO_LIMIT_ARG_BYTES", name: node.name });
        ok = false;
        continue;
      }
      if (!snapshot.ok) {
        appendRequired(node.source);
        addWarning({ code: "MACRO_CONTEXT_INVALID" });
        ok = false;
        continue;
      }
      if (!spendOperations()) {
        appendRequired(node.source);
        ok = false;
        continue;
      }
      let value = null;
      try {
      if (node.name === "user" || node.name === "char" || node.name === "original") {
        if (args.length === 0) value = snapshot.value[node.name] || "";
      } else if (node.name === "random" || node.name === "pick") {
        if (args.length > 0 && args.every((arg) => arg.length > 0)) {
          const prng = createMacroPrng(snapshot.value.seed, node.occurrence);
          const selected = drawUniform(prng, args.length);
          if (!selected.ok) {
            appendRequired(node.source);
            addWarning({ code: selected.code });
            ok = false;
            continue;
          }
          value = args[selected.value];
        }
      } else if (node.name === "trim" || node.name === "uppercase" || node.name === "lowercase") {
        if (args.length === 1) {
          if (node.name === "trim") value = args[0].trim();
          else if (node.name === "uppercase") value = args[0].toUpperCase();
          else value = args[0].toLowerCase();
        }
      } else if (node.name === "idle_duration") {
        if (args.length === 0 && snapshot.value.idleDuration !== undefined) {
          value = formatIdleDuration(snapshot.value.idleDuration);
        }
      } else if (node.name === "roll") {
        if (args.length === 1) {
          const dice = parseDice(args[0], limits);
          if (!dice) {
            appendRequired(node.source);
            addWarning({ code: "MACRO_DICE_INVALID", name: "roll" });
            ok = false;
            continue;
          }
          const prng = createMacroPrng(snapshot.value.seed, node.occurrence);
          let total = dice.modifier;
          let rollFailure = null;
          for (let die = 0; die < dice.count; die += 1) {
            const rolled = drawUniform(prng, dice.sides);
            if (!rolled.ok) {
              rollFailure = rolled.code;
              break;
            }
            total += rolled.value + 1;
          }
          if (rollFailure) {
            appendRequired(node.source);
            addWarning({ code: rollFailure });
            ok = false;
            continue;
          }
          if (!haltedCode) value = String(total);
        }
      } else if (["time", "date", "weekday", "isotime", "isodate"].includes(node.name)) {
        if (args.length === 0) value = formatDateMacro(snapshot.value, node.name);
      }
      if (!spendOperations()) {
        appendRequired(node.source);
        ok = false;
        continue;
      }
      if (haltedCode) {
        appendRequired(node.source);
        ok = false;
        continue;
      }
      if (value === null) {
        appendRequired(node.source);
        addWarning({
          code: ["time", "date", "weekday", "isotime", "isodate", "idle_duration"].includes(node.name)
            ? "MACRO_CONTEXT_INVALID"
            : "MACRO_ARGUMENT_INVALID",
          ...(node.name === "idle_duration" ? {} : { name: node.name }),
        });
        ok = false;
        continue;
      }
      if (!append(value)) {
        if (!topLevel) {
          overflow = true;
          ok = false;
          break;
        }
        outputLimited = true;
        addWarning({ code: "MACRO_LIMIT_OUTPUT" });
        appendRequired(node.source);
        literalRemainder = true;
        ok = false;
      }
      } catch {
        appendRequired(node.source);
        addWarning({ code: "MACRO_HANDLER_ERROR" });
        spendOperations();
        ok = false;
      }
    }
    return {
      bytes,
      ok,
      outputLimited,
      overflow,
      text: parts.join(""),
    };
  }
  const evaluated = evaluateNodes(ast, limits.maxOutputBytes, true);
  let expanded = evaluated.text;
  if (evaluated.overflow) {
    if (!evaluated.outputLimited) addWarning({ code: "MACRO_LIMIT_OUTPUT" });
    expanded = inputBytes <= limits.maxOutputBytes ? text : "";
  }
  stats.outputBytes = Buffer.byteLength(expanded, "utf8");
  return {
    text: expanded,
    warnings: warningCollector.list(),
    stats,
  };
}

function expandSafeMacros(text, context, overrides) {
  let limits;
  try {
    const resolved = resolveMacroLimits(overrides);
    if (!resolved.ok) {
      return emptyFailureResult("MACRO_LIMITS_INVALID", resolved.limits);
    }
    limits = resolved.limits;
    return expandSafeMacrosInternal(text, context, limits);
  } catch {
    const fallbackLimits = limits || DEFAULT_MACRO_LIMITS;
    try {
      if (typeof text === "string") {
        if (!isWellFormedUtf16(text)) {
          return invalidUnicodeResult(text, fallbackLimits);
        }
        return literalResult(
          text,
          "MACRO_INTERNAL_ERROR",
          initialStats(Buffer.byteLength(text, "utf8")),
          fallbackLimits.maxWarnings,
          fallbackLimits.maxOutputBytes,
        );
      }
    } catch {
      // Fall through to a non-echoing result.
    }
    return {
      text: "",
      warnings: fallbackLimits.maxWarnings > 0 ? [{ code: "MACRO_INTERNAL_ERROR" }] : [],
      stats: initialStats(),
    };
  }
}

module.exports = {
  DEFAULT_MACRO_LIMITS,
  expandSafeMacros,
  lexMacros,
  parseMacros,
};
