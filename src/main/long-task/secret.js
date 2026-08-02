"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function validSecret(value) {
  try { return Buffer.from(String(value || ""), "base64url").length >= 32; } catch { return false; }
}

function ensureLongTaskSecret(options = {}) {
  const fromEnv = options.envSecret || process.env.LILY_PROCESS_JOBS_SCOPE_SECRET;
  if (validSecret(fromEnv)) return String(fromEnv);
  const file = options.filePath || require("../config").longTaskSecretPath();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (validSecret(existing)) return existing;
  } catch { /* create below */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const generated = crypto.randomBytes(32).toString("base64url");
  try {
    fs.writeFileSync(file, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return generated;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const raced = fs.readFileSync(file, "utf8").trim();
    if (!validSecret(raced)) throw new Error("LONG_TASK_SECRET_INVALID");
    return raced;
  }
}

module.exports = { ensureLongTaskSecret, validSecret };
