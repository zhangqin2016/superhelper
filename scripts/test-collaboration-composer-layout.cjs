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
      <div class="collaboration-composer"><textarea id="composer" rows="1" placeholder="输入消息"></textarea><div class="collaboration-composer-toolbar"><button id="collaborationAttachButton">+</button><span class="collaboration-composer-spacer"></span><button id="collaborationSendButton">发送</button></div></div>
    </aside></body></html>`);
  win = new BrowserWindow({ show: false, width: 600, height: 700, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(page);
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  const result = await win.webContents.executeJavaScript(`(()=>{
    const composer=document.querySelector('.collaboration-composer'), textarea=document.getElementById('composer'), toolbar=document.querySelector('.collaboration-composer-toolbar');
    const send=document.getElementById('collaborationSendButton');
    const c=getComputedStyle(composer), t=getComputedStyle(textarea), tr=textarea.getBoundingClientRect(), br=toolbar.getBoundingClientRect(), sr=send.getBoundingClientRect();
    return {display:c.display,direction:c.flexDirection,outline:t.outlineStyle,shadow:t.boxShadow,
      inputBorder:t.borderTopWidth,
      // The two zones stack: the input sits above the toolbar row.
      inputAboveToolbar:tr.bottom<=br.top+1,
      toolbarFullWidth:Math.abs(br.width-tr.width)<2,
      // The send button trails on the bottom row and is a text button, not an icon square.
      sendTrails:sr.right>=br.right-13 && sr.left>tr.left+tr.width*0.4,
      sendIsText:sr.width>44};
  })()`);
  // Text and actions share one surface; neither gets a second input border.
  assert.deepEqual(result, { display: "flex", direction: "column", outline: "none", shadow: "none",
    inputBorder: "0px", inputAboveToolbar: true, toolbarFullWidth: true, sendTrails: true, sendIsText: true },
    "the floating composer contains a borderless input and a full-width action row");
  for (const theme of ["light", "dark"]) {
    const surface = await win.webContents.executeJavaScript(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      const el = document.querySelector('.collaboration-composer'), c = getComputedStyle(el);
      const input = el.querySelector('textarea').getBoundingClientRect();
      const toolbar = el.querySelector('.collaboration-composer-toolbar').getBoundingClientRect();
      return { inset: parseFloat(c.marginLeft) >= 10 && parseFloat(c.marginRight) >= 10 && parseFloat(c.marginBottom) >= 10,
        enclosed: ['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'].every(k => parseFloat(c[k]) > 0),
        rounded: parseFloat(c.borderTopLeftRadius) >= 10, elevated: c.boxShadow !== 'none',
        separated: toolbar.top - input.bottom >= 8 };
    })()`);
    assert.deepEqual(surface, { inset: true, enclosed: true, rounded: true, elevated: true, separated: true },
      `${theme}: draft and toolbar must sit inside one inset, rounded surface with breathing room`);
  }
  // ---- The input grows with the text, and the button tells the truth -----
  // Both were missing: the stylesheet has `max-height: 132px`, which only
  // makes sense for a box that grows, but nothing ever set the height — six
  // lines scrolled inside a 36px window. And the send button was enabled with
  // an empty box, while `send()` refuses a blank message, so it looked live
  // and did nothing.
  const moduleUrl = pathToFileURL(path.join(__dirname, "../src/renderer/modules/collaboration-composer.js")).href;
  const growth = await win.webContents.executeJavaScript(`(async () => { try {
    const { initCollaborationComposer } = await import(${JSON.stringify(moduleUrl)});
    const textarea = document.getElementById('composer');
    const sendButton = document.getElementById('collaborationSendButton');
    const composer = initCollaborationComposer({ textarea, sendButton,
      getConversationId: () => 'c1',
      api: () => ({ send: async () => ({ ok: true, state: 'persisted' }),
        saveDraft: async () => ({ ok: true }), getDraft: async () => ({ ok: true, text: '' }) }) });
    composer.setConversation('c1');
    composer.setActive(true);
    const type = (value) => { textarea.value = value; textarea.dispatchEvent(new Event('input', { bubbles: true })); void document.body.offsetHeight; };
    const height = () => Math.round(textarea.getBoundingClientRect().height);
    type('');
    const empty = { height: height(), disabled: sendButton.disabled };
    type('一行');
    const oneLine = { height: height(), disabled: sendButton.disabled };
    const NL = String.fromCharCode(10);
    type(['1','2','3','4','5','6','7','8','9','10'].join(NL));
    const many = { height: height(), disabled: sendButton.disabled,
      // Past the stylesheet's cap it must scroll rather than grow forever.
      scrolls: textarea.scrollHeight > textarea.clientHeight + 1 };
    // Clearing must shrink it back: growing only one way would leave the box
    // tall after a send.
    type('');
    const cleared = { height: height(), disabled: sendButton.disabled };
    // Whitespace is not a message.
    type('   ' + NL + '  ');
    const blank = { disabled: sendButton.disabled };
    type('保留的草稿');
    composer.setReply({ messageId: 'quoted' });
    composer.refreshReply([{ id: 'quoted', conversationId: 'c1', bodyText: '引用正文'.repeat(100), state: 'persisted' }]);
    const preview = document.getElementById('collaborationReplyPreview');
    const close = preview.querySelector('[data-action="clear-reply"]');
    const reply = { visible: !preview.hidden, layout: getComputedStyle(preview).display,
      buttonBorder: getComputedStyle(close).borderTopWidth,
      fits: preview.scrollWidth <= preview.clientWidth + 1, accessible: Boolean(close.getAttribute('aria-label')) };
    close.click();
    reply.cleared = preview.hidden;
    reply.draftPreserved = textarea.value === '保留的草稿';
    composer.destroy();
    return JSON.stringify({ empty, oneLine, many, cleared, blank, reply });
  } catch (error) { return JSON.stringify({ error: String(error && error.stack || error) }); } })()`);
  const grown = JSON.parse(growth);
  assert.ok(!grown.error, `the composer must initialise in the harness: ${grown.error || ""}`);
  assert.equal(grown.empty.disabled, true, "send is disabled with an empty box: send() refuses a blank message anyway");
  assert.equal(grown.blank.disabled, true, "whitespace alone is not a message");
  assert.deepEqual(grown.reply, { visible: true, layout: 'grid', buttonBorder: '0px', fits: true,
    accessible: true, cleared: true, draftPreserved: true }, 'long quoted text fits; accessible dismiss preserves the draft');
  assert.equal(grown.oneLine.disabled, false, "typing enables send");
  assert.ok(grown.many.height > grown.oneLine.height + 20,
    `the input grows with the text: ${grown.oneLine.height}px -> ${grown.many.height}px`);
  assert.ok(grown.many.height <= 160, `growth is capped by the stylesheet (max-height 150px), not unbounded: ${grown.many.height}px`);
  assert.equal(grown.many.scrolls, true, "past the cap the input scrolls instead of growing");
  assert.equal(grown.cleared.height, grown.empty.height,
    `clearing shrinks the input back to one line: ${grown.cleared.height}px vs ${grown.empty.height}px`);
  console.log("collaboration composer layout: floating surface in both themes, grows with text, honest send button");
}).then(() => finish(0)).catch((error) => { console.error(error); finish(1); });
