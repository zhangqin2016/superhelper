import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert } from "./lib/test-assert.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scanner = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/scan_web_system.py");

function findPython() {
  for (const candidate of ["python3", "python"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return null;
}

const python = findPython();
if (!python) {
  console.warn("web-system-scan-checkpoint: python not found; skipped");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-scan-checkpoint-"));
try {
  const out = path.join(tmp, "nested", "web-system-scan.json");
  const probe = `
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("scan_web_system", ${JSON.stringify(scanner)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

cfg = mod.ScanConfig(
    base_url="https://erp.example.com/dashboard",
    allowed_domains=["example.com"],
    max_pages=80,
    timeout_ms=15000,
    headful=False,
    storage_state="/tmp/session.json",
    interactive_readonly=True,
    learning_mode="read-only",
    test_environment="",
    allow_mutating_learning=False,
    har_path=None,
    frontend_source=None,
    route_hint_urls=[],
    route_hint_count=0,
    output_path=${JSON.stringify(out)},
)
pages = [{
    "id": "dashboard",
    "url": "https://erp.example.com/dashboard",
    "urlPattern": "https://erp.example.com/dashboard",
    "title": "Dashboard",
    "fingerprint": "fp",
    "links": [],
    "buttons": [],
    "inputs": [],
    "forms": [],
    "formContracts": [],
    "tables": [],
    "networkContracts": [],
    "actionCandidates": [],
    "businessObjects": [],
}]
mod.write_scan_checkpoint(cfg, pages, [])
print(json.dumps(json.load(open(${JSON.stringify(out)}, "r", encoding="utf-8")), ensure_ascii=False))
`;
  const result = spawnSync(python, ["-c", probe], { cwd: ROOT, encoding: "utf8" });
  assert(result.status === 0, result.stderr || result.stdout || "checkpoint probe failed");
  assert(result.stderr.includes("[lily-progress]"), "scanner emits the platform progress protocol");
  assert(!result.stderr.includes("[lily-web-scan]"), "scanner no longer depends on a web-scan-only progress marker");
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert(payload.ok === true, "running checkpoint remains ok");
  assert(payload.checkpoint === true && payload.status === "running", "checkpoint marks partial running state");
  assert(payload.pages.length === 1 && payload.coverage.pageCount === 1, "checkpoint persists scanned pages and coverage");
  assert(fs.existsSync(out), "checkpoint creates parent directories and output file");
  console.log("PASS: test-web-system-scan-checkpoint");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
