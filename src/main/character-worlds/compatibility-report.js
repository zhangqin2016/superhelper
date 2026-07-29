"use strict";

const { cardError } = require("./import-limits");

const CATEGORIES = [
  "supported",
  "migrated",
  "preservedInert",
  "ignoredInvalid",
  "rejectedExecutable",
];

const BUDGET_LIMITS = {
  supported: ["maxReportSupportedEntries", "maxReportSupportedPathBytes"],
  migrated: ["maxReportMigratedEntries", "maxReportMigratedPathBytes"],
  preservedInert: ["maxReportPreservedInertEntries", "maxReportPreservedInertPathBytes"],
  ignoredInvalid: ["maxReportIgnoredInvalidEntries", "maxReportIgnoredInvalidPathBytes"],
  rejectedExecutable: [
    "maxReportRejectedExecutableEntries",
    "maxReportRejectedExecutablePathBytes",
  ],
};

function emptyCounts() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
}

class CompatibilityReport {
  constructor(limits) {
    this.limits = limits;
    this.paths = Object.fromEntries(CATEGORIES.map((category) => [category, new Set()]));
    this.owners = new Map();
    this.observed = emptyCounts();
    this.omitted = emptyCounts();
    this.categoryEntries = emptyCounts();
    this.categoryPathBytes = emptyCounts();
    this.entryCount = 0;
    this.pathBytes = 0;
  }

  add(category, pointerStack) {
    if (!this.paths[category]) throw new TypeError("Unknown compatibility report bucket");
    this.observed[category] += 1;
    const [entryLimit, pathLimit] = BUDGET_LIMITS[category];
    const nextEntries = this.entryCount + 1;
    const nextPathBytes = this.pathBytes + pointerStack.pathBytes;
    const nextCategoryEntries = this.categoryEntries[category] + 1;
    const nextCategoryPathBytes = this.categoryPathBytes[category] + pointerStack.pathBytes;
    if (
      nextEntries > this.limits.maxReportEntries
      || nextPathBytes > this.limits.maxReportPathBytes
      || nextCategoryEntries > this.limits[entryLimit]
      || nextCategoryPathBytes > this.limits[pathLimit]
    ) {
      this.omitted[category] += 1;
      return;
    }
    const pointer = pointerStack.toString();
    const owner = this.owners.get(pointer);
    if (owner) {
      this.observed[category] -= 1;
      if (owner !== category) {
        throw cardError(
          "CARD_JSON_INVALID",
          "Compatibility pointer was classified more than once",
          { path: pointer },
        );
      }
      return;
    }
    this.owners.set(pointer, category);
    this.paths[category].add(pointer);
    this.entryCount = nextEntries;
    this.pathBytes = nextPathBytes;
    this.categoryEntries[category] = nextCategoryEntries;
    this.categoryPathBytes[category] = nextCategoryPathBytes;
  }

  finalize() {
    const result = Object.fromEntries(CATEGORIES.map((category) => (
      [category, [...this.paths[category]].sort()]
    )));
    result.counts = { ...this.observed };
    if (this.observed.rejectedExecutable > 0 || this.observed.ignoredInvalid > 0) {
      result.level = "safe_behavior";
    } else if (this.observed.preservedInert > 0) {
      result.level = "preserved_inert";
    } else {
      result.level = "lossless_data";
    }
    const omittedEntries = Object.values(this.omitted).reduce((sum, count) => sum + count, 0);
    result.truncation = omittedEntries > 0
      ? { omittedEntries, omittedByBucket: { ...this.omitted } }
      : null;
    result.warnings = omittedEntries > 0
      ? [{
          code: "COMPATIBILITY_REPORT_TRUNCATED",
          omittedEntries,
          omittedByBucket: { ...this.omitted },
        }]
      : [];
    return result;
  }
}

module.exports = {
  CompatibilityReport,
};
