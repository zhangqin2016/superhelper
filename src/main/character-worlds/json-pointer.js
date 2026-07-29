"use strict";

function escapePointerToken(token) {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

class JsonPointerStack {
  constructor() {
    this.tokens = [];
    this.pathBytes = 0;
  }

  push(token) {
    const escaped = escapePointerToken(token);
    const serialized = JSON.stringify(escaped);
    const bytes = 1 + Buffer.byteLength(serialized, "utf8") - 2;
    this.tokens.push({ escaped, bytes });
    this.pathBytes += bytes;
  }

  pop() {
    const token = this.tokens.pop();
    if (token) this.pathBytes -= token.bytes;
  }

  toString() {
    if (this.tokens.length === 0) return "";
    return `/${this.tokens.map((token) => token.escaped).join("/")}`;
  }
}

function pointerForField(field) {
  if (field === "" || field.startsWith("/")) return field;
  return `/${escapePointerToken(field)}`;
}

module.exports = {
  escapePointerToken,
  JsonPointerStack,
  pointerForField,
};
