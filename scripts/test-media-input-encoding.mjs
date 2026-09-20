import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-media-encoding-"));
const text = "\u4e2d\u6587 \u0627\u0644\u0639\u0631\u0628\u064a\u0629";
const seen = [];
const server = http.createServer(async (req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  for await (const chunk of req) raw += chunk;
  seen.push(JSON.parse(raw));
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "fixture: request received, no generation" }));
});

function run(bin, args, input = "", env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: tmp, windowsHide: true,
      env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("child timeout")); }, 15000);
    child.stdout.on("data", (v) => { stdout += v; });
    child.stderr.on("data", (v) => { stderr += v; });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
    child.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/generate`;
  const env = { LILY_MEDIA_IMAGE_ENDPOINT: endpoint, LILY_MEDIA_VIDEO_ENDPOINT: endpoint,
    LILY_MEDIA_SPEECH_ENDPOINT: endpoint, LILY_MEDIA_API_KEY: "fixture" };
  for (const kind of ["image", "video", "speech"]) {
    const script = path.join(root, `resources/skills/lily-${kind}-generation/scripts/generate-${kind}.cjs`);
    const input = { provider: "lily", prompt: text, text, output_dir: tmp };
    const filename = path.join(tmp, `${kind}-\u4e2d\u6587.json`);
    fs.writeFileSync(filename, "\uFEFF" + JSON.stringify(input), "utf8");
    const before = seen.length;
    const fileRun = await run(process.execPath, [script, "--input-file", filename], "", env);
    assert.equal(seen.length, before + 1, fileRun.stderr);
    assert.equal(seen.at(-1)[kind === "speech" ? "text" : "prompt"], text);
    assert.notEqual(fileRun.code, 0, "the intentional provider failure must not become success");
    const pipeRun = await run(process.execPath, [script], JSON.stringify(input), env);
    assert.equal(seen.length, before + 2, pipeRun.stderr);
    assert.equal(seen.at(-1)[kind === "speech" ? "text" : "prompt"], text, "UTF-8 stdin remains compatible");
    const missing = await run(process.execPath, [script, "--input-file"], "", env);
    assert.notEqual(missing.code, 0);
    assert.equal(seen.length, before + 2, "malformed file option must never send a request");
  }
  if (process.platform === "win32") {
    const reader = path.join(tmp, "read.cjs");
    fs.writeFileSync(reader, "process.stdin.on('data', b => process.stdout.write(b.toString('hex')))");
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    const baseline = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `${quote(text)} | & ${quote(process.execPath)} ${quote(reader)}`]);
    assert.notEqual(baseline.stdout.trim(), Buffer.from(text + "\r\n").toString("hex"),
      "Windows PowerShell's default pipe reproduces non-ASCII loss");
    console.log("Windows PowerShell default pipe reproduced character loss; UTF-8 file transport passed");
  }
  console.log("media input encoding: passed (image, video, speech; UTF-8 BOM, filenames, stdin, malformed args)");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
