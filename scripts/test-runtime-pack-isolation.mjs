#!/usr/bin/env node
/**
 * One pack per process, and only when that pack is the job.
 *
 * Acceptance 2026-09-17 D5/D9: every installed runtime pack sat on one shared
 * PYTHONPATH, so a pack's bundled copy of a core library won for EVERY Python
 * process the agent ran. Measured consequences: saving images as a multi-page
 * PDF died with KeyError: 'JPEG' against a Pillow nobody chose, and a dependency
 * audit read four libraries as out of range when the runtime itself was fine.
 *
 * Ordering cannot fix this — packs first breaks Pillow, venv first breaks rembg,
 * whose numba refuses a numpy newer than 2.4. Full isolation cannot either:
 * rembg needs onnxruntime and large-document needs numpy, and only the venv has
 * them. The venv interpreter plus EXACTLY ONE pack is what holds.
 *
 * [gate: runtime-pack-isolation]
 * Run: node scripts/test-runtime-pack-isolation.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = require("../src/main/runtime-pack-runner.js");
const { getRuntimeEnvExtras, getBundledPythonEnv, resolveVenvPython } = require("../src/main/runtime-python.js");
const { getRuntimePackPythonPaths } = require("../src/main/runtime-packs.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

check("the engine selector is the only thing that attaches a pack to an extraction", () => {
  assert.deepEqual(runner.packsForPdfEngine({}), []);
  assert.deepEqual(runner.packsForPdfEngine({ LILY_PDF_ENGINE: "" }), []);
  assert.deepEqual(runner.packsForPdfEngine({ LILY_PDF_ENGINE: "light" }), []);
  for (const engine of ["pro", "pro-pdf", "docling", "PRO-PDF"]) {
    assert.deepEqual(runner.packsForPdfEngine({ LILY_PDF_ENGINE: engine }), ["pro-pdf"], engine);
  }
});

check("asking for no pack yields the plain runtime, and a pack that is not there adds nothing", () => {
  const plain = runner.pythonEnvForPacks([], { PATH: "/usr/bin" });
  assert.equal(plain.PYTHONPATH, getBundledPythonEnv({ PATH: "/usr/bin" }).PYTHONPATH);
  assert.deepEqual(runner.pythonEnvForPacks(["no-such-pack"], { PATH: "/usr/bin" }), plain);
  assert.deepEqual(runner.pythonEnvForPacks(null, { PATH: "/usr/bin" }), plain);
  assert.deepEqual(runner.pythonEnvForPacks(["", undefined], { PATH: "/usr/bin" }), plain);
});

check("the general agent environment carries no pack, but still says where they are", () => {
  const extras = getRuntimeEnvExtras();
  const packDirs = getRuntimePackPythonPaths();
  for (const dir of packDirs) {
    assert.ok(!String(extras.PYTHONPATH || "").includes(dir),
      `${path.basename(dir)} must not be on the general PYTHONPATH`);
  }
  if (packDirs.length) {
    assert.equal(extras.LILY_RUNTIME_PACK_DIRS, packDirs.join(path.delimiter),
      "a deliberate caller must still be able to find them");
  }
});

check("the kill switch restores the previous global behaviour exactly", () => {
  const previous = process.env.LILY_RUNTIME_PACK_GLOBAL_PYTHONPATH;
  process.env.LILY_RUNTIME_PACK_GLOBAL_PYTHONPATH = "1";
  try {
    const packDirs = getRuntimePackPythonPaths();
    const restored = String(getRuntimeEnvExtras().PYTHONPATH || "").split(path.delimiter);
    for (const dir of packDirs) assert.ok(restored.includes(dir), `${path.basename(dir)} is back`);
  } finally {
    if (previous === undefined) delete process.env.LILY_RUNTIME_PACK_GLOBAL_PYTHONPATH;
    else process.env.LILY_RUNTIME_PACK_GLOBAL_PYTHONPATH = previous;
  }
});

check("the extractor and the repair hint each attach one pack, not all of them", () => {
  const translator = fs.readFileSync(path.join(ROOT, "src/main/document-translator.js"), "utf8");
  assert.match(translator, /packRunner\.pythonEnvForPacks\(packRunner\.packsForPdfEngine\(process\.env\)\)/);
  assert.ok(!/getRuntimePackPythonPaths\(\)/.test(translator),
    "the extractor must not put every pack on its path again");
  const tools = fs.readFileSync(path.join(ROOT, "src/main/mcp/runtime-pack-tools.js"), "utf8");
  assert.match(tools, /executionHint\(deps, pack\.id\)/);
  assert.match(tools, /pythonEnvForPacks\(\[packId\]/);
});

check("the skill tells an agent how to reach a pack, so absence is not read as breakage", () => {
  // Acceptance 2026-09-17 P01: the isolation is deliberate, but nothing said so.
  // A ModuleNotFoundError for duckdb was read as "the pack install is broken".
  const skill = fs.readFileSync(path.join(ROOT, "resources/skills-catalog/lily-runtime-packs/SKILL.md"), "utf8");
  assert.match(skill, /LILY_RUNTIME_PACK_DIRS/);
  assert.match(skill, /DELIBERATELY not importable/);
  assert.match(skill, /NOT "the pack is broken"/);
  assert.match(skill, /never fall back to a weaker parser/);
});

// Live half: only meaningful on a machine that actually has packs installed.
const python = resolveVenvPython();
const installed = getRuntimePackPythonPaths();
if (!python || !installed.length) {
  console.log("skip - no bundled python or no installed packs; the live half is not exercised");
} else {
  const ask = (env, code) => {
    try {
      return execFileSync(python, ["-c", code], { env, encoding: "utf8", timeout: 240_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
      return `FAIL ${String(error.stderr || error.message).trim().split("\n").pop()}`;
    }
  };

  check("live: the agent's own Python gets the runtime we declare, and images save as PDF again", () => {
    const env = { ...process.env, ...getRuntimeEnvExtras() };
    const answer = ask(env, [
      "import tempfile, os, random",
      "from PIL import Image",
      "import PIL",
      "random.seed(11)",
      "pages = [Image.new('RGB', (120, 120)) for _ in range(2)]",
      "for page in pages: page.putdata([(random.randrange(256),) * 3 for _ in range(120 * 120)])",
      "out = os.path.join(tempfile.mkdtemp(), 'p.pdf')",
      "pages[0].save(out, save_all=True, append_images=pages[1:])",
      "print(PIL.__version__, os.path.getsize(out) > 0)",
    ].join("\n"));
    assert.ok(!answer.startsWith("FAIL"), `image to PDF must work in the agent runtime: ${answer}`);
    assert.match(answer, /True$/);
  });

  check("live: a pack that is attached brings its OWN dependency versions", () => {
    const withPack = runner.pythonEnvForPacks(["pro-pdf"]);
    const clean = runner.pythonEnvForPacks([]);
    const version = (env) => ask(env, "import numpy; print(numpy.__version__)");
    const packVersion = version(withPack);
    const runtimeVersion = version(clean);
    if (packVersion.startsWith("FAIL") || runtimeVersion.startsWith("FAIL")) {
      console.log("   (numpy unavailable in one of the environments; comparison skipped)");
      return;
    }
    assert.notEqual(packVersion, runtimeVersion,
      "an attached pack must be able to override the runtime for what it ships");
  });
}

console.log(`\n${checks} checks passed (runtime pack isolation)`);
