"use strict";

const { TextDecoder } = require("node:util");
const { cardError, limitError, resolveImportLimits } = require("./import-limits");
const { JsonPointerStack } = require("./json-pointer");
const { ParseBudget } = require("./parse-budget");

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const STRING_PART_BATCH = 1024;

function isDigit(char) {
  return char >= "0" && char <= "9";
}

function lexemeIsInteger(lexeme, value) {
  if (!Number.isSafeInteger(value)) return false;
  const match = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(lexeme);
  if (!match) return false;
  const coefficient = `${match[1]}${match[2] || ""}`;
  if (/^0+$/.test(coefficient)) return true;
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent)) return false;
  const scale = (match[2]?.length || 0) - exponent;
  if (scale <= 0) return true;
  if (scale > coefficient.length) return false;
  return /^0+$/.test(coefficient.slice(coefficient.length - scale));
}

class StringAccumulator {
  constructor() {
    this.chunks = [];
    this.pending = [];
  }

  add(value) {
    if (!value) return;
    this.pending.push(value);
    if (this.pending.length >= STRING_PART_BATCH) this.flush();
  }

  flush() {
    if (this.pending.length === 0) return;
    this.chunks.push(this.pending.join(""));
    this.pending.length = 0;
  }

  finish() {
    this.flush();
    return this.chunks.length === 1 ? this.chunks[0] : this.chunks.join("");
  }
}

class BoundedJsonParser {
  constructor(text, limits, budget) {
    this.text = text;
    this.limits = limits;
    this.budget = budget;
    this.index = 0;
    this.pointer = new JsonPointerStack();
    this.numberLexemes = Object.create(null);
    this.numberLexemeCount = 0;
    this.numberLexemePathBytes = 0;
    this.counts = {
      objects: 0,
      members: 0,
      arrays: 0,
      strings: 0,
      keys: 0,
      totalStringChars: 0,
      totalKeyChars: 0,
      totalStringBytes: 0,
      totalKeyBytes: 0,
    };
  }

  currentPath() {
    return this.pointer.toString();
  }

  invalid() {
    throw cardError("CARD_JSON_INVALID", "Character card contains invalid JSON", {
      path: this.currentPath(),
    });
  }

  bump(counter, limit, amount = 1) {
    this.counts[counter] += amount;
    const maximum = this.limits[limit];
    if (this.counts[counter] > maximum) {
      throw limitError(limit, maximum, this.counts[counter], this.currentPath());
    }
  }

  parse() {
    this.budget.consume(1);
    this.skipWhitespace();
    if (this.index >= this.text.length) this.invalid();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.invalid();
    this.freezeValue(value);
    const numberLexemes = Object.freeze(Object.keys(this.numberLexemes).sort().map((pointer) => (
      Object.freeze({ pointer, lexeme: this.numberLexemes[pointer] })
    )));
    this.budget.check(true);
    return Object.freeze({
      schemaVersion: 1,
      data: value,
      numberLexemes,
    });
  }

  freezeValue(value) {
    this.budget.consume(1);
    if (!value || typeof value !== "object") return;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      this.freezeValue(child);
    }
    Object.freeze(value);
  }

  skipWhitespace() {
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      this.index += 1;
      this.budget.consume(1);
    }
  }

  parseValue(depth) {
    this.budget.consume(1);
    const char = this.text[this.index];
    if (char === "{") return this.parseObject(depth + 1);
    if (char === "[") return this.parseArray(depth + 1);
    if (char === '"') return this.parseString(false);
    if (char === "t") return this.parseLiteral("true", true);
    if (char === "f") return this.parseLiteral("false", false);
    if (char === "n") return this.parseLiteral("null", null);
    if (char === "-" || isDigit(char)) return this.parseNumber();
    return this.invalid();
  }

  checkDepth(depth) {
    if (depth > this.limits.maxDepth) {
      throw cardError("CARD_DEPTH_EXCEEDED", "Character card JSON is too deeply nested", {
        limit: "maxDepth",
        maximum: this.limits.maxDepth,
        actual: depth,
        path: this.currentPath(),
      });
    }
  }

  parseObject(depth) {
    this.checkDepth(depth);
    this.bump("objects", "maxObjects");
    const result = Object.create(null);
    const keys = new Set();
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== '"') this.invalid();
      const key = this.parseString(true);
      this.pointer.push(key);
      if (keys.has(key)) {
        throw cardError("CARD_DUPLICATE_KEY", "Character card JSON contains a duplicate key", {
          path: this.currentPath(),
        });
      }
      keys.add(key);
      if (DANGEROUS_KEYS.has(key)) {
        throw cardError("CARD_DANGEROUS_KEY", "Character card JSON contains a dangerous key", {
          path: this.currentPath(),
        });
      }
      this.bump("members", "maxMembers");
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.invalid();
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.pointer.pop();
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "}") {
        this.index += 1;
        return result;
      }
      if (separator !== ",") this.invalid();
      this.index += 1;
      this.skipWhitespace();
    }
    return this.invalid();
  }

  parseArray(depth) {
    this.checkDepth(depth);
    this.bump("arrays", "maxArrays");
    const result = [];
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      if (result.length + 1 > this.limits.maxArrayLength) {
        throw limitError(
          "maxArrayLength",
          this.limits.maxArrayLength,
          result.length + 1,
          this.currentPath(),
        );
      }
      this.pointer.push(result.length);
      result.push(this.parseValue(depth));
      this.pointer.pop();
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "]") {
        this.index += 1;
        return result;
      }
      if (separator !== ",") this.invalid();
      this.index += 1;
      this.skipWhitespace();
    }
    return this.invalid();
  }

  checkStringSize(next, isKey) {
    const charLimit = isKey ? "maxKeyChars" : "maxStringChars";
    const byteLimit = isKey ? "maxKeyBytes" : "maxStringBytes";
    if (next.bytes > this.limits[byteLimit]) {
      throw limitError(
        byteLimit,
        this.limits[byteLimit],
        next.bytes,
        this.currentPath(),
      );
    }
    if (next.chars > this.limits[charLimit]) {
      throw limitError(
        charLimit,
        this.limits[charLimit],
        next.chars,
        this.currentPath(),
      );
    }
  }

  parseString(isKey) {
    this.index += 1;
    this.budget.consume(1);
    const output = new StringAccumulator();
    let size = { chars: 0, bytes: 0 };
    while (this.index < this.text.length) {
      const start = this.index;
      while (this.index < this.text.length) {
        const code = this.text.charCodeAt(this.index);
        if (code === 0x22 || code === 0x5c || code < 0x20) break;
        if (code >= 0xd800 && code <= 0xdbff) {
          const low = this.text.charCodeAt(this.index + 1);
          if (low < 0xdc00 || low > 0xdfff) this.invalid();
          this.index += 2;
          size.chars += 1;
          size.bytes += 4;
          this.budget.consume(2);
        } else {
          if (code >= 0xdc00 && code <= 0xdfff) this.invalid();
          this.index += 1;
          size.chars += 1;
          size.bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
          this.budget.consume(1);
        }
        this.checkStringSize(size, isKey);
      }
      output.add(this.text.slice(start, this.index));
      const char = this.text[this.index];
      if (char === '"') {
        this.index += 1;
        this.budget.consume(1);
        const value = output.finish();
        if (isKey) {
          this.bump("keys", "maxKeys");
          this.bump("totalKeyChars", "maxTotalKeyChars", size.chars);
          this.bump("totalKeyBytes", "maxTotalKeyBytes", size.bytes);
        } else {
          this.bump("strings", "maxStrings");
          this.bump("totalStringChars", "maxTotalStringChars", size.chars);
          this.bump("totalStringBytes", "maxTotalStringBytes", size.bytes);
        }
        return value;
      }
      if (char !== "\\") this.invalid();
      const value = this.parseEscape();
      size.chars += 1;
      size.bytes += Buffer.byteLength(value, "utf8");
      this.checkStringSize(size, isKey);
      output.add(value);
    }
    return this.invalid();
  }

  parseEscape() {
    this.index += 1;
    this.budget.consume(1);
    const escaped = this.text[this.index];
    const simple = {
      '"': '"', "\\": "\\", "/": "/", b: "\b",
      f: "\f", n: "\n", r: "\r", t: "\t",
    };
    if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
      this.index += 1;
      this.budget.consume(1);
      return simple[escaped];
    }
    if (escaped !== "u") return this.invalid();
    const hex = this.text.slice(this.index + 1, this.index + 5);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return this.invalid();
    this.index += 5;
    this.budget.consume(5);
    const code = Number.parseInt(hex, 16);
    if (code >= 0xdc00 && code <= 0xdfff) return this.invalid();
    if (code < 0xd800 || code > 0xdbff) return String.fromCharCode(code);
    if (this.text[this.index] !== "\\" || this.text[this.index + 1] !== "u") {
      return this.invalid();
    }
    const lowHex = this.text.slice(this.index + 2, this.index + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) return this.invalid();
    const low = Number.parseInt(lowHex, 16);
    if (low < 0xdc00 || low > 0xdfff) return this.invalid();
    this.index += 6;
    this.budget.consume(6);
    return String.fromCodePoint(0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00));
  }

  parseLiteral(source, value) {
    if (this.text.slice(this.index, this.index + source.length) !== source) {
      return this.invalid();
    }
    this.index += source.length;
    this.budget.consume(source.length);
    return value;
  }

  recordNumber(lexeme) {
    const nextCount = this.numberLexemeCount + 1;
    if (nextCount > this.limits.maxNumberLexemes) {
      throw limitError(
        "maxNumberLexemes",
        this.limits.maxNumberLexemes,
        nextCount,
        this.currentPath(),
      );
    }
    const nextPathBytes = this.numberLexemePathBytes + this.pointer.pathBytes;
    if (nextPathBytes > this.limits.maxNumberLexemePathBytes) {
      throw limitError(
        "maxNumberLexemePathBytes",
        this.limits.maxNumberLexemePathBytes,
        nextPathBytes,
        this.currentPath(),
      );
    }
    this.numberLexemeCount = nextCount;
    this.numberLexemePathBytes = nextPathBytes;
    this.numberLexemes[this.currentPath()] = lexeme;
  }

  parseNumber() {
    const start = this.index;
    let budgetIndex = start;
    const pollBudget = () => {
      if (this.index - budgetIndex < 4096) return;
      this.budget.consume(this.index - budgetIndex);
      budgetIndex = this.index;
    };
    if (this.text[this.index] === "-") this.index += 1;
    if (this.text[this.index] === "0") {
      this.index += 1;
      if (isDigit(this.text[this.index])) this.invalid();
    } else {
      if (this.text[this.index] < "1" || this.text[this.index] > "9") this.invalid();
      while (isDigit(this.text[this.index])) {
        this.index += 1;
        pollBudget();
      }
    }
    if (this.text[this.index] === ".") {
      this.index += 1;
      if (!isDigit(this.text[this.index])) this.invalid();
      while (isDigit(this.text[this.index])) {
        this.index += 1;
        pollBudget();
      }
    }
    if (this.text[this.index] === "e" || this.text[this.index] === "E") {
      this.index += 1;
      if (this.text[this.index] === "+" || this.text[this.index] === "-") this.index += 1;
      if (!isDigit(this.text[this.index])) this.invalid();
      while (isDigit(this.text[this.index])) {
        this.index += 1;
        pollBudget();
      }
    }
    const lexeme = this.text.slice(start, this.index);
    const value = Number(lexeme);
    this.budget.consume(this.index - budgetIndex);
    this.recordNumber(lexeme);
    return Number.isFinite(value) && lexemeIsInteger(lexeme, value) ? value : null;
  }
}

function decodeJsonDocument(buffer, overrides = {}, budget = null) {
  const limits = resolveImportLimits(overrides);
  const parseBudget = budget || new ParseBudget(limits);
  parseBudget.consume(1);
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new TypeError("Character card JSON must be a Buffer or Uint8Array");
  }
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.length > limits.maxContainerBytes) {
    throw cardError("CARD_TOO_LARGE", "Character card container is too large", {
      limit: "maxContainerBytes",
      maximum: limits.maxContainerBytes,
      actual: bytes.length,
      path: "",
    });
  }
  const jsonBytes = bytes.subarray(bytes.subarray(0, 3).equals(UTF8_BOM) ? 3 : 0);
  if (jsonBytes.length > limits.maxJsonBytes) {
    throw cardError("CARD_TOO_LARGE", "Character card JSON is too large", {
      limit: "maxJsonBytes",
      maximum: limits.maxJsonBytes,
      actual: jsonBytes.length,
      path: "",
    });
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(jsonBytes);
  } catch {
    throw cardError("CARD_UTF8_INVALID", "Character card is not valid UTF-8", { path: "" });
  }
  parseBudget.consume(jsonBytes.length);
  return new BoundedJsonParser(text, limits, parseBudget).parse();
}

function decodeJsonBuffer(buffer, overrides = {}) {
  return decodeJsonDocument(buffer, overrides);
}

module.exports = {
  decodeJsonBuffer,
  decodeJsonDocument,
};
