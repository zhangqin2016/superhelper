#!/usr/bin/env node
// Architecture ratchet: raw legacy stream-json wire shapes may only live inside
// src/main/runtime/adapters/. Everything else consumes app-level Runtime
// Events (docs/turn-block-experience-plan.md "守门纪律").
//
// LEGACY_WIRE_FILES is the documented debt baseline — it may only SHRINK.
// Adding a new file to it is an architecture regression; absorb the code into
// the adapter layer (or the planned Agent SDK migration) instead.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Raw stream-json wire markers. "unknown_control_request" is an app-level label,
// hence the lookbehind on control_request.
const WIRE_MARKERS = [
  /content_block_(start|delta|stop)/,
  /\bstream_event\b/,
  /\bcan_use_tool\b/,
  /\bcontrol_cancel_request\b/,
  /(?<!unknown_)control_request\b/,
];

// Documented legacy debt (shrink-only). Emptied once the previous engine was
// removed and OpenCode became the only runtime — keep the ratchet so any new
// raw-wire file is flagged rather than silently exempted.
const LEGACY_WIRE_FILES = new Set([]);

// Only the session host may instantiate the engine adapter.
const ADAPTER_REQUIRE_ALLOWED = new Set([
  "src/main/opencode-agent-session.js",
]);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

const violations = [];
const sources = [...walk(path.join(root, "src/main")), ...walk(path.join(root, "src/renderer"))];

for (const file of sources) {
  const rel = path.relative(root, file);
  if (rel.startsWith(path.join("src/main", "runtime", "adapters"))) continue;
  const content = fs.readFileSync(file, "utf-8");

  if (!LEGACY_WIRE_FILES.has(rel)) {
    for (const marker of WIRE_MARKERS) {
      const match = content.match(marker);
      if (match) violations.push(`${rel}: raw stream-json wire shape "${match[0]}" outside runtime/adapters/`);
    }
  }

  if (content.includes("runtime/adapters/") && !ADAPTER_REQUIRE_ALLOWED.has(rel)) {
    violations.push(`${rel}: requires runtime/adapters/* but is not the session host`);
  }
}

// Ratchet integrity: legacy entries must still exist and still need the
// exemption — delete them from the list once cleaned up.
for (const rel of LEGACY_WIRE_FILES) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    violations.push(`${rel}: listed in LEGACY_WIRE_FILES but no longer exists — remove the stale entry`);
    continue;
  }
  const content = fs.readFileSync(full, "utf-8");
  if (!WIRE_MARKERS.some((marker) => marker.test(content))) {
    violations.push(`${rel}: no longer contains wire shapes — shrink LEGACY_WIRE_FILES`);
  }
}

if (violations.length) {
  console.error("runtime boundary violations:\n" + violations.map((v) => `  - ${v}`).join("\n"));
  process.exit(1);
}
console.log(`runtime-boundary: ok (${sources.length} files scanned, ${LEGACY_WIRE_FILES.size} legacy exemptions)`);
