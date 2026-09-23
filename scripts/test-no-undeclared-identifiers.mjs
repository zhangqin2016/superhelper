#!/usr/bin/env node
// A name that is read but never declared throws only when that line runs —
// the build, the syntax check and every import stay green. It reached
// production three times in one day: the contacts page read `cursor`, `params`
// and `rows` it never declared; the config-rule form called a `splitCsv` left
// in another file; and GET /api/admin/config-profiles read `request` from a
// handler written `async () =>`, so the rules list answered 500 to everyone.
//
// This is scope analysis, not a pattern: every file is parsed with the Babel
// that ships inside Next, and any identifier the program reads without a
// declaration, an import, or a runtime global is a failure. Browser globals
// are allowed only where a browser runs the code (the web app and the
// desktop renderer), never in the server or the desktop main process.
// [gate: no-undeclared-identifiers]
// Run: node scripts/test-no-undeclared-identifiers.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireWeb = createRequire(path.join(ROOT, "web/package.json"));
let parse;
let traverse;
try {
  ({ parse } = requireWeb("next/dist/compiled/babel/parser"));
  const traverseModule = requireWeb("next/dist/compiled/babel/traverse");
  traverse = traverseModule.default || traverseModule;
} catch (error) {
  console.log(`SKIP no-undeclared-identifiers: web dependencies are not installed (${error.message})`);
  process.exit(0);
}

const RUNTIME = new Set([
  ...Object.getOwnPropertyNames(globalThis),
  "require", "module", "exports", "__dirname", "__filename", "arguments", "undefined",
]);
const BROWSER = new Set([
  "window", "document", "navigator", "location", "history", "localStorage", "sessionStorage",
  "alert", "confirm", "prompt", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "requestIdleCallback", "cancelIdleCallback", "innerWidth", "innerHeight", "devicePixelRatio", "matchMedia",
  "CSS", "Image", "Option", "FileReader", "NodeFilter", "Node", "HTMLElement", "HTMLInputElement",
  "HTMLSelectElement", "HTMLTextAreaElement", "HTMLCanvasElement", "Element", "Range", "Selection",
  "MutationObserver", "ResizeObserver", "IntersectionObserver", "AudioContext", "AudioWorkletNode",
  "MediaRecorder", "ClipboardItem", "DOMParser", "XMLSerializer", "KeyboardEvent", "MouseEvent",
  "InputEvent", "PointerEvent", "DragEvent", "FocusEvent", "ClipboardEvent", "ShadowRoot", "customElements",
  "IDBKeyRange", "indexedDB", "screen", "scrollTo", "open", "close", "print", "getSelection",
]);

const AREAS = [
  { dir: "server/src", browser: false },
  { dir: "server/scripts", browser: false },
  { dir: "src/main", browser: false },
  { dir: "src/shared", browser: false },
  { dir: "web/app", browser: true },
  { dir: "web/components", browser: true },
  { dir: "web/lib", browser: true },
  { dir: "src/renderer", browser: true },
];

function filesUnder(dir) {
  const out = [];
  const stack = [path.join(ROOT, dir)];
  while (stack.length) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (["node_modules", ".next", "vendor", "dist"].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(m|c)?js$/.test(entry.name)) out.push(full);
    }
  }
  return out;
}

function undeclared(file, allowBrowser) {
  const source = fs.readFileSync(file, "utf8");
  const ast = parse(source, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    plugins: ["jsx", "importAttributes", "topLevelAwait", "classProperties", "classPrivateProperties"],
  });
  const found = [];
  traverse(ast, {
    Program(programPath) {
      for (const [name, node] of Object.entries(programPath.scope.globals || {})) {
        if (RUNTIME.has(name) || (allowBrowser && BROWSER.has(name))) continue;
        found.push(`${path.relative(ROOT, file)}:${node?.loc?.start?.line ?? "?"} reads \`${name}\`, which is never declared`);
      }
      programPath.stop();
    },
  });
  return found;
}

let checked = 0;
const failures = [];
const unparsable = [];
for (const area of AREAS) {
  for (const file of filesUnder(area.dir)) {
    try {
      failures.push(...undeclared(file, area.browser));
      checked += 1;
    } catch (error) {
      unparsable.push(`${path.relative(ROOT, file)}: ${error.message}`);
    }
  }
}

assert.ok(checked > 500, `expected to analyse the whole codebase, analysed ${checked} files`);
assert.deepEqual(unparsable, [], `these files could not be analysed:\n  ${unparsable.join("\n  ")}`);
assert.deepEqual(failures, [], `undeclared identifiers (each throws the moment its line runs):\n  ${failures.join("\n  ")}`);

// The gate must actually see the defects it exists for.
const probe = path.join(ROOT, "server/src/.undeclared-probe.js");
try {
  fs.writeFileSync(probe, "export const h = async () => { return request.query; };\n");
  assert.equal(undeclared(probe, false).length, 1, "a handler reading `request` without the parameter is caught");
  fs.writeFileSync(probe, "export const h = async (request) => request.query;\nexport const w = () => window.x;\n");
  assert.deepEqual(undeclared(probe, false).map((line) => line.split(" reads ")[1]), ["`window`, which is never declared"], "a browser global is refused on the server");
} finally {
  fs.rmSync(probe, { force: true });
}

console.log(`no-undeclared-identifiers: ok (${checked} files)`);
