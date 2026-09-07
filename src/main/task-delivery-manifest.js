"use strict";
const fs = require("node:fs");
const path = require("node:path");

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeDeliverables(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).slice(0, 12).flatMap(item => {
    const value = typeof item === "string" ? item : item?.path;
    if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\0\r\n]/.test(value)) return [];
    const normalized = typeof item === "string" ? value.trim() : { path: value.trim() };
    const key = JSON.stringify(normalized);
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

// Resolve existing ancestors as well: a missing file below a symlink is not
// permission to create a file outside the task workspace.
function physical(file) {
  try { return fs.realpathSync(file); } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) return "";
    const parent = path.dirname(file);
    if (parent === file) return "";
    const resolved = physical(parent);
    return resolved ? path.join(resolved, path.basename(file)) : "";
  }
}

function inspectDeliverables(deliverables = [], workspacePath = "") {
  const root = workspacePath && path.isAbsolute(workspacePath) ? physical(workspacePath) : "";
  const seen = new Set();
  return (Array.isArray(deliverables) ? deliverables : []).slice(0, 64).flatMap(item => {
    const explicit = item && typeof item === "object";
    const value = explicit ? item.path : item;
    if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\n\r\0]/.test(value)) return [];
    const name = value.trim();
    // Free-form labels are not paths. Typed paths need no extension whitelist.
    if (!explicit && !path.isAbsolute(name) && !/^(?:\.\.?\/)?[^<>:]+\.[\w-]{1,16}$/.test(name)) return [];
    if (seen.has(name)) return [];
    seen.add(name);
    const target = path.isAbsolute(name) ? path.normalize(name) : root ? path.resolve(root, name) : "";
    if (!target) return [{ path: name, status: "unresolved", repairable: false }];
    const actual = physical(target);
    const repairable = Boolean(root && actual && inside(root, actual));
    try {
      const stat = fs.statSync(target);
      return [{ path: target, status: !stat.isFile() ? "not_file" : stat.size ? "exists" : "empty", repairable }];
    } catch (error) {
      return [{ path: target, status: error.code === "ENOENT" ? "missing" : "unreadable", repairable }];
    }
  });
}

module.exports = { inspectDeliverables, normalizeDeliverables };
