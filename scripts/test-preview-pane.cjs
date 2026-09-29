"use strict";
/**
 * The app's existing previews open beside the chat, in tabs, instead of over it.
 *
 * Image lightbox and PDF reader used to cover the whole window, so reading a
 * generated report meant losing the conversation that produced it. They now
 * open in a right-hand pane (as ChatGPT's preview does), HTML and Markdown
 * artifacts can be opened there too, one tab per file. The pane shares the
 * right column with the collaboration panel, floats over the workbench on a
 * narrow window, and wherever there is no pane (the standalone collaboration
 * window) the old modals are still what opens — never nothing.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
const { exitAndRemove } = require("./electron-test-cleanup.cjs");

if (!app?.whenReady) { console.error("Run with Electron: electron scripts/test-preview-pane.cjs"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-pane-"));
app.setPath("userData", path.join(dir, "userData"));
app.disableHardwareAcceleration();
let win;
const timer = setTimeout(() => { console.error("test-preview-pane timed out"); exitAndRemove({ app, window: win, directory: dir, timer: null, code: 1 }); }, 60_000);
const pdfData = fs.readFileSync(path.join(ROOT, "fixtures/office/sample.pdf")).toString("base64");
const moduleUrl = (name) => pathToFileURL(path.join(ROOT, "src/renderer/modules", name)).href;
const IMG = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#2f7de1"/></svg>');

const run = (body) => win.webContents.executeJavaScript(`(async () => { try {
  const pane = await import(${JSON.stringify(moduleUrl("preview-pane.js"))});
  const viewer = await import(${JSON.stringify(moduleUrl("image-viewer.js"))});
  const pdf = await import(${JSON.stringify(moduleUrl("pdf-viewer.js"))});
  const shell = document.getElementById('appShell');
  const root = document.getElementById('previewPane');
  const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await settle(50); } return null; };
  ${body}
} catch (error) { return { error: String(error?.stack || error) }; } })()`);

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { sandbox: false, contextIsolation: false } });
    await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 1. Wide window: an image opens docked in the pane, not in the lightbox.
    const docked = await run(`
      window.assistantClient = { readTextFile: async () => ({ ok: true, text: '# 报告标题\\n\\n正文段落' }) };
      viewer.openImageViewer(${JSON.stringify(IMG)}, 'cover.svg');
      await settle();
      const centre = document.getElementById('centerPanel').getBoundingClientRect().width;
      return { state: pane.previewPaneState(), open: shell.classList.contains('preview-pane-open'), mode: shell.dataset.previewMode,
        hidden: root.hidden, lightbox: Boolean(document.querySelector('body > .image-viewer')),
        paneWidth: Math.round(root.getBoundingClientRect().width), centre: Math.round(centre),
        img: Boolean(root.querySelector('.preview-pane-image img')), handle: !document.getElementById('previewResizeHandle').hidden };
    `);
    assert.equal(docked.error, undefined, docked.error);
    assert.equal(docked.open, true, "the image opened the pane");
    assert.equal(docked.hidden, false);
    assert.equal(docked.mode, "docked");
    assert.equal(docked.lightbox, false, "no full-screen lightbox over the chat");
    assert.equal(docked.img, true);
    assert.equal(docked.handle, true, "docked: the pane can be resized");
    assert.ok(docked.paneWidth >= 600 && docked.paneWidth <= 800, `pane takes about 45% (${docked.paneWidth}px)`);
    assert.ok(docked.centre >= 480, `the chat keeps its minimum width (${docked.centre}px)`);

    // 2. Same file again selects its tab; PDF, Markdown and HTML add tabs.
    const tabs = await run(`
      viewer.openImageViewer(${JSON.stringify(IMG)}, 'cover.svg');
      pdf.openPdfViewer({ title: 'report.pdf', data: ${JSON.stringify(pdfData)} });
      pane.tryOpenInPreviewPane({ kind: 'markdown', path: '/ws/output/报告.md', title: '报告.md' });
      pane.tryOpenInPreviewPane({ kind: 'html', path: '/ws/output/page.html', title: 'page.html', block: { html: '<h1 id=x>页面</h1><script>document.body.dataset.ran = 1</script>' } });
      const canvas = await waitFor(() => root.querySelector('.is-pdf canvas.pdf-viewer-canvas, .is-pdf .pdf-viewer-page canvas'));
      const md = await waitFor(() => root.querySelector('.preview-pane-markdown h1'));
      const frame = root.querySelector('.is-html iframe');
      await settle(200);
      // The page fills its tab (field report 2026-09-29: it stopped at 560px).
      const frameBox = frame.getBoundingClientRect();
      const bodyBox = frame.closest('.preview-pane-body').getBoundingClientRect();
      return { state: pane.previewPaneState(), labels: [...root.querySelectorAll('.preview-pane-tab-label')].map((n) => n.textContent),
        pdfEmbedded: Boolean(root.querySelector('.pdf-viewer.is-embedded')), pdfModal: Boolean(document.querySelector('body > .pdf-viewer')),
        pdfCanvas: Boolean(canvas), pdfClose: Boolean(root.querySelector('.pdf-viewer-close')),
        md: md?.textContent || '', sandbox: frame?.getAttribute('sandbox'), scriptRan: frame?.contentDocument?.body?.dataset?.ran || '',
        visible: [...root.querySelectorAll('.preview-pane-body')].filter((b) => !b.hidden).length,
        activeIsHtml: pane.previewPaneState().active.startsWith('html:'),
        frameFill: { frame: Math.round(frameBox.height), body: Math.round(bodyBox.height) } };
    `);
    assert.equal(tabs.error, undefined, tabs.error);
    assert.deepEqual(tabs.labels, ["cover.svg", "report.pdf", "报告.md", "page.html"], "one tab per file, the repeat reused its tab");
    assert.equal(tabs.pdfEmbedded, true, "the PDF reader is embedded in the pane");
    assert.equal(tabs.pdfModal, false, "no full-screen PDF reader");
    assert.equal(tabs.pdfCanvas, true, "the PDF rendered a page");
    assert.equal(tabs.pdfClose, false, "the pane owns closing the embedded reader");
    assert.equal(tabs.md, "报告标题", "the Markdown artifact rendered");
    assert.equal(tabs.sandbox, "allow-same-origin", "HTML keeps the script-free sandbox");
    assert.equal(tabs.scriptRan, "", "scripts in an HTML preview do not run");
    assert.equal(tabs.visible, 1, "only the active tab is shown");
    assert.equal(tabs.activeIsHtml, true, "the last opened file is the active tab");
    assert.ok(tabs.frameFill.body > 600 && Math.abs(tabs.frameFill.frame - tabs.frameFill.body) <= 2, `the HTML page fills its tab (${JSON.stringify(tabs.frameFill)})`);

    // 3. Switching and closing tabs; closing the last closes the pane.
    const closing = await run(`
      root.querySelectorAll('.preview-pane-tab-label')[1].click();
      const afterSelect = pane.previewPaneState().active;
      root.querySelectorAll('.preview-pane-tab-close')[1].click();
      const afterClose = pane.previewPaneState();
      const pdfGone = !root.querySelector('.pdf-viewer');
      for (const x of [...root.querySelectorAll('.preview-pane-tab-close')]) x.click();
      await settle();
      return { afterSelect, afterClose, pdfGone, final: pane.previewPaneState(), hidden: root.hidden, open: shell.classList.contains('preview-pane-open') };
    `);
    assert.equal(closing.error, undefined, closing.error);
    assert.ok(closing.afterSelect.startsWith("pdf:"), "clicking a tab selects it");
    assert.equal(closing.afterClose.tabs.length, 3);
    assert.equal(closing.pdfGone, true, "closing the PDF tab disposes the reader");
    assert.equal(closing.final.open, false, "closing the last tab closes the pane");
    assert.equal(closing.hidden, true);
    assert.equal(closing.open, false, "the grid gives the column back to the chat");

    // 4. At most 8 tabs; the oldest makes room.
    const many = await run(`
      for (let i = 0; i < 10; i += 1) pane.tryOpenInPreviewPane({ kind: 'image', src: ${JSON.stringify(IMG)} + '#' + i, title: 'img-' + i + '.png' });
      await settle();
      const labels = [...root.querySelectorAll('.preview-pane-tab-label')].map((n) => n.textContent);
      pane.closePreviewPane();
      return { labels };
    `);
    assert.equal(many.error, undefined, many.error);
    assert.equal(many.labels.length, 8);
    assert.equal(many.labels[0], "img-2.png", "the two oldest tabs were closed");

    // 5. The right column is shared with the collaboration panel.
    const shared = await run(`
      const collab = await import(${JSON.stringify(moduleUrl("collaboration-panel-shell.js"))});
      document.getElementById('collaborationPanelToggle').hidden = false;
      const panelShell = collab.initCollaborationPanelShell({});
      viewer.openImageViewer(${JSON.stringify(IMG)}, 'a.svg');
      panelShell.openPanel();
      await settle();
      const paneAfterCollab = pane.previewPaneState().open;
      const collabOpen = panelShell.isOpen();
      viewer.openImageViewer(${JSON.stringify(IMG)}, 'b.svg');
      await settle();
      const collabAfterPreview = panelShell.isOpen();
      const bothClasses = shell.classList.contains('collaboration-panel-open') && shell.classList.contains('preview-pane-open');
      // An image inside the collaboration panel keeps the modal.
      pane.closePreviewPane();
      viewer.openImageViewer(${JSON.stringify(IMG)}, 'c.svg', { modal: true });
      await settle();
      const lightbox = Boolean(document.querySelector('body > .image-viewer'));
      document.querySelector('body > .image-viewer')?.remove();
      panelShell.destroy();
      return { paneAfterCollab, collabOpen, collabAfterPreview, bothClasses, lightbox, paneOpen: pane.previewPaneState().open };
    `);
    assert.equal(shared.error, undefined, shared.error);
    assert.equal(shared.collabOpen, true);
    assert.equal(shared.paneAfterCollab, false, "opening the collaboration panel closes the preview");
    assert.equal(shared.collabAfterPreview, false, "opening a preview closes the collaboration panel");
    assert.equal(shared.bothClasses, false, "never both in column 4");
    assert.equal(shared.lightbox, true, "modal: true keeps the full-screen view");
    assert.equal(shared.paneOpen, false);

    // 6. Narrow window: the pane floats over the workbench, no resize handle.
    win.setSize(900, 800);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const narrow = await run(`
      viewer.openImageViewer(${JSON.stringify(IMG)}, 'n.svg');
      pdf.openPdfViewer({ title: 'a-very-long-report-name-for-the-quarter.pdf', data: ${JSON.stringify(pdfData)} });
      pane.tryOpenInPreviewPane({ kind: 'markdown', path: '/ws/another-long-markdown-name.md' });
      await waitFor(() => root.querySelector('.pdf-viewer.is-embedded .pdf-viewer-toolbar'));
      await settle(200);
      const edge = Math.round(root.getBoundingClientRect().right);
      root.querySelectorAll('.preview-pane-tab-label')[1].click();
      await settle();
      const overflow = [...root.querySelectorAll('.preview-pane-close, .preview-pane-action, .pdf-viewer-actions button')]
        .filter((n) => n.getBoundingClientRect().width && Math.round(n.getBoundingClientRect().right) > edge)
        .map((n) => n.className + ':' + Math.round(n.getBoundingClientRect().right) + '>' + edge);
      const bar = root.querySelector('.preview-pane-bar').getBoundingClientRect();
      const onTop = root.contains(document.elementFromPoint(Math.round(bar.left + 40), Math.round(bar.top + bar.height / 2)));
      const out = { overflow, onTop, mode: shell.dataset.previewMode, position: getComputedStyle(root).position,
        handle: document.getElementById('previewResizeHandle').hidden, width: Math.round(root.getBoundingClientRect().width) };
      pane.closePreviewPane();
      return out;
    `);
    assert.equal(narrow.error, undefined, narrow.error);
    assert.equal(narrow.mode, "overlay");
    assert.deepEqual(narrow.overflow, [], "narrow: every control stays inside the pane");
    assert.equal(narrow.onTop, true, "narrow: the pane's tab bar is not covered by the topbar");
    assert.equal(narrow.position, "fixed", "narrow: floats over the chat");
    assert.equal(narrow.handle, true, "narrow: no resize handle");
    assert.ok(narrow.width <= 560, `narrow: bounded width (${narrow.width}px)`);

    // 7. HTML and Markdown cards in the chat carry "open on the right".
    win.setSize(1600, 1000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cards = await run(`
      const { renderHtmlBlock } = await import(${JSON.stringify(moduleUrl("html-renderer.js"))});
      const card = renderHtmlBlock({ path: '/ws/out/card.html', html: '<p>卡片</p>', title: 'card.html' });
      document.body.appendChild(card);
      const inlineFrame = Boolean(card.querySelector('iframe'));
      const buttons = [...card.querySelectorAll('button')];
      const openRight = card.querySelector('.assistant-preview-open');
      // Icon-only: no printed label; the label is the accessible name and the tooltip.
      const cardIcons = buttons.map((b) => ({ text: b.textContent.trim(), aria: b.getAttribute('aria-label') || '', tip: getComputedStyle(b, '::after').content, svg: Boolean(b.querySelector('svg')) }));
      openRight?.click();
      await settle();
      const state = pane.previewPaneState();
      card.remove();
      pane.closePreviewPane();
      const barIcons = [...root.querySelectorAll('.preview-pane-bar button')].map((b) => ({ text: b.textContent.trim(), aria: b.getAttribute('aria-label') || '', tip: getComputedStyle(b, '::after').content, svg: Boolean(b.querySelector('svg')) }));
      return { found: Boolean(openRight), state, inlineFrame, cardIcons, barIcons };
    `);
    assert.equal(cards.error, undefined, cards.error);
    assert.equal(cards.found, true, "the HTML card has an open-on-the-right action");
    assert.equal(cards.inlineFrame, false, "the chat shows a card, the content is in the pane");
    for (const [where, icons] of [["card", cards.cardIcons], ["pane bar", cards.barIcons]]) {
      assert.ok(icons.length >= 2, `${where}: has icon buttons`);
      for (const icon of icons) {
        assert.equal(icon.text, "", `${where}: an icon button prints no label (${icon.aria})`);
        assert.equal(icon.svg, true, `${where}: an icon button draws its icon (${icon.aria})`);
        assert.ok(icon.aria, `${where}: an icon button has an accessible name`);
        assert.equal(icon.tip, JSON.stringify(icon.aria), `${where}: the tooltip shows the label (${icon.aria})`);
      }
    }
    assert.deepEqual(cards.state.tabs, ["html:/ws/out/card.html"]);

    // 7b. With the pane open the chat narrows; artifact cards re-flow by the
    //     chat's width, so a file's name is never cut to a few letters.
    const flow = await run(`
      const { renderResultBlocks } = await import(${JSON.stringify(moduleUrl("turn-block-renderers.js"))});
      viewer.openImageViewer(${JSON.stringify(IMG)}, 'open.svg');
      const host = document.createElement('div');
      host.className = 'assistant-turn-artifacts';
      document.getElementById('sessionMessagesStack').appendChild(host);
      renderResultBlocks(host, [
        { id: 'a', type: 'artifact', artifactType: 'html', path: '/ws/output/qa/diagram-preview.html', relativePath: 'output/qa/diagram-preview.html', bytes: 18432, source: 'tool_write' },
        { id: 'b', type: 'artifact', artifactType: 'markdown', path: '/ws/output/CAPABILITY-REPORT.md', relativePath: 'output/CAPABILITY-REPORT.md', bytes: 5120, source: 'tool_write' },
        { id: 'c', type: 'artifact', artifactType: 'html', path: '/ws/output/app/index.html', relativePath: 'output/app/index.html', bytes: 40960, source: 'tool_write' },
        { id: 'd', type: 'artifact', artifactType: 'pdf', path: '/ws/output/05_经营分析报告.pdf', relativePath: 'output/05_经营分析报告.pdf', bytes: 416153, source: 'tool_output' },
        { id: 'e', type: 'artifact', path: '/ws/output/02_经营数据.xlsx', relativePath: 'output/02_经营数据.xlsx', ext: '.xlsx', bytes: 103936, source: 'tool_output' },
        { id: 'f', type: 'artifact', path: '/ws/output/04_经营分析报告.docx', relativePath: 'output/04_经营分析报告.docx', ext: '.docx', bytes: 235315, source: 'tool_write' },
      ]);
      await settle(200);
      const names = [...host.querySelectorAll('.assistant-preview-card-name')].map((n) => ({ text: n.textContent, cut: n.scrollWidth > n.clientWidth + 1 }));
      const cards = [...host.querySelectorAll('.assistant-renderer-artifact')].map((c) => ({
        name: c.querySelector('.assistant-preview-card-name')?.textContent || '',
        meta: c.querySelector('.assistant-preview-card-text .assistant-renderer-meta')?.textContent || '',
        opens: Boolean(c.querySelector('.assistant-preview-open')),
      }));
      host.remove();
      pane.closePreviewPane();
      return { names, cards, paneOpen: true };
    `);
    assert.equal(flow.error, undefined, flow.error);
    assert.deepEqual(flow.names.map((n) => n.text), ["diagram-preview.html", "CAPABILITY-REPORT.md", "index.html", "05_经营分析报告.pdf", "02_经营数据.xlsx", "04_经营分析报告.docx"], "cards lead with the file's own name");
    assert.deepEqual(flow.cards.map((c) => [c.meta.split(" · ")[0], c.opens]), [["HTML", true], ["Markdown", true], ["HTML", true], ["PDF", true], ["XLSX", false], ["DOCX", false]], "readable files open on the right; others show their type");
    assert.deepEqual(flow.names.filter((n) => n.cut).map((n) => n.text), [], "no card name is truncated beside the open pane");

    // 8. No pane (the standalone collaboration window): the old modals open.
    await win.loadURL(pathToFileURL(path.join(ROOT, "src/renderer/index.html")).href + "?view=collaboration");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const standalone = await run(`
      shell.dataset.appView = 'collaboration';
      viewer.openImageViewer(${JSON.stringify(IMG)}, 's.svg');
      pdf.openPdfViewer({ title: 's.pdf', data: ${JSON.stringify(pdfData)} });
      await settle();
      return { opened: pane.tryOpenInPreviewPane({ kind: 'image', src: ${JSON.stringify(IMG)} }), lightbox: Boolean(document.querySelector('body > .image-viewer')), pdfModal: Boolean(document.querySelector('body > .pdf-viewer')) };
    `);
    assert.equal(standalone.error, undefined, standalone.error);
    assert.equal(standalone.opened, false, "no pane in the standalone window");
    assert.equal(standalone.lightbox, true, "the image falls back to the lightbox");
    assert.equal(standalone.pdfModal, true, "the PDF falls back to the full-screen reader");

    console.log("test-preview-pane: ok");
    exitAndRemove({ app, window: win, directory: dir, timer, code: 0 });
  } catch (error) {
    console.error(error);
    exitAndRemove({ app, window: win, directory: dir, timer, code: 1 });
  }
});
