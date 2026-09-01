"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-composer-layout-"));
app.setPath("userData", path.join(dir, "data"));
app.disableHardwareAcceleration();
let win;
function finish(code) { win?.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }

app.whenReady().then(async () => {
  const css = pathToFileURL(path.join(__dirname, "../src/renderer/styles.css")).href;
  const page = path.join(dir, "index.html");
  fs.writeFileSync(page, `<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="${css}"></head><body>
    <aside class="collaboration-center" style="width:420px;height:500px">
      <div class="collaboration-composer"><textarea id="composer" placeholder="输入消息"></textarea><div class="collaboration-composer-toolbar"><span class="collaboration-composer-spacer"></span><button id="collaborationSendButton">发送</button></div></div>
    </aside></body></html>`);
  win = new BrowserWindow({ show: false, width: 600, height: 700, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(page);
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  const result = await win.webContents.executeJavaScript(`(()=>{
    const composer=document.querySelector('.collaboration-composer'), textarea=document.getElementById('composer'), toolbar=document.querySelector('.collaboration-composer-toolbar');
    const c=getComputedStyle(composer), t=getComputedStyle(textarea), tr=textarea.getBoundingClientRect(), br=toolbar.getBoundingClientRect();
    return {display:c.display,direction:c.flexDirection,align:c.alignItems,outline:t.outlineStyle,shadow:t.boxShadow,widthDelta:Math.abs(tr.width-br.width),leftDelta:Math.abs(tr.left-br.left),seam:Math.abs(tr.bottom-br.top)};
  })()`);
  assert.deepEqual(result, { display: "flex", direction: "column", align: "stretch", outline: "none", shadow: "none", widthDelta: 0, leftDelta: 0, seam: 0 },
    "collaboration composer must render as one full-width focused control, never a detached toolbar");
  console.log("collaboration composer layout: unified focus ring and full-width toolbar passed");
}).then(() => finish(0)).catch((error) => { console.error(error); finish(1); });
