#!/usr/bin/env node
/**
 * Engine selection persistence. The pool reads getEngine() to pick the runner,
 * so: an unknown value must NOT silently route to a missing engine (normalize to
 * default), the LILY_ENGINE env must override the stored choice (dev/CI escape
 * hatch), and a set must round-trip.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const es = require("../src/main/engine-settings.js");

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const original = es.getEngine(); // restore at the end so we don't change the user's setting
try {
  // normalize
  assert(es.normalizeEngine("opencode") === "opencode", "valid engine kept");
  assert(es.normalizeEngine("OpenCode") === "opencode", "case-insensitive");
  assert(es.normalizeEngine("bogus") === es.DEFAULT_ENGINE, "unknown -> default engine (never route to a missing engine)");
  assert(es.normalizeEngine("") === es.DEFAULT_ENGINE, "empty -> default");
  assert(es.DEFAULT_ENGINE === "opencode", "default engine is opencode");

  // round-trip
  delete process.env.LILY_ENGINE;
  assert(es.setEngine("opencode").engine === "opencode", "set returns normalized engine");
  assert(es.getEngine() === "opencode", "stored choice read back");
  es.setEngine("claude");
  assert(es.getEngine() === "claude", "switch back persists");

  // env override wins over stored
  es.setEngine("claude");
  process.env.LILY_ENGINE = "opencode";
  assert(es.getEngine() === "opencode", "LILY_ENGINE env overrides stored choice");
  delete process.env.LILY_ENGINE;
  assert(es.getEngine() === "claude", "without env, stored choice applies again");

  // public list shape
  const pub = es.listEnginesPublic();
  assert(pub.supported.includes("claude") && pub.supported.includes("opencode"), "lists supported engines");
  assert(pub.defaultEngine === "opencode", "default is opencode");
} finally {
  es.setEngine(original);
}

console.log("engine-settings: ok");
