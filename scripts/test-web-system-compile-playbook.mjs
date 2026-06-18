#!/usr/bin/env node
/**
 * Compile-to-deterministic-code: a verified plan becomes a standalone Playwright
 * script that replays without the model (faster/cheaper/reproducible). Pin that
 * the generated code is syntactically valid, carries the right operations, keeps
 * the allowlist guard inline, and never emits credential headers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";
import { spawnSync } from "node:child_process";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { compileScript, genApiOptions } = require("../resources/skills-catalog/lily-web-system-learning/scripts/compile_playbook.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-compile-"));

try {
  const plan = {
    action: "web.submit-leave",
    operations: [
      { type: "goto", url: "https://erp.example.com/leave/new", risk: "read" },
      { type: "fill", selector: "#reason", value: "annual", risk: "prepare" },
      { type: "apiRequest", method: "POST", url: "https://erp.example.com/api/leaves", contentType: "json", body: { days: 2 }, headers: { authorization: "Bearer x", "x-trace": "1" }, risk: "submit" },
      { type: "click", role: "button", label: "Submit", risk: "submit" },
    ],
  };
  const script = compileScript(plan, { baseUrl: "https://erp.example.com", allowedDomains: ["example.com"], action: "web.submit-leave" });

  // syntactically valid Node script
  const file = path.join(tmp, "flow.cjs");
  fs.writeFileSync(file, script);
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert(check.status === 0, `generated script must be valid JS: ${check.stderr}`);

  // operations present
  assert(script.includes('page.goto("https://erp.example.com/leave/new"'), "goto compiled");
  assert(script.includes('assertAllowed("https://erp.example.com/leave/new")'), "goto guarded by allowlist");
  assert(script.includes('page.locator("#reason").first().fill("annual"'), "fill compiled with selector");
  assert(script.includes('context.request.fetch("https://erp.example.com/api/leaves"'), "apiRequest compiled");
  assert(script.includes("getByRole(\"button\", { name: \"Submit\" })"), "role locator compiled");

  // safety inlined
  assert(script.includes("ALLOWED_DOMAINS = [\"example.com\"]"), "allowlist embedded");
  assert(/STORAGE_STATE/.test(script), "auth via storageState env, not inlined creds");

  // credential headers must never be emitted, even if present in the plan
  assert(!/authorization/i.test(script), "credential header stripped from generated apiRequest");
  assert(/x-trace/.test(script), "non-credential header preserved");

  // genApiOptions: GET drops body; non-GET keeps data + json content-type
  const getOpts = genApiOptions({ method: "GET", url: "x", body: { a: 1 } });
  assert(getOpts.data === undefined, "GET apiRequest emits no body");
  const postOpts = genApiOptions({ method: "POST", contentType: "json", body: { a: 1 } });
  assert(postOpts.data && postOpts.headers["content-type"] === "application/json", "POST emits data + json content-type");
  assert(genApiOptions({ method: "POST", headers: { cookie: "x" }, body: {} }).headers?.cookie === undefined, "cookie header dropped");

  console.log("PASS: test-web-system-compile-playbook (13 tests)");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
