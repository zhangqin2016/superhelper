import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shipIgnore = await import(pathToFileURL(path.join(__dirname, "../src/main/ship-ignore.js")).href);

const {
  isShipIgnoredEntry,
  copyDirRecursiveShipSafe,
  findJunkUnder,
  purgeJunkUnder,
} = shipIgnore;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ship-ignore-test-"));

try {
  const dockerIgnore = fs.readFileSync(path.join(__dirname, "../.dockerignore"), "utf8").split(/\r?\n/);
  for (const rule of [".env", "**/.env", ".env.*", "**/.env.*"]) {
    assert(dockerIgnore.includes(rule), `Docker publish context must exclude ${rule}`);
  }
  assert(isShipIgnoredEntry("__MACOSX", true), "__MACOSX dir");
  assert(isShipIgnoredEntry(".DS_Store", false), ".DS_Store file");
  assert(isShipIgnoredEntry("._foo", false), "AppleDouble");
  assert(!isShipIgnoredEntry("SKILL.md", false), "normal file");

  const src = path.join(root, "src");
  const dst = path.join(root, "dst");
  fs.mkdirSync(path.join(src, "__MACOSX"), { recursive: true });
  fs.writeFileSync(path.join(src, ".DS_Store"), "");
  fs.mkdirSync(path.join(src, "ok"), { recursive: true });
  fs.writeFileSync(path.join(src, "ok", "data.txt"), "x");

  copyDirRecursiveShipSafe(src, dst);
  assert(!fs.existsSync(path.join(dst, "__MACOSX")), "copy skips __MACOSX");
  assert(!fs.existsSync(path.join(dst, ".DS_Store")), "copy skips .DS_Store");
  assert(fs.existsSync(path.join(dst, "ok", "data.txt")), "copy keeps real files");

  fs.mkdirSync(path.join(root, "purge"), { recursive: true });
  fs.mkdirSync(path.join(root, "purge", "__MACOSX"), { recursive: true });
  fs.writeFileSync(path.join(root, "purge", "._x"), "");
  const removed = purgeJunkUnder(path.join(root, "purge"));
  assert(removed.dirs === 1 && removed.files === 1, "purge counts");
  assert(findJunkUnder(path.join(root, "purge")).dirs.length === 0, "purge clean");

  console.log("ship-ignore: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
