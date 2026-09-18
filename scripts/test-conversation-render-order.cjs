#!/usr/bin/env node
// Real DOM, production message entry points, deterministic frame interleaving.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/modules/message.js'), 'utf8');
const functions = source.slice(source.indexOf('function appendCommittedMessage('), source.indexOf('function appendUserMessage('));
const current = source.slice(source.indexOf('export function isConversationRenderCurrent('), source.indexOf('function scheduleCommittedRenderPump(')).replace('export ', '');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-render-order-'));
const page = path.join(tempDir, 'index.html');
fs.writeFileSync(page, '<!doctype html><html><body></body></html>');
const moduleBase = pathToFileURL(path.join(root, 'src/renderer/modules/')).href;
let win;
const timeout = setTimeout(() => { console.error('render order timeout'); app.exit(1); process.exit(1); }, 30000);
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false } });
  await win.loadURL(pathToFileURL(page).href);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const model = await import('${moduleBase}message-committed-render-model.js');
    const keyModel = await import('${moduleBase}message-render-keys.js');
    let windowRenderer = {};
    try { windowRenderer = await import('${moduleBase}committed-window-renderer.js'); } catch {}
    // A live article is now identified from the list itself (class + turn id),
    // not from a Map kept beside it, so the harness exercises the real lookup.
    const mount = await import('${moduleBase}turn-article-mount.js');
    const failures = [];
    const check = (ok, label) => { if (!ok) failures.push(label); };
    const make = n => ({role:'user',turnId:'t'+n,content:'m'+n,timestamp:new Date(1700000000000+n*1000).toISOString()});
    function harness(messages) {
      const listEl = document.createElement('section'); document.body.append(listEl);
      const panel = {listEl, renderGeneration:0};
      const runtime = {committedMessages:messages};
      const frames = [], keys = new Map(), views = new Map([['audit',panel]]);
      const append = (_id,m,anchor,key) => { const el=document.createElement('article'); el.dataset.messageKey=key; el.textContent=m.content; listEl.insertBefore(el,anchor); };
      const scope = {...model,...keyModel,...windowRenderer,...mount,
        getRuntimeSession:()=>runtime, renderedMessageKeys:keys, sessionViews:views,
        view:()=>panel,ensurePanel:()=>panel,
        appendUserMessage:append,appendFinalAssistantArticle:append,appendSwitchNoticeArticle:append,
        scheduleCommittedRenderPump:fn=>frames.push(fn),syncWorkbenchEmptyState:()=>{}};
      const api = new Function(...Object.keys(scope), ${JSON.stringify(functions + '\n' + current + '\nreturn {render:renderCommittedMessages,current:isConversationRenderCurrent};')})(...Object.values(scope));
      return {panel,runtime,listEl,frames,keys,render:opts=>api.render('audit',opts),current:()=>api.current('audit'),
        drain:()=>{let n=0;while(frames.length && n++<1000)frames.shift()();check(n<1000,'bounded pump');},
        order:()=>[...listEl.querySelectorAll('[data-message-key]')].map(el=>el.textContent)};
    }
    const h=harness(Array.from({length:100},(_,i)=>make(i)));
    h.render(); check(h.order().length===5,'history remains chunked');
    check(!h.current(),'pending frames are not rendered content');
    h.runtime.committedMessages.push(make(100)); h.render(); h.drain();
    check(JSON.stringify(h.order())===JSON.stringify(Array.from({length:101},(_,i)=>'m'+i)),'new message cannot overtake unfinished history');
    h.listEl.insertBefore(h.listEl.lastChild,h.listEl.firstChild);
    check(!h.current(),'cache rejects wrong DOM order');
    h.render(); h.drain(); check(h.order()[0]==='m0' && h.current(),'incremental render repairs existing order');
    const late=harness([make(0),make(2)]); late.render();
    const preserved=late.listEl.firstChild;
    late.runtime.committedMessages.push(make(1));late.render();late.drain();
    check(late.order().join(',')==='m0,m1,m2','late historical message inserts before successor');
    check(late.listEl.firstChild===preserved,'existing articles retain identity');
    const reset=harness(Array.from({length:100},(_,i)=>make(i)));reset.render();
    reset.panel.renderGeneration++;reset.listEl.replaceChildren();reset.keys.set('audit',new Set());
    reset.runtime.committedMessages=[make(200)];reset.render();reset.drain();
    check(reset.order().join(',')==='m200','old pump cannot resurrect history after rebuild');
    const live=harness([make(0)]);const article=document.createElement('article');
    article.className='assistant-turn-article is-live';article.dataset.turnId='t0';live.listEl.append(article);
    live.runtime.turnId='t0';live.runtime.liveTurn={turnId:'t0'};
    live.runtime.committedMessages.push({...make(0),role:'assistant',content:'answer'});live.render();
    check(live.listEl.lastChild===article && live.order().join(',')==='m0','active answer stays live and last');
    live.runtime.liveTurn.final={type:'turn.completed'};live.render();live.drain();
    check(live.order().join(',')==='m0,answer','skipped live assistant remains eligible after completion');
    const evict=harness(Array.from({length:160},(_,i)=>make(i)));evict.render();
    evict.runtime.committedMessages.push(make(160));evict.render({allowEvict:true});evict.drain();
    check(evict.order().join(',')===Array.from({length:160},(_,i)=>'m'+(i+1)).join(','),'evicted pending history cannot reappear');
    const detached=harness([make(0),make(1)]);detached.render();
    detached.runtime.committedMessages=[make(1),make(2)];detached.render({allowEvict:false});
    check(detached.order().join(',')==='m0,m1,m2','detached reader retains older mounted history');
    const newer=harness(Array.from({length:100},(_,i)=>make(i)));let completed=0;
    newer.render({onComplete:()=>completed++});
    newer.runtime.committedMessages.push(make(100));newer.render();newer.drain();
    check(completed===1,'completion callback survives superseding render exactly once');
    const first=harness(Array.from({length:100},(_,i)=>make(i)));
    const second=harness([make(300)]);first.render();second.render();first.drain();
    check(first.order().length===100 && second.order().join(',')==='m300','render jobs stay isolated by panel');
    const removed=harness(Array.from({length:100},(_,i)=>make(i)));removed.render();
    removed.panel.renderGeneration++;removed.listEl.remove();removed.drain();
    check(removed.order().length===5,'invalidated detached panel stops its old pump');
    const boundary=harness([make(0)]);boundary.render();
    const finalArticle=document.createElement('article');finalArticle.textContent='previous final';
    finalArticle.className='assistant-turn-article is-live';finalArticle.dataset.turnId='t0';boundary.listEl.append(finalArticle);
    boundary.runtime.liveTurn={turnId:'t0',final:{type:'turn.completed'}};
    boundary.runtime.committedMessages.push(make(1));boundary.render();
    check([...boundary.listEl.children].map(el=>el.textContent).join(',')==='m0,previous final,m1','completed live answer retains its position before the next turn starts');
    const duplicate=harness([make(0),make(0),make(1)]);duplicate.render();duplicate.drain();
    check(duplicate.order().join(',')==='m0,m1','same message key mounts only once even within one chunk');
    return failures;
  })()`);
  if (result.length) throw new Error(result.join('\n'));
  console.log('conversation-render-order: all real DOM scenarios passed');
  clearTimeout(timeout); win.destroy(); fs.rmSync(tempDir, {recursive:true,force:true}); app.exit(0);
}).catch(error => {console.error(error);clearTimeout(timeout);win?.destroy();fs.rmSync(tempDir, {recursive:true,force:true});app.exit(1);});
