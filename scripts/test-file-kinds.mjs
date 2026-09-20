#!/usr/bin/env node
// What kind of file an extension names is decided by one table, for both
// processes, with groups named by PURPOSE.
//
// Before 2026-09-19 fourteen modules kept their own "image" list (eight
// different lists): .heic was an image to the task router and not to the
// vision bridge, .svg an image to the renderer and not to the bridge, .tif in
// three lists and out of three; seventeen more lists did the same for
// documents, and five ext→mime maps and five regex alternations repeated it
// all again. src/shared/file-kinds.mjs is the table; every consumer picks the
// group that answers ITS question; this test scans for a second list.
// [gate: file-kinds-single-table]
// Run: node scripts/test-file-kinds.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as kinds from "../src/shared/file-kinds.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { EXTENSIONS: E } = kinds;

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }
const subset = (a, b) => [...a].every((x) => b.has(x));

check("every entry names a kind and a mime, and the groups are honest about capability", () => {
  for (const [ext, entry] of Object.entries(kinds.FILE_KIND_TABLE)) {
    assert.match(ext, /^\.[a-z0-9]+$/, ext);
    assert.ok(entry.kind && entry.mime.includes("/"), `${ext} has a kind and a mime`);
  }
  assert.ok(subset(E.visionRaster, E.browserImage) && subset(E.browserImage, E.image), "what the bridge reads ⊂ what the browser shows ⊂ what is an image");
  assert.ok(subset(E.rasterImage, E.image) && !E.rasterImage.has(".svg"), "raster excludes vector");
  assert.ok(subset(E.ooxml, E.office) && subset(E.legacyOffice, E.office) && subset(E.openDocument, E.office));
  assert.ok(subset(E.browserVideo, E.video) && !E.browserVideo.has(".avi"), "Chromium does not play .avi");
  assert.equal([...E.semanticZipContainer].every((ext) => E.ooxml.has(ext) || E.openDocument.has(ext)), true);
});

check("the field inconsistencies are gone: one answer per question", () => {
  assert.equal(kinds.isImage("shot.HEIC"), true, ".heic is an image file");
  assert.equal(kinds.isVisionRaster("shot.heic"), false, "…that the vision bridge cannot read today");
  assert.equal(kinds.isBrowserImage("shot.heic"), false, "…nor Chromium display");
  assert.equal(kinds.isImage("logo.svg") && kinds.isBrowserImage("logo.svg") && !kinds.isRasterImage("logo.svg"), true);
  assert.equal(kinds.isBrowserImage("pic.avif"), true);
  assert.equal(kinds.isOffice("book.xlsm"), true, ".xlsm is an OOXML workbook wherever office files are handled");
  assert.equal(kinds.kindOf("deck.odp"), "presentation");
});

check("extensions are read from names, paths and bare names alike", () => {
  assert.equal(kinds.extensionOf("a/b/Report.PDF"), ".pdf");
  assert.equal(kinds.extensionOf("C:\\x\\y.JPG"), ".jpg");
  assert.equal(kinds.extensionOf("png"), ".png");
  assert.equal(kinds.extensionOf(".webp"), ".webp");
  assert.equal(kinds.extensionOf("no-extension"), "");
  assert.equal(kinds.extensionOf(".env"), "");
  assert.equal(kinds.mimeOf("x.mov"), "video/quicktime");
  assert.equal(kinds.mimeOf("x.unknown"), "application/octet-stream");
  assert.equal(kinds.mimeOf("x.unknown", ""), "");
  assert.deepEqual([...kinds.bare(E.pdf)], ["pdf"]);
  assert.equal(kinds.alternation(E.visionRaster), "png|jpg|jpeg|gif|webp|bmp");
  assert.throws(() => kinds.hasKind("nope", "x.png"), /unknown file-kind group/);
});

check("the main process and the renderer read the same table", () => {
  const viaRequire = require("../src/shared/file-kinds.mjs");
  assert.deepEqual([...viaRequire.EXTENSIONS.image], [...E.image], "require() and import see one table");
  assert.equal(typeof viaRequire.isVisionRaster, "function");
});

check("no module keeps its own list of media or office extensions", () => {
  // .csv/.tsv/.svg are text to most modules (fence languages, text lists) and
  // do not by themselves mark a list as a media list.
  const MEDIA = new Set(Object.keys(kinds.FILE_KIND_TABLE).map((ext) => ext.slice(1)).filter((e) => !["csv", "tsv", "svg"].includes(e)));
  const allowed = new Map([
    ["src/main/mcp/file-signature.js", "magic-byte signatures keyed by extension — a different table"],
    ["src/main/mcp/file-intelligence-core.js", "what the extractors can open — a capability list, not a kind"],
  ]);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      if (allowed.has(rel)) continue;
      const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      // (a) a Set/array literal spelling two or more table extensions
      // (a) a Set/array literal spelling two or more table extensions (dotted —
      //     bare words in a prose keyword list are not file names)
      for (const m of code.matchAll(/(?:new Set\(\[|\[)\s*((?:"[^"]+"\s*,?\s*){2,})\]/g)) {
        const items = [...m[1].matchAll(/"\.([a-z0-9]+)"/g)].map((x) => x[1].toLowerCase());
        if (items.filter((i) => MEDIA.has(i)).length >= 2) offenders.push(`${rel}: list ${items.slice(0, 5).join(",")}`);
      }
      // (b) an object literal keyed by two or more table extensions
      const keys = [...code.matchAll(/"\.([a-z0-9]+)"\s*:/g)].map((x) => x[1]);
      if (keys.filter((k) => MEDIA.has(k)).length >= 2) offenders.push(`${rel}: map keyed by ${keys.filter((k) => MEDIA.has(k)).slice(0, 4).join(",")}`);
      // (c) a file-name regex spelling table extensions after "\."
      for (const m of code.matchAll(/\\\.\(\??:?([a-z0-9?|]+)\)/g)) {
        const alts = m[1].split("|").map((a) => a.replace("?", ""));
        if (alts.filter((a) => MEDIA.has(a) || MEDIA.has(`${a}g`)).length >= 2) offenders.push(`${rel}: regex \\.(${m[1].slice(0, 30)})`);
      }
    }
  };
  walk(path.join(ROOT, "src/main"));
  walk(path.join(ROOT, "src/renderer"));
  assert.deepEqual(offenders, [], `file kinds come from src/shared/file-kinds.mjs:\n${offenders.join("\n")}`);
});

console.log(`\n${checks} checks passed (file kinds)`);
