"use strict";

const { performance } = require("node:perf_hooks");
const { resolveMacroLimits } = require("./macro-limits");
const { isWellFormedUtf16 } = require("./macro-unicode");

const NAME_START = /^[A-Za-z_]$/;
const NAME_CONTINUE = /^[A-Za-z0-9_]$/;

function validName(name) {
  if (!name || !NAME_START.test(name[0])) return false;
  for (let index = 1; index < name.length; index += 1) {
    if (!NAME_CONTINUE.test(name[index])) return false;
  }
  return true;
}

function lexMacroTokens(text) {
  const tokens = [];
  let raw = "";
  let value = "";
  let escapedMacroDepth = 0;

  function flushText() {
    if (!raw) return;
    tokens.push({ type: "text", raw, value });
    raw = "";
    value = "";
  }

  for (let index = 0; index < text.length;) {
    const pair = text.slice(index, index + 2);
    const escapedPair = text.slice(index + 1, index + 3);
    if (text[index] === "\\" && (
      escapedPair === "{{"
      || escapedPair === "}}"
      || escapedPair === "::"
      || text[index + 1] === "\\"
    )) {
      const decoded = text[index + 1] === "\\" ? "\\" : escapedPair;
      const width = text[index + 1] === "\\" ? 2 : 3;
      raw += text.slice(index, index + width);
      value += decoded;
      if (escapedPair === "{{") escapedMacroDepth += 1;
      else if (escapedPair === "}}" && escapedMacroDepth > 0) escapedMacroDepth -= 1;
      index += width;
      continue;
    }
    if (escapedMacroDepth > 0) {
      raw += text[index];
      value += text[index];
      if (pair === "{{") {
        raw += text[index + 1];
        value += text[index + 1];
        escapedMacroDepth += 1;
        index += 2;
      } else if (pair === "}}") {
        raw += text[index + 1];
        value += text[index + 1];
        escapedMacroDepth -= 1;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    let type = null;
    if (pair === "{{") type = "open";
    else if (pair === "}}") type = "close";
    else if (pair === "::") type = "separator";
    if (type) {
      flushText();
      tokens.push({ type, raw: pair, value: pair });
      index += 2;
      continue;
    }
    raw += text[index];
    value += text[index];
    index += 1;
  }
  flushText();
  return tokens;
}

function macroLexError(code) {
  const error = new RangeError(code);
  error.code = code;
  return error;
}

function lexMacros(text, overrides) {
  const resolved = resolveMacroLimits(overrides);
  if (!resolved.ok) throw macroLexError("MACRO_LIMITS_INVALID");
  const { limits } = resolved;
  if (typeof text !== "string") throw macroLexError("MACRO_INPUT_INVALID");
  if (text.length > limits.maxInputBytes) throw macroLexError("MACRO_LIMIT_INPUT");
  if (limits.maxElapsedMs === 0) throw macroLexError("MACRO_LIMIT_ELAPSED");

  const started = performance.now();
  if (!isWellFormedUtf16(text)) throw macroLexError("MACRO_INPUT_UNICODE_INVALID");
  if (Buffer.byteLength(text, "utf8") > limits.maxInputBytes) {
    throw macroLexError("MACRO_LIMIT_INPUT");
  }
  if (performance.now() - started > limits.maxElapsedMs) {
    throw macroLexError("MACRO_LIMIT_ELAPSED");
  }
  const tokens = lexMacroTokens(text);
  if (tokens.length > limits.maxTokens) throw macroLexError("MACRO_LIMIT_TOKENS");
  if (performance.now() - started > limits.maxElapsedMs) {
    throw macroLexError("MACRO_LIMIT_ELAPSED");
  }
  return tokens;
}

function parseMacros(tokens, limits = {}) {
  let index = 0;
  let occurrence = 0;
  const maxNesting = Number.isSafeInteger(limits.maxNesting)
    ? limits.maxNesting
    : 8;

  function sourceBetween(start, end = index) {
    return tokens.slice(start, end).map((token) => token.raw).join("");
  }

  function textNode(token, malformed = false) {
    return {
      type: malformed ? "malformed" : "text",
      source: token.raw,
      value: malformed ? token.raw : token.value,
    };
  }

  function parseMacro(depth) {
    const start = index;
    const macroOccurrence = occurrence;
    occurrence += 1;
    if (depth > maxNesting) {
      let balance = 0;
      do {
        if (tokens[index].type === "open") balance += 1;
        else if (tokens[index].type === "close") balance -= 1;
        index += 1;
      } while (index < tokens.length && balance > 0);
      return {
        type: "limit",
        code: "MACRO_LIMIT_NESTING",
        source: sourceBetween(start),
      };
    }
    index += 1;
    let name = "";
    let invalidNameSyntax = false;

    while (index < tokens.length
      && tokens[index].type !== "separator"
      && tokens[index].type !== "close") {
      const token = tokens[index];
      if (token.type !== "text") invalidNameSyntax = true;
      name += token.value;
      index += 1;
    }

    const normalizedName = name.trim().toLowerCase();
    const args = [];
    while (index < tokens.length && tokens[index].type === "separator") {
      index += 1;
      const nodes = [];
      while (index < tokens.length
        && tokens[index].type !== "separator"
        && tokens[index].type !== "close") {
        if (tokens[index].type === "open") nodes.push(parseMacro(depth + 1));
        else {
          nodes.push(textNode(tokens[index], tokens[index].type !== "text"));
          index += 1;
        }
      }
      args.push(nodes);
    }

    if (index >= tokens.length || tokens[index].type !== "close") {
      return {
        type: "malformed",
        source: sourceBetween(start),
        value: sourceBetween(start),
      };
    }
    index += 1;
    const source = sourceBetween(start);
    if (invalidNameSyntax || !validName(normalizedName)) {
      return { type: "malformed", source, value: source };
    }
    return {
      type: "macro",
      args,
      depth,
      name: normalizedName,
      occurrence: macroOccurrence,
      source,
    };
  }

  function parseDocument() {
    const nodes = [];
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.type === "open") nodes.push(parseMacro(1));
      else if (token.type === "close") {
        nodes.push(textNode(token, true));
        index += 1;
      } else {
        nodes.push(textNode(token));
        index += 1;
      }
    }
    return nodes;
  }

  return parseDocument();
}

module.exports = {
  lexMacroTokens,
  lexMacros,
  parseMacros,
};
