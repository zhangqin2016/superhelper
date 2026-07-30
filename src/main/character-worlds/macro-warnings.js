"use strict";

const CATEGORY_PRIORITY = ["error", "blocked", "unknown"];

function categoryOf(warning) {
  if (warning.code === "MACRO_UNKNOWN") return "unknown";
  if (warning.code === "MACRO_BLOCKED") return "blocked";
  return "error";
}

function createWarningCollector(maxWarnings) {
  const events = [];
  const counts = { blocked: 0, error: 0, unknown: 0 };
  let sequence = 0;

  function add(warning) {
    const category = categoryOf(warning);
    counts[category] += 1;
    if (events.filter((event) => event.category === category).length < maxWarnings) {
      events.push({ category, sequence, warning });
    }
    sequence += 1;
  }

  function list() {
    const total = counts.blocked + counts.error + counts.unknown;
    if (maxWarnings === 0) return [];
    if (total <= maxWarnings) {
      return events
        .slice()
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => event.warning);
    }

    const activeCategories = CATEGORY_PRIORITY.filter((category) => counts[category] > 0);
    const includeSummary = maxWarnings > activeCategories.length;
    const concreteCapacity = maxWarnings - (includeSummary ? 1 : 0);
    const selected = [];
    const selectedEvents = new Set();

    for (const category of activeCategories) {
      if (selected.length >= concreteCapacity) break;
      const event = events.find((candidate) => candidate.category === category);
      if (event) {
        selected.push(event);
        selectedEvents.add(event);
      }
    }
    for (const category of CATEGORY_PRIORITY) {
      for (const event of events) {
        if (selected.length >= concreteCapacity) break;
        if (event.category === category && !selectedEvents.has(event)) {
          selected.push(event);
          selectedEvents.add(event);
        }
      }
    }
    selected.sort((left, right) => left.sequence - right.sequence);
    const selectedCounts = { blocked: 0, error: 0, unknown: 0 };
    for (const event of selected) selectedCounts[event.category] += 1;
    const omitted = {
      blocked: counts.blocked - selectedCounts.blocked,
      error: counts.error - selectedCounts.error,
      unknown: counts.unknown - selectedCounts.unknown,
    };
    const warnings = selected.map((event) => event.warning);
    if (includeSummary) {
      warnings.push({ code: "MACRO_WARNINGS_TRUNCATED", counts: omitted });
    }
    return warnings;
  }

  return Object.freeze({ add, list });
}

module.exports = {
  createWarningCollector,
};
