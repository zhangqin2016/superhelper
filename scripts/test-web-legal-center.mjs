import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const routes = [
  "web/app/legal/page.js",
  "web/app/privacy/page.js",
  "web/app/terms/page.js",
  "web/app/legal/data-and-third-parties/page.js",
  "web/app/account-deletion/page.js",
];

for (const route of routes) {
  assert.ok(fs.existsSync(path.join(root, route)), `missing public legal route: ${route}`);
}

const footer = read("web/components/site-footer.js");
for (const href of ["/privacy", "/terms", "/legal/data-and-third-parties", "/account-deletion"]) {
  assert.match(footer, new RegExp(`href=["']${href.replaceAll("/", "\\/")}["']`), `footer must link to ${href}`);
}

const content = read("web/lib/legal-content.mjs");
for (const required of [
  "北京科瑞普投艺术科技有限公司",
  "felix@lilywb.cn",
  "手机号",
  "设备标识",
  "聚合用量",
  "运行诊断",
  "模型请求",
  "联系表单",
  "七牛",
  "阿里云短信",
  "支付宝",
  "微信支付",
  "跨境",
  "删除",
  "撤回",
  "未成年人",
]) {
  assert.ok(content.includes(required), `legal content must disclose: ${required}`);
}

assert.doesNotMatch(content, /聊天内容[^。\n]{0,20}(绝不|从不|不会被上传|不上传)/, "must not make an absolute no-upload chat claim");
assert.doesNotMatch(content, /文件内容[^。\n]{0,20}(绝不|从不|不会被上传|不上传)/, "must not make an absolute no-upload file claim");
assert.match(content, /本地[^。\n]{0,30}默认/, "must explain local-by-default behavior");
assert.match(content, /AI[^。\n]{0,80}(发送|传输)/i, "must explain AI request transmission");
assert.match(content, /人工[^。\n]{0,30}(删除|注销)|删除申请/, "must describe the current manual deletion path");

const publicCopy = read("web/lib/i18n.mjs");
for (const misleading of [
  "不会保存你的聊天内容和文件内容",
  "不会采集用户聊天内容",
  "不采集聊天内容",
  "We only collect device and aggregate usage stats",
  "without collecting chat content",
  "Do not store prompts, replies, screenshots or files",
  "دون جمع محتوى المحادثات",
  "لا نجمع محتوى المحادثات",
]) {
  assert.ok(!publicCopy.includes(misleading), `public website must not retain misleading absolute claim: ${misleading}`);
}

console.log("web legal center tests passed");
