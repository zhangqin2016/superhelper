"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PLAN_PREVIEW_MAX = 8000;

function readPlanFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 512 * 1024) return "";
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function collectCandidatePaths(input) {
  if (!input || typeof input !== "object") return [];
  /** @type {string[]} */
  const paths = [];
  const keys = [
    "plan_path",
    "planPath",
    "plan_file",
    "planFile",
    "file_path",
    "filePath",
    "path",
  ];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) paths.push(value.trim());
  }
  if (typeof input.plan === "string" && input.plan.includes("/")) {
    const maybe = input.plan.trim();
    if (maybe.endsWith(".md") || maybe.includes("plans/")) paths.push(maybe);
  }
  return paths;
}

/**
 * @param {Record<string, unknown>} input
 * @param {string} [description]
 */
function resolvePlanPreview(input = {}, description = "") {
  if (typeof input.plan === "string" && input.plan.trim()) {
    const inline = input.plan.trim();
    if (!inline.includes("\n") && (inline.endsWith(".md") || inline.includes("/"))) {
      const fromFile = readPlanFile(inline);
      if (fromFile) return fromFile.slice(0, PLAN_PREVIEW_MAX);
    }
    return inline.slice(0, PLAN_PREVIEW_MAX);
  }

  if (typeof input.summary === "string" && input.summary.trim()) {
    return input.summary.trim().slice(0, PLAN_PREVIEW_MAX);
  }

  for (const candidate of collectCandidatePaths(input)) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(candidate);
    const fromFile = readPlanFile(resolved);
    if (fromFile) return fromFile.slice(0, PLAN_PREVIEW_MAX);
  }

  if (typeof description === "string" && description.trim()) {
    return description.trim().slice(0, PLAN_PREVIEW_MAX);
  }

  return "";
}

module.exports = { resolvePlanPreview, PLAN_PREVIEW_MAX };
