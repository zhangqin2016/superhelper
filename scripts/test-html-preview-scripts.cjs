"use strict";
/**
 * An HTML artifact in the preview pane works as it does in a browser — its
 * scripts run, its buttons respond, it reads its own data file and storage —
 * while it cannot reach the app. Field report 2026-09-30: the pane showed HTML
 * in a script-free sandbox, so buttons did nothing and charts stayed blank.
 * Real preload, real lily-preview:// protocol, real workspace.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
const { exitAndRemove } = require("./electron-test-cleanup.cjs");

if (!app?.whenReady) { console.error("Run with Electron: electron scripts/test-html-preview-scripts.cjs"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "html-preview-")));
const userData = path.join(dir, "userData");
const workspace = path.join(dir, "工作区");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(path.join(workspace, "output", "app"), { recursive: true });
fs.writeFileSync(path.join(userData, "projects.json"), JSON.stringify({ projects: [{ id: "p1", name: "ws", path: workspace }] }));
fs.writeFileSync(path.join(workspace, "output", "data.json"), JSON.stringify({ revenue: "125,710,677" }));
fs.writeFileSync(path.join(workspace, "output", "app", "index.html"), `<!doctype html><meta charset="utf-8">
<button id="b">0</button><div id="data">loading</div>
<script>
document.body.dataset.ran = "1";
b.onclick = () => { b.textContent = String(Number(b.textContent) + 1); };
fetch("../data.json").then((r) => r.json()).then((d) => { data.textContent = d.revenue; }).catch((e) => { data.textContent = "ERR " + e; });
try { localStorage.setItem("k", "v"); document.body.dataset.storage = localStorage.getItem("k"); } catch (e) { document.body.dataset.storage = "ERR"; }
try { void window.parent.document.body.innerHTML; document.body.dataset.parent = "REACHED"; } catch (e) { document.body.dataset.parent = "blocked"; }
try { document.body.dataset.bridge = typeof window.parent.assistantClient; } catch (e) { document.body.dataset.bridge = "blocked"; }
</script>`);
fs.writeFileSync(path.join(dir, "outside.html"), "<p>outside</p><script>document.body.dataset.ran='1'</script>");
app.setPath("userData", userData);
app.disableHardwareAcceleration();
const { registerPreviewScheme, installPreviewProtocol } = require("../src/main/preview-protocol.js");
registerPreviewScheme();
let win;
const timer = setTimeout(() => { console.error("test-html-preview-scripts timed out"); exitAndRemove({ app, window: win, directory: dir, timer: null, code: 1 }); }, 45_000);
const mod = (name) => pathToFileURL(path.join(ROOT, "src/renderer/modules", name)).href;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function previewFrame() {
  for (let i = 0; i < 60; i += 1) {
    const frame = win.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith("lily-preview://"));
    if (frame) return frame;
    await wait(100);
  }
  return null;
}

app.whenReady().then(async () => {
  try {
    installPreviewProtocol();
    const { ipcMain } = require("electron");
    const { previewUrlForPath } = require("../src/main/preview-protocol.js");
    ipcMain.handle("files:preview-url", (_e, payload = {}) => previewUrlForPath(payload.filePath || ""));
    win = new BrowserWindow({ show: false, width: 1500, height: 950,
      webPreferences: { preload: path.join(ROOT, "src/preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
    await wait(400);
    const open = (file) => win.webContents.executeJavaScript(`(async () => {
      const pane = await import(${JSON.stringify(mod("preview-pane.js"))});
      pane.closePreviewPane();
      return pane.tryOpenInPreviewPane({ kind: "html", path: ${JSON.stringify(file)}, title: "page" });
    })()`);

    const failures = [];
    await open(path.join(workspace, "output", "app", "index.html"));
    const frame = await previewFrame();
    if (!frame) throw new Error("the page was not loaded on its lily-preview:// origin");
    await wait(600);
    const before = await frame.executeJavaScript(`({ ran: document.body.dataset.ran, data: document.getElementById("data").textContent,
      storage: document.body.dataset.storage, parent: document.body.dataset.parent, bridge: document.body.dataset.bridge })`);
    await frame.executeJavaScript(`document.getElementById("b").click(); document.getElementById("b").click();`);
    const clicks = await frame.executeJavaScript(`document.getElementById("b").textContent`);
    if (before.ran !== "1") failures.push("the page's scripts run");
    if (clicks !== "2") failures.push(`its buttons respond (got ${clicks})`);
    if (before.data !== "125,710,677") failures.push(`it reads its own data file (got ${before.data})`);
    if (before.storage !== "v") failures.push(`localStorage works (got ${before.storage})`);
    if (before.parent !== "blocked") failures.push("it cannot read the app window");
    if (before.bridge !== "blocked" && before.bridge !== "undefined") failures.push(`it cannot reach the app bridge (got ${before.bridge})`);
    const sandbox = await win.webContents.executeJavaScript(`document.querySelector("#previewPane iframe")?.getAttribute("sandbox") || ""`);
    if (/allow-top-navigation/.test(sandbox)) failures.push("the page may not navigate the app window");

    // A file outside every workspace gets no preview origin: the script-free view shows.
    await open(path.join(dir, "outside.html"));
    await wait(800);
    const outside = await win.webContents.executeJavaScript(`(() => { const f = document.querySelector("#previewPane .preview-pane-body:not([hidden]) iframe");
      return { sandbox: f?.getAttribute("sandbox") || "", src: f?.getAttribute("src") || "" }; })()`);
    if (outside.sandbox !== "allow-same-origin" || !outside.src.startsWith("file:")) failures.push(`outside a workspace: the script-free view (${JSON.stringify(outside)})`);

    if (failures.length) throw new Error(failures.join("\n") + "\n" + JSON.stringify(before));
    console.log("test-html-preview-scripts: ok");
    exitAndRemove({ app, window: win, directory: dir, timer, code: 0 });
  } catch (error) {
    console.error(error);
    exitAndRemove({ app, window: win, directory: dir, timer, code: 1 });
  }
});
