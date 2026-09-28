#!/usr/bin/env node
/**
 * A release never re-sends bytes Qiniu already holds.
 *
 * 0.1.190: the Windows installer is uploaded twice — the versioned download and
 * the auto-update package — and from a 0.2–0.6 MB/s uplink each copy took
 * 50 minutes. release-admin now leaves an object that already has the file's
 * etag alone, copies a second key inside Qiniu from one uploaded before, and
 * falls back to the plain upload whenever it cannot prove the result — a copy
 * that does not land (the first attempt passed the destination positionally
 * and copied the file onto itself) is caught by the etag check.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(ROOT, "release", ".qiniu-uploaded.json");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-release-dedupe-"));
const store = path.join(tmp, "store");
const calls = path.join(tmp, "calls.log");
fs.mkdirSync(store);
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
// A qshell that keeps objects in a directory: qetag, stat, copy (-k), rput.
fs.writeFileSync(path.join(bin, "qshell"), `#!/bin/sh
echo "$*" >> "${calls}"
obj() { printf '%s' "$1" | tr '/' '_'; }
case "$1" in
  qetag) printf 'F%s\\n' "$(shasum "$2" | cut -c1-27)";;
  stat) f="${store}/$(obj "$3")"; [ -f "$f" ] || { echo "no such file or directory" >&2; exit 1; }; printf 'Key: %s\\nEtag:  F%s\\n' "$3" "$(shasum "$f" | cut -c1-27)";;
  copy) [ "$FAKE_COPY_BROKEN" = 1 ] && { echo "Copy Success"; exit 0; }; [ "$5" = "-k" ] || exit 2; cp "${store}/$(obj "$3")" "${store}/$(obj "$6")"; echo "Copy Success";;
  rput) cp "$4" "${store}/$(obj "$3")";;
esac
`, { mode: 0o755 });
const had = fs.existsSync(INDEX) ? fs.readFileSync(INDEX) : null;
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

try {
  fs.rmSync(INDEX, { force: true });
  const file = path.join(tmp, "Installer-1.0.0.exe");
  fs.writeFileSync(file, "installer bytes ".repeat(4096));
  const upload = (key, env = {}) => {
    fs.writeFileSync(calls, "");
    const run = spawnSync(process.execPath, ["scripts/release-admin.mjs", "upload", "--bucket", "b", "--key", key, "--file", file], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    return { out: run.stdout + run.stderr, ops: fs.readFileSync(calls, "utf8").trim().split("\n").map((line) => line.split(" ")[0]) };
  };

  const first = upload("app/updates/win/1.0.0/Installer.exe");
  assert.ok(first.ops.includes("rput"), "new bytes are uploaded");
  check("new content is uploaded");

  const second = upload("app/auto-updates/win/stable/Installer.exe");
  assert.ok(!second.ops.includes("rput"), "the same bytes under a second key are not re-sent");
  assert.ok(second.ops.includes("copy") && /copied inside Qiniu/.test(second.out), "they are copied inside Qiniu");
  assert.ok(fs.existsSync(path.join(store, "app_auto-updates_win_stable_Installer.exe")), "and the second key holds them");
  check("a second key for uploaded bytes is a Qiniu-side copy");

  const again = upload("app/updates/win/1.0.0/Installer.exe");
  assert.deepEqual(again.ops.filter((op) => op === "rput" || op === "copy"), [], "an object that already has the content is left alone");
  assert.match(again.out, /already in Qiniu with the same content/);
  check("an object already holding the content is not re-sent — a re-run costs nothing");

  const broken = upload("app/other/Installer.exe", { FAKE_COPY_BROKEN: "1" });
  assert.ok(broken.ops.includes("copy") && broken.ops.includes("rput"), "a copy that says success but does not land is caught, and the file is uploaded");
  assert.match(broken.out, /not verified/);
  check("a copy that does not land falls back to the upload");
} finally {
  if (had) fs.writeFileSync(INDEX, had); else fs.rmSync(INDEX, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`release-upload-dedupe: ok (${checks} checks)`);
