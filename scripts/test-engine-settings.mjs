#!/usr/bin/env node
/**
 * Engine selection persistence. OpenCode is the only supported engine, so: any
 * unknown or removed value (e.g. the retired "claude") must normalize to the
 * default and never persist as selectable, a valid set must round-trip, and the
 * LILY_ENGINE env must be honored + normalized (dev/CI escape hatch).
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

  // round-trip + removed engine normalizes to the only supported engine
  delete process.env.LILY_ENGINE;
  assert(es.setEngine("opencode").engine === "opencode", "set returns normalized engine");
  assert(es.getEngine() === "opencode", "stored choice read back");
  assert(es.setEngine("claude").engine === "opencode", "removed engine (claude) normalizes to opencode");
  assert(es.getEngine() === "opencode", "a removed engine never persists as selectable");

  // env override is honored and normalized
  process.env.LILY_ENGINE = "OpenCode";
  assert(es.getEngine() === "opencode", "LILY_ENGINE env honored + normalized (case-insensitive)");
  process.env.LILY_ENGINE = "bogus";
  assert(es.getEngine() === "opencode", "unknown LILY_ENGINE normalizes to default");
  delete process.env.LILY_ENGINE;

  // public list shape: opencode is the only engine
  const pub = es.listEnginesPublic();
  assert(pub.supported.includes("opencode") && !pub.supported.includes("claude"), "opencode is the only supported engine");
  assert(pub.defaultEngine === "opencode", "default is opencode");
} finally {
  es.setEngine(original);
}

console.log("engine-settings: ok");
