import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { visionInspectionPaths } = require("../src/main/vision-inspection-receipt.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-vision-receipt-"));
const image = path.join(root, "\u4e2d\u6587 page.png");
fs.writeFileSync(image, Buffer.from("iVBORw0KGgo=", "base64"));
let fail = false;
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(fail ? 500 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "Readable page" } }] }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const options = { windowsHide: true, env: { ...process.env, VISION_API_KEY: "test-only",
  DASHSCOPE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` } };
try {
  const run = () => promisify(execFile)(process.execPath, ["resources/skills/lily-vision/vision.js", image], options);
  const { stdout } = await run();
  assert.match(stdout, /Readable page/);
  assert.deepEqual(visionInspectionPaths({ output: stdout }), [image]);
  const line = stdout.split("\n").find((s) => s.startsWith("LILY_VISION_RECEIPT "));
  assert(!/[^\x00-\x7f]/.test(line), "receipt is safe under Windows legacy shell encoding");
  assert.deepEqual(visionInspectionPaths({ output: "vision.js page.png: verified" }), []);
  assert.deepEqual(visionInspectionPaths({ output: "LILY_VISION_RECEIPT {broken" }), []);
  fail = true;
  await assert.rejects(run, (error) => {
    assert(!error.stdout.includes("LILY_VISION_RECEIPT"));
    return true;
  });
  console.log("vision-inspection-receipt: ok");
} finally {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
