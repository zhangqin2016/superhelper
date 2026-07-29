"use strict";

const { performance } = require("node:perf_hooks");
const { cardError } = require("./import-limits");

const ELAPSED_CHECK_INTERVAL = 4096;

class ParseBudget {
  constructor(limits) {
    this.limits = limits;
    this.startedAt = performance.now();
    this.operations = 0;
    this.nextElapsedCheck = 0;
  }

  fail(reason, details = {}) {
    throw cardError("CARD_PARSE_TIMEOUT", "Character card parsing budget was exhausted", {
      reason,
      path: "",
      ...details,
    });
  }

  consume(amount = 1) {
    this.operations += amount;
    if (this.operations > this.limits.maxParseOperations) {
      this.fail("operation_budget", {
        limit: "maxParseOperations",
        maximum: this.limits.maxParseOperations,
        actual: this.operations,
      });
    }
    if (this.operations >= this.nextElapsedCheck) this.check();
  }

  check(force = false) {
    if (!force && this.operations < this.nextElapsedCheck) return;
    const elapsed = performance.now() - this.startedAt;
    if (elapsed >= this.limits.maxParseElapsedMs) {
      this.fail("elapsed_budget", {
        limit: "maxParseElapsedMs",
        maximum: this.limits.maxParseElapsedMs,
        actual: Math.ceil(elapsed),
      });
    }
    this.nextElapsedCheck = this.operations + ELAPSED_CHECK_INTERVAL;
  }
}

module.exports = {
  ParseBudget,
};
