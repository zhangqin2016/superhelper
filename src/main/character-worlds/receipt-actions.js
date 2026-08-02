"use strict";

const crypto = require("node:crypto");

class ReceiptActionBroker {
  constructor({ now = Date.now, ttlMs = 15 * 60 * 1000, maxTokens = 512 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxTokens = maxTokens;
    this.tokens = new Map();
  }

  issue({ ownerScope, sessionId, receiptId, action }) {
    this._prune();
    while (this.tokens.size >= this.maxTokens) this.tokens.delete(this.tokens.keys().next().value);
    const token = crypto.randomBytes(32).toString("base64url");
    this.tokens.set(token, {
      ownerScope, sessionId, receiptId, action,
      expiresAt: Number(this.now()) + this.ttlMs,
    });
    return token;
  }

  consume({ token, ownerScope, sessionId, receiptId, action }) {
    this._prune();
    const value = this.tokens.get(token);
    if (!value || value.ownerScope !== ownerScope || value.sessionId !== sessionId
      || value.receiptId !== receiptId || value.action !== action) return false;
    if (action !== "view") this.tokens.delete(token);
    return true;
  }

  take({ token, ownerScope, sessionId, action }) {
    this._prune();
    const value = this.tokens.get(token);
    if (!value || value.ownerScope !== ownerScope || value.sessionId !== sessionId
      || value.action !== action) return null;
    this.tokens.delete(token);
    return { ...value };
  }

  _prune() {
    const now = Number(this.now());
    for (const [token, value] of this.tokens) {
      if (value.expiresAt <= now) this.tokens.delete(token);
    }
  }
}

module.exports = { ReceiptActionBroker };
