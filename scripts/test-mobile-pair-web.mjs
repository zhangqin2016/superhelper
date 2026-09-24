#!/usr/bin/env node
// The phone page (web/app/m/pair + web/components/mobile + web/lib/mobile):
// security invariants, the surfaces it must offer, and its layering. The
// behaviour itself is tested in test-mobile-relay-client / -conversation-reducer
// / -protocol-contract; this holds the structure.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const files = {
  page: read("web/app/m/pair/page.js"),
  hook: read("web/components/mobile/use-mobile-command.js"),
  chat: read("web/components/mobile/chat-screen.js"),
  pairing: read("web/components/mobile/pairing-screen.js"),
  sheet: read("web/components/mobile/session-sheet.js"),
  voice: read("web/components/mobile/use-voice-input.js"),
  markdown: read("web/components/mobile/markdown.js"),
  protocol: read("web/lib/mobile/protocol.mjs"),
  conversation: read("web/lib/mobile/conversation.mjs"),
  client: read("web/lib/mobile/relay-client.mjs"),
  attachments: read("web/lib/mobile/attachments.mjs"),
};
const all = Object.values(files).join("\n");

// --- security: no login, no account credential, no raw HTML -------------------
assert.match(files.page, /^"use client";/, "the page is a client component");
assert.doesNotMatch(all, /\/api\/auth\/sms\//, "the phone does not send/verify SMS codes");
assert.doesNotMatch(all, /accessToken/, "the phone holds no account access token");
assert.doesNotMatch(all, /\/api\/account\//, "the phone calls no account endpoints");
assert.doesNotMatch(all, /dangerouslySetInnerHTML=/, "markdown renders elements, never raw HTML (XSS-safe)");
assert.match(files.client, /role=mobile/, "connects the relay as the mobile role");
assert.match(files.client, /token=\$\{encodeURIComponent\(mobileToken\)\}/, "the relay is authenticated with the grant token only");
assert.match(files.client, /\/api\/mobile\/pairing\/consume/, "consumes the one-time pairing token");
assert.match(files.client, /CAN_START\.has\(phase\)/, "a one-time code is never consumed twice");
assert.match(files.hook, /history\.replaceState/, "the spent token is removed from the address bar");

// --- the surfaces the phone offers -----------------------------------------------
assert.match(files.client, /\/api\/mobile\/direct\/consume/, "direct code + password");
assert.match(files.client, /\/api\/mobile\/grant\/refresh/, "the relay token is renewed before it lapses");
assert.match(files.client, /GRANT_STORAGE_KEY = "lily_m_grant"/, "the pairing survives a refresh");
assert.match(files.client, /CLOSE\.GRANT_ENDED/, "a revoked pairing ends cleanly");
assert.match(files.hook, /visibilitychange/, "returning to the tab reconnects at once");
assert.match(files.hook, /parseScanHash/, "a scanned QR deep link pairs automatically");
assert.match(files.chat, /type="file"/, "an image picker");
assert.match(files.chat, /accept="image\/\*"/);
assert.match(files.attachments, /fileToDownscaledAttachment/, "images are downscaled to fit the relay");
assert.match(files.voice, /\/api\/mobile\/asr\/token/, "server speech recognition");
assert.match(files.voice, /\/llm\/asr\/sessions/);
assert.match(files.voice, /SpeechRecognition/, "browser dictation fallback");
assert.match(files.voice, /此浏览器不支持语音输入/, "an unsupported browser is told so");
assert.match(files.chat, /isComposing/, "Enter while composing Chinese does not send");
assert.match(files.chat, /停止/, "a running turn can be stopped");
assert.match(files.sheet, /onSelectProject/, "workspace picker");
assert.match(files.sheet, /onSelectSession/, "session picker");
assert.match(files.page, /电脑离线/, "the desktop being away is said plainly");
assert.match(files.page, /\/api\/mobile\/capabilities/, "server-gated capabilities are described");
assert.match(files.page, /屏幕、鼠标键盘控制暂未开放/, "phase-2 surfaces are not advertised as live");
assert.doesNotMatch(all, /indigo|violet/, "the product's brand palette, not framework defaults");

// --- layering ----------------------------------------------------------------------
for (const [name, src] of Object.entries({ protocol: files.protocol, conversation: files.conversation, client: files.client })) {
  assert.doesNotMatch(src, /from "react"|useState|useEffect/, `lib/mobile/${name} is framework-free`);
}
assert.doesNotMatch(files.conversation, /fetch\(|WebSocket|localStorage/, "the conversation model does no I/O");
for (const [name, src] of Object.entries({ page: files.page, chat: files.chat, pairing: files.pairing, sheet: files.sheet })) {
  assert.doesNotMatch(src, /new WebSocket|\.send\(JSON/, `${name}: views never touch the connection`);
}
assert.ok(files.page.split("\n").length < 160, "the page is composition, not a monolith");
assert.match(files.conversation, /commandId/, "pending tasks reconcile by command identity");

// --- fits a phone: nothing widens the page ---------------------------------------
// Field case: a reply with a Windows path in inline code made the chat scroller
// 673px wide on a 390px phone (a sideways scrollbar), a markdown table showed as
// raw pipes, and a dozen workspaces as wrapped chips ran off the bottom sheet.
assert.match(files.chat, /<main ref=\{scrollRef\} className="[^"]*overflow-x-hidden/, "the conversation never scrolls sideways");
assert.match(files.pairing, /<main className="[^"]*overflow-x-hidden/, "nor does the pairing screen");
for (const [name, src] of Object.entries({ chat: files.chat, pairing: files.pairing })) {
  // Up to the field's own className ("=>" in a handler would end a [^>]* match early).
  const fields = [...src.matchAll(/<(input|textarea)\b([\s\S]*?)className="([^"]*)"/g)].filter((m) => !/type="file"/.test(m[2]));
  assert.ok(fields.length, `${name}: text fields found`);
  for (const [, tag, , cls] of fields) assert.match(cls, /(?:^|\s)text-(?:base|lg)(?:\s|$)/, `${name} ${tag}: a text field under 16px makes iOS zoom the page on focus`);
}
assert.doesNotMatch(files.sheet, /flex-wrap/, "workspaces are a list, not wrapped chips");
assert.match(files.sheet, /max-h-\[\d+dvh\]/, "the sheet is sized to the visible viewport, not vh behind the browser bars");
assert.match(files.sheet, /truncate/, "long names are cut, not widened");
{
  const { createRequire } = await import("node:module");
  const requireWeb = createRequire(path.join(ROOT, "web/package.json"));
  const swc = requireWeb("next/dist/build/swc");
  await swc.loadBindings();
  const { code } = swc.transformSync(files.markdown, { filename: "markdown.js", jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } });
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, requireWeb);
  const React = requireWeb("react");
  const { renderToStaticMarkup } = requireWeb("react-dom/server");
  const html = (md) => renderToStaticMarkup(React.createElement(React.Fragment, null, ...mod.exports.renderMarkdown(md)));
  const table = html("里面主要是：\n\n| 文件或目录 | 占用 |\n| --- | ---: |\n| runtime\\cache | 9.4 GiB |\n| messages.db | 3.1 GiB |");
  assert.match(table, /<div class="[^"]*overflow-x-auto[^"]*"><table/, "a table scrolls inside its own box");
  assert.match(table, /<th[^>]*>文件或目录<\/th>/, "the header row is a header");
  assert.equal((table.match(/<tr/g) || []).length, 3, "header + two rows; the --- rule is not a row");
  assert.doesNotMatch(table, /\|/, "no raw pipes left");
  const long = html("位置 `C:\\Users\\ROG\\AppData\\Roaming\\lily-workbench`\n\n- 一项 `很长的路径`\n\n# 标题");
  assert.match(long, /<code class="[^"]*overflow-wrap:anywhere/, "inline code breaks anywhere");
  assert.match(long, /<ul class="[^"]*overflow-wrap:anywhere/, "list items wrap long text");
  assert.match(long, /<p class="[^"]*overflow-wrap:anywhere/, "paragraphs wrap long text");
  assert.doesNotMatch(html("a | b | c"), /<table/, "a line with pipes but no rule stays text");
}

console.log("mobile-pair-web: ok");
