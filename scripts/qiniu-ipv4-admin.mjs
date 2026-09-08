#!/usr/bin/env node
/**
 * Qiniu admin over IPv4 only.
 *
 * WHY: this release machine's IPv6 route to qbox.me / qiniuapi.com is broken
 * (recorded since 0.1.162), so qshell listbucket / delete / cdnrefresh hang or
 * fail with "socket is not connected". This tool signs QBox tokens itself and
 * forces every socket onto IPv4. Credentials: env QINIU_AK / QINIU_SK, else the
 * active qshell account (`qshell account`). Secrets are never printed.
 *
 *   node scripts/qiniu-ipv4-admin.mjs list    <prefix...>   # rsf list (key, size, putTime)
 *   node scripts/qiniu-ipv4-admin.mjs stat    <key...>      # rs stat
 *   node scripts/qiniu-ipv4-admin.mjs delete  <key...>      # rs delete, one by one — verify with list first
 *   node scripts/qiniu-ipv4-admin.mjs refresh <url...>      # fusion CDN refresh (urls), prints task ids + quota
 *
 * Bucket via QINIU_BUCKET (default lanrensoft).
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns";
import https from "node:https";

dns.setDefaultResultOrder("ipv4first");
const BUCKET = process.env.QINIU_BUCKET || "lanrensoft";

function loadCreds() {
  if (process.env.QINIU_AK && process.env.QINIU_SK) return { ak: process.env.QINIU_AK, sk: process.env.QINIU_SK };
  // qshell stores its account file in its own encoding; ask qshell itself for
  // the active account (prints "AccessKey: …" / "SecretKey: …"). Local only.
  try {
    const out = execFileSync("qshell", ["account"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const ak = out.match(/AccessKey:\s*(\S+)/)?.[1];
    const sk = out.match(/SecretKey:\s*(\S+)/)?.[1];
    if (ak && sk) return { ak, sk };
  } catch {
    /* qshell missing or unconfigured */
  }
  console.error("credentials: set QINIU_AK/QINIU_SK or configure qshell (qshell account)");
  process.exit(2);
}
const { ak, sk } = loadCreds();

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const entryOf = (key) => b64url(Buffer.from(`${BUCKET}:${key}`));

// QBox signature: HMAC-SHA1(sk, path + "\n" [+ body only for form-encoded]).
function token(path, formBody = "") {
  return `QBox ${ak}:${b64url(crypto.createHmac("sha1", sk).update(`${path}\n${formBody}`).digest())}`;
}

function request(host, path, { method = "GET", json = null } = {}) {
  const body = json ? JSON.stringify(json) : "";
  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      path,
      method,
      family: 4,
      headers: {
        Authorization: token(path),
        "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || !args.length) {
  console.error("usage: qiniu-ipv4-admin.mjs list|stat|delete|refresh <arg...>");
  process.exit(1);
}

if (cmd === "list") {
  for (const prefix of args) {
    const r = await request("rsf.qiniu.com", `/list?bucket=${BUCKET}&limit=1000&prefix=${encodeURIComponent(prefix)}`);
    if (r.status !== 200) { console.log(`# ${prefix}: HTTP ${r.status} ${r.body.slice(0, 160)}`); continue; }
    const items = JSON.parse(r.body).items || [];
    if (!items.length) console.log(`# ${prefix}: (empty)`);
    for (const it of items) console.log(`${it.key}\t${it.fsize}\t${new Date(it.putTime / 10000).toISOString()}`);
  }
} else if (cmd === "stat") {
  for (const key of args) {
    const r = await request("rs.qiniu.com", `/stat/${entryOf(key)}`);
    console.log(`${r.status}\t${key}\t${r.body.slice(0, 200)}`);
  }
} else if (cmd === "delete") {
  for (const key of args) {
    const r = await request("rs.qiniu.com", `/delete/${entryOf(key)}`, { method: "POST" });
    console.log(`${r.status}\t${key}\t${r.body.slice(0, 120)}`);
  }
} else if (cmd === "refresh") {
  const r = await request("fusion.qiniuapi.com", "/v2/tune/refresh", { method: "POST", json: { urls: args } });
  console.log(r.status, r.body);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}
