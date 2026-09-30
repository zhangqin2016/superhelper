#!/usr/bin/env node
// The zero-downtime API deploy, rehearsed with the real scripts and stand-in
// docker / iptables / curl / ss: port 13000 is never left pointing nowhere,
// the old release is stopped only after the switch is verified, a new release
// that never gets healthy changes nothing, and a switch that does not verify
// is undone. Field case 2026-09-30: each deploy replaced the only API
// container — about 18 s of 502s, one customer's request surviving on the
// engine's last retry.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-bluegreen-"));
const bin = path.join(root, "bin");
const work = path.join(root, "baota");
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(work, { recursive: true });
for (const file of ["deploy-api-bluegreen.sh", "api-port.sh", "docker-compose.api-color.yml"]) fs.copyFileSync(path.resolve("deploy/baota", file), path.join(work, file));
fs.writeFileSync(path.join(work, ".env"), "ADMIN_TOKEN=test-admin-token\nDATABASE_URL=postgres://x\n");
const calls = path.join(root, "calls.log");
const nat = path.join(root, "nat.rules");
const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };

// docker: legacy lily-api running unless LEGACY=0; compose up records the colour; stop records.
stub("docker", `case "$1 $2" in
  "image inspect") exit 0 ;;
  "inspect -f") [ "$LEGACY" = 1 ] && echo true || echo false; exit 0 ;;
  "inspect lily-api") [ "$LEGACY" = 1 ] && exit 0 || exit 1 ;;
  "inspect lily-api-blue"|"inspect lily-api-green") exit 1 ;;
esac
exit 0`);
// curl: a colour's own port answers as that colour (unless FAIL_HEALTH); 13000 and the public
// URLs answer as whichever colour the redirect points to — the edge URL keeps answering as the
// old release when FAIL_EDGE (its kernel path not redirected), 13000 too when FAIL_SWITCH.
stub("curl", `url=""; for a in "$@"; do case "$a" in http*) url="$a";; esac; done
colour_of() { case "$1" in 13010) echo blue;; 13011) echo green;; *) echo legacy;; esac; }
target="$(grep -- "-j REDIRECT" "${nat}" 2>/dev/null | head -n 1 | sed 's/.*--to-ports //')"
case "$url" in
  *:13010/*|*:13011/*) [ "$FAIL_HEALTH" = 1 ] && exit 7; port="\${url#*127.0.0.1:}"; echo "{\\"ok\\":true,\\"runtime\\":{\\"apiColor\\":\\"$(colour_of "\${port%%/*}")\\"}}"; exit 0 ;;
  *:13000/*) [ "$FAIL_SWITCH" = 1 ] && target="" ;;
  https://edge*) [ "$FAIL_EDGE" = 1 ] && target="" ;;
esac
echo "{\\"ok\\":true,\\"runtime\\":{\\"apiColor\\":\\"$(colour_of "$target")\\"}}"`);
stub("ss", `i=0; while [ "$i" -lt "\${OPEN:-0}" ]; do echo "ESTAB 0 0 127.0.0.1:13000 127.0.0.1:5$i"; i=$((i+1)); done`);
stub("sleep", "exit 0");
stub("systemctl", "exit 0");
// iptables -t nat: a tiny emulation of -N -C -I -S -D -F over a rules file.
stub("iptables", `shift 2; op="$1"; shift; touch "${nat}"
norm() { echo "$*" | sed 's/-p tcp --dport/-p tcp -m tcp --dport/'; }
case "$op" in
  -N) grep -q "^-N $1$" "${nat}" && exit 1; echo "-N $1" >> "${nat}" ;;
  -C) chain="$1"; shift; grep -qxF -- "-A $chain $(norm "$@")" "${nat}" ;;
  -I) chain="$1"; shift; [ "$1" = 1 ] && shift; line="-A $chain $(norm "$@")"; { echo "$line"; cat "${nat}"; } > "${nat}.new" && mv "${nat}.new" "${nat}" ;;
  -S) grep -E "^-(N|A) $1( |$)" "${nat}" ;;
  -D) chain="$1"; shift; line="-A $chain $(norm "$@")"; awk -v l="$line" 'done || $0 != l { print; next } { done = 1 }' "${nat}" > "${nat}.new" && mv "${nat}.new" "${nat}" ;;
  -F) grep -v "^-A $1 " "${nat}" > "${nat}.new"; mv "${nat}.new" "${nat}" ;;
esac`);

const state = path.join(root, "active");
const run = (env = {}) => {
  fs.writeFileSync(calls, "");
  const result = spawnSync("sh", [path.join(work, "deploy-api-bluegreen.sh")], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, API_IMAGE_TAG: "abc123", LILY_API_STATE_FILE: state, LILY_API_UNIT_DIR: root, LEGACY: "1",
      LILY_API_PUBLIC_URLS: "https://domestic.example https://edge.example", ...env },
  });
  return { ...result, calls: fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) };
};
const redirects = () => (fs.existsSync(nat) ? fs.readFileSync(nat, "utf8") : "").split("\n").filter((l) => /^-A LILY_API_PORT .*REDIRECT/.test(l));
const index = (list, needle) => list.findIndex((line) => line.includes(needle));

try {
  // A new release that never gets healthy: nothing switched, the current release untouched.
  const sick = run({ FAIL_HEALTH: "1", HEALTH_MAX_SECONDS: "6" });
  assert.notEqual(sick.status, 0);
  assert.match(sick.stdout, /never became healthy; the current release keeps serving/);
  assert.equal(redirects().length, 0, "no redirect installed");
  assert.equal(index(sick.calls, "docker stop"), -1, "the current release is not stopped");
  assert(!fs.existsSync(state));

  // First switch: legacy lily-api on 13000 → blue on 13010.
  const first = run({ OPEN: "0" });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(redirects(), ["-A LILY_API_PORT -p tcp -m tcp --dport 13000 -j REDIRECT --to-ports 13010"]);
  assert.equal(fs.readFileSync(state, "utf8").trim(), "13010");
  assert(fs.existsSync(path.join(root, "lily-api-port.service")), "the redirect is restored at boot");
  const upAt = index(first.calls, "docker compose --env-file .env -p lily-api-blue");
  const switchAt = index(first.calls, "--to-ports 13010");
  const stopAt = index(first.calls, "docker stop -t 120 lily-api");
  assert(upAt >= 0 && switchAt > upAt && stopAt > switchAt, "start → switch → stop, in that order");

  // Next deploy: blue → green, the old colour stopped after the switch.
  const second = run({ OPEN: "0" });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(redirects(), ["-A LILY_API_PORT -p tcp -m tcp --dport 13000 -j REDIRECT --to-ports 13011"], "exactly one target at a time");
  assert(index(second.calls, "docker stop -t 120 lily-api-blue") > index(second.calls, "--to-ports 13011"));

  // A switch that does not verify through 13000 is undone: back to the colour that was serving.
  const broken = run({ FAIL_SWITCH: "1", OPEN: "0" });
  assert.notEqual(broken.status, 0);
  assert.match(broken.stdout, /switched back to green/);
  assert.deepEqual(redirects(), ["-A LILY_API_PORT -p tcp -m tcp --dport 13000 -j REDIRECT --to-ports 13011"]);
  assert.equal(index(broken.calls, "docker stop"), -1, "nothing stopped");

  // The overseas entrance still reaching the old release: undone, nothing retired.
  const edge = run({ FAIL_EDGE: "1", OPEN: "0" });
  assert.notEqual(edge.status, 0);
  assert.match(edge.stdout, /not yet answered by lily-api-blue: https:\/\/edge\.example/);
  assert.match(edge.stdout, /switched back to green/);
  assert.deepEqual(redirects(), ["-A LILY_API_PORT -p tcp -m tcp --dport 13000 -j REDIRECT --to-ports 13011"]);
  assert.equal(index(edge.calls, "docker stop"), -1, "the serving release is not stopped");

  // Open connections on the old release are waited for, bounded.
  const busy = run({ OPEN: "2", DRAIN_MAX_SECONDS: "10" });
  assert.equal(busy.status, 0, busy.stdout);
  assert.match(busy.stdout, /waiting for 2 open connection\(s\)/);
  assert.match(busy.stdout, /still has 2 open connection\(s\) after 10s/);
  console.log("test-deploy-bluegreen: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
