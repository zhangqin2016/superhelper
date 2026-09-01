"use strict";
// Renderer + real Chromium DOM; preload is a controllable authorized-cache stub,
// not a claim of a production two-client/server run.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron: electron scripts/test-collaboration-reply-ui.cjs"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-reply-ui-"));
app.setPath("userData", path.join(dir, "userData"));
app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => { console.error("reply UI timed out"); finish(1); }, 30_000);
function finish(code) { clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }
async function exerciseSourceMasks(moduleUrl) {
  const { initCollaborationCenter } = await import(moduleUrl);
  const check = (value, label) => { if (!value) throw new Error(label); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const waitFor = async (predicate, label) => { for (let i=0;i<100;i++) { if (predicate()) return; await tick(); } throw new Error(label); };
  for (const evidence of ['revoked','unavailable','legacy','own-revoked','source-revoked']) {
    document.body.replaceChildren();
    const make = (id, tag='div', parent=document.body) => { const node=document.createElement(tag); node.id=id; parent.append(node); return node; };
    make('collaborationNavButton','button'); make('workbenchNavButton','button'); const shell=make('centerPanel'),panel=make('collaborationCenter','div',shell);
    for (const id of ['collaborationInboxColumn','collaborationInbox','collaborationFriends','collaborationTeams','collaborationStatus','collaborationLive','collaborationScopeBadge','collaborationTimeline','collaborationConversationEmpty','collaborationReplyPreview']) make(id,'div',panel);
    make('collaborationLoadOlder','button',panel); make('collaborationComposer','textarea',panel); make('collaborationSendButton','button',panel);
    const snapshot={status:'available',messageId:'source',revision:1,senderUserId:'peer',createSeq:10,kind:'text',bodyText:'SECRET SNAPSHOT',truncated:false};
    const source={id:'source',conversationId:'A',seq:10,revision:1,kind:'text',bodyText:'CURRENT SOURCE'};
    const oldReply={id:'old-reply',conversationId:'A',seq:11,revision:1,kind:'text',bodyText:'old reply',replyToMessageId:'source',replySnapshot:snapshot};
    const newReply={...oldReply,id:'new-reply',seq:12,bodyText:'new reply'};
    const rows=[source,oldReply,newReply];
    let phase='initial', releaseOlder, publish, allowed=['A','B'], holdOpen=false, releaseOpen, denied=false;
    const shouldMask=!['legacy','own-revoked'].includes(evidence);
    const latest = () => evidence==='source-revoked' ? [{...source,revokedAt:'now',bodyText:'',revision:2},newReply] : [{...newReply,
      ...(evidence==='own-revoked'?{revokedAt:'now',bodyText:''}:{}),replySnapshot:evidence==='legacy'?{status:'unavailable',reason:'legacy'}:evidence==='own-revoked'?{status:'unavailable'}:{status:evidence}}];
    window.assistantClient={collaboration:{
      list:async()=>({ok:true,conversations:allowed.map(id=>({id}))}),
      getDraft:async()=>({ok:true,text:'draft',replyToMessageId:'source',mentionUserIds:[]}), saveDraft:async()=>({ok:true}),
      onStateChange:callback=>{publish=callback;return()=>{};},
      open:async(id,beforeSeq)=>{
        if (holdOpen) await new Promise(resolve=>{releaseOpen=resolve;});
        if (denied && id==='A') return {ok:false,code:'COLLAB_ACCESS_REVOKED'};
        return {ok:true,conversation:{id,scopeId:'personal'},messages:(id==='B'?rows:beforeSeq!=null?[{...oldReply,id:'even-older',seq:5}]:phase==='latest'?latest():phase==='weaker'?[{...newReply,replySnapshot:{status:'revoked'}}]:rows).map(row=>({...row,conversationId:id})),hasMore:beforeSeq==null,nextBeforeSeq:beforeSeq==null?(phase==='initial'?10:12):5,offline:false};
      },
      readMessages:async({conversationId,messageIds})=>{
        if (phase==='latest' && messageIds.includes('old-reply')) return new Promise(resolve=>{releaseOlder=resolve;});
        return {ok:true,messages:rows.filter(row=>messageIds.includes(row.id)).map(row=>({...row,conversationId})),unavailableMessageIds:[]};
      },
    }};
    const center=initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true}})});
    center.show(); await center.open('A'); await tick(); await tick();
    const quote=id=>document.querySelector('[data-message-key="'+id+'"] .collaboration-reply-quote');
    const preview=()=>document.getElementById('collaborationReplyPreview');
    const row=document.querySelector('[data-message-key="old-reply"]'), body=row.querySelector('.collaboration-message-body'), oldQuote=quote('old-reply');
    check(oldQuote.textContent==='SECRET SNAPSHOT','initial sent quote is immutable, not current source body');
    phase='latest'; const refresh=center.open('A',{userNavigation:false}); await waitFor(()=>releaseOlder,'older cache request is held');
    if (shouldMask) {
      check(!oldQuote.textContent.includes('SECRET SNAPSHOT'),'latest '+evidence+' masks sibling quote before older cache settles');
      check(!preview().textContent.includes('CURRENT SOURCE'),'latest '+evidence+' immediately masks current draft source preview');
      check(!document.querySelector('[data-message-key="source"] .collaboration-message-body').textContent.includes('CURRENT SOURCE'),'known source mask also hides stale source body');
    } else check(oldQuote.textContent==='SECRET SNAPSHOT',evidence+' does not poison sibling quote');
    check(row===document.querySelector('[data-message-key="old-reply"]') && body===row.querySelector('.collaboration-message-body') && oldQuote===quote('old-reply'),'source masks preserve keyed row/body/quote identities');
    releaseOlder({ok:true,messages:[source,oldReply],unavailableMessageIds:[]}); await refresh;
    if (shouldMask) check(!quote('old-reply').textContent.includes('SECRET SNAPSHOT'),'late stale cache cannot resurrect '+evidence+' quote');
    await center.loadOlder();
    check(document.querySelector('[data-message-key="even-older"]'),'older pagination coverage is preserved');
    if (shouldMask) check(!quote('even-older').textContent.includes('SECRET SNAPSHOT'),'subsequent older page inherits source mask');
    if (evidence==='unavailable') {
      phase='weaker'; await center.open('A',{userNavigation:false});
      const {t}=await import(new URL('../i18n/index.js',moduleUrl));
      check(quote('old-reply').textContent===t('collaboration.reply.unavailable'),'unavailable dominates later revoked evidence');
    }
    if (shouldMask) {
      phase='initial'; await center.open('B'); await tick();
      check(quote('old-reply').textContent==='SECRET SNAPSHOT','same source ID in another conversation is not masked');
      await center.open('A'); await tick();
      check(!quote('old-reply').textContent.includes('SECRET SNAPSHOT'),'returning to conversation keeps observed monotone mask');
      holdOpen=true; const staleOpen=center.open('A',{userNavigation:false}); await waitFor(()=>releaseOpen,'stale authorization open held');
      allowed=['B']; publish({type:'access-revoked',state:{ok:true}}); await waitFor(()=>document.getElementById('collaborationTimeline').children.length===0,'current revoked view cleared');
      holdOpen=false; releaseOpen(); await staleOpen;
      check(document.getElementById('collaborationTimeline').children.length===0,'late pre-revocation open cannot restore revoked view or source masks');
      allowed=['A','B']; await center.open('A'); await tick();
      check(quote('old-reply').textContent==='SECRET SNAPSHOT','confirmed conversation revocation forgets masks before a fresh grant');
      phase='latest'; releaseOlder=null; const remask=center.open('A',{userNavigation:false}); await waitFor(()=>releaseOlder,'remask older request'); releaseOlder({ok:true,messages:[source,oldReply],unavailableMessageIds:[]}); await remask;
      await center.open('B'); allowed=['B']; publish({type:'access-revoked',state:{ok:true}}); await tick(); await tick();
      allowed=['A','B']; phase='initial'; await center.open('A'); await tick();
      check(quote('old-reply').textContent==='SECRET SNAPSHOT','inactive conversation revocation also forgets masks before regrant');
      phase='latest'; releaseOlder=null; const beforeDenied=center.open('A',{userNavigation:false}); await waitFor(()=>releaseOlder,'mask before denied open'); releaseOlder({ok:true,messages:[source,oldReply],unavailableMessageIds:[]}); await beforeDenied;
      await center.open('B'); denied=true; await center.open('A'); denied=false; phase='initial'; await center.open('A'); await tick();
      check(quote('old-reply').textContent==='SECRET SNAPSHOT','explicit denied open forgets inactive target masks before fresh regrant');
      publish({type:'availability',state:{ok:true}}); await tick(); center.show(); await center.open('A'); await tick();
      check(quote('old-reply').textContent==='SECRET SNAPSHOT','account reset removes old account source masks');
    }
    center.destroy();
  }
}
async function exerciseBatchedMasks(moduleUrl) {
  const { initCollaborationCenter } = await import(moduleUrl);
  const check=(value,label)=>{if(!value)throw new Error(label);};
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  const waitFor=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await tick();}throw new Error(label);};
  document.body.replaceChildren();
  const make=(id,tag='div',parent=document.body)=>{const node=document.createElement(tag);node.id=id;parent.append(node);return node;};
  make('collaborationNavButton','button');make('workbenchNavButton','button');const shell=make('centerPanel'),panel=make('collaborationCenter','div',shell);
  for(const id of ['collaborationInboxColumn','collaborationInbox','collaborationFriends','collaborationTeams','collaborationStatus','collaborationLive','collaborationScopeBadge','collaborationTimeline','collaborationConversationEmpty','collaborationReplyPreview'])make(id,'div',panel);
  make('collaborationLoadOlder','button',panel);make('collaborationComposer','textarea',panel);make('collaborationSendButton','button',panel);
  const rows=Array.from({length:402},(_,i)=>({id:'message-'+(i+1),conversationId:'A',seq:i+1,revision:1,kind:'text',bodyText:i===0?'SECRET SOURCE':'body '+(i+1)}));
  rows[200]={...rows[200],replyToMessageId:'message-1',replySnapshot:{status:'available',messageId:'message-1',revision:1,senderUserId:'peer',createSeq:1,kind:'text',bodyText:'SECRET QUOTE',truncated:false}};
  let phase=1,releaseSecond,rejectSecond;
  const batches=[];
  window.assistantClient={collaboration:{
    list:async()=>({ok:true,conversations:[{id:'A'},{id:'B'}]}),getDraft:async()=>({ok:true,text:'draft',replyToMessageId:'message-1',mentionUserIds:[]}),
    open:async(id)=>({ok:true,conversation:{id,scopeId:'personal'},messages:id==='B'?[{id:'b',conversationId:'B',seq:1,bodyText:'B BODY'}]:rows.slice(phase===1?0:phase===2?200:202,phase===1?200:phase===2?400:402),hasMore:true,nextBeforeSeq:phase===1?1:phase===2?201:203,offline:false}),
    readMessages:async({conversationId,messageIds})=>{
      if(phase===3 && messageIds.length>1)batches.push([...messageIds]);
      if(phase===3 && messageIds.includes('message-201'))return new Promise((resolve,reject)=>{releaseSecond=resolve;rejectSecond=reject;});
      return {ok:true,messages:rows.filter(row=>messageIds.includes(row.id)).map(row=>phase===3 && row.id==='message-1'?{...row,revision:2,revokedAt:'now',bodyText:''}:{...row,conversationId}),unavailableMessageIds:[]};
    },
  }};
  const center=initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true}})});center.show();await center.open('A');await tick();phase=2;await center.open('A',{userNavigation:false});await tick();
  const timeline=document.getElementById('collaborationTimeline'),oldRow=timeline.querySelector('[data-message-key="message-201"]'),oldBody=oldRow.querySelector('.collaboration-message-body'),oldQuote=oldRow.querySelector('.collaboration-reply-quote');
  phase=3;const refresh=center.open('A',{userNavigation:false});await waitFor(()=>releaseSecond,'second 200-ID cache batch held');
  check(batches.length===2 && batches[0].length===200 && batches[1].length===2,'actual visible-history path splits 202 IDs into two batches');
  check(!oldQuote.textContent.includes('SECRET QUOTE'),'first cache batch masks sibling quote while later batch is held');
  check(!timeline.querySelector('[data-message-key="message-1"] .collaboration-message-body').textContent.includes('SECRET SOURCE'),'first cache batch masks original source immediately');
  check(!document.getElementById('collaborationReplyPreview').textContent.includes('SECRET SOURCE'),'first cache batch masks selected draft preview immediately');
  check(oldRow===timeline.querySelector('[data-message-key="message-201"]') && oldBody===oldRow.querySelector('.collaboration-message-body') && oldQuote===oldRow.querySelector('.collaboration-reply-quote'),'per-batch masks preserve row/body/quote identity');
  releaseSecond({ok:true,messages:rows.slice(200,202),unavailableMessageIds:[]});await refresh;
  check(timeline.children.length===402 && !oldQuote.textContent.includes('SECRET QUOTE'),'final stale batch preserves full coverage without resurrecting quote');
  check(document.getElementById('collaborationLoadOlder').hidden===false,'per-batch masking keeps pagination affordance');
  releaseSecond=null;const failingRefresh=center.open('A',{userNavigation:false});await waitFor(()=>releaseSecond,'later cache batch held before failure');
  rejectSecond(new Error('cache batch unavailable'));await failingRefresh;
  const {t}=await import(new URL('../i18n/index.js',moduleUrl));
  check(!oldQuote.textContent.includes('SECRET QUOTE') && document.getElementById('collaborationLive').textContent===t('collaboration.historyLoadFailed'),'later batch failure retains observed mask and the existing refresh error notice');
  releaseSecond=null;const staleRefresh=center.open('A',{userNavigation:false});await waitFor(()=>releaseSecond,'second batch held before navigation');
  await center.open('B');const currentText=timeline.textContent;
  releaseSecond({ok:true,messages:[{...rows[200],bodyText:'LATE OLD CONVERSATION',replySnapshot:{status:'unavailable'}}],unavailableMessageIds:[]});await staleRefresh;
  check(timeline.textContent===currentText && timeline.textContent.includes('B BODY'),'late success batch from old conversation cannot mutate current view');
  center.destroy();
}
app.whenReady().then(async () => {
  const page = path.join(dir, "test.html");
  fs.writeFileSync(page, '<!doctype html><html><body><div id="timeline"></div><div class="collaboration-composer"><div id="collaborationReplyPreview" hidden></div><textarea id="input"></textarea><button id="send">Send</button></div></body></html>');
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(page);
  const moduleUrl = (name) => pathToFileURL(path.join(__dirname, `../src/renderer/${name}`)).href;
  await win.webContents.executeJavaScript(`(async () => {
    const { renderCollaborationTimeline: render } = await import(${JSON.stringify(moduleUrl("modules/collaboration-timeline.js"))});
    const { initCollaborationComposer: init } = await import(${JSON.stringify(moduleUrl("modules/collaboration-composer.js"))});
    const { setLocale, t } = await import(${JSON.stringify(moduleUrl("i18n/index.js"))});
    const check = (ok, why) => { if (!ok) throw new Error(why); };
    const equal = (a,b,why) => check(JSON.stringify(a) === JSON.stringify(b), why + ': ' + JSON.stringify(a));
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
    const root = document.getElementById('timeline'), textarea = document.getElementById('input'), sendButton = document.getElementById('send'), preview = document.getElementById('collaborationReplyPreview');
    const source = {id:'source',conversationId:'a',seq:1,kind:'text',bodyText:'CURRENT SOURCE'};
    const quote = {status:'available',messageId:'source',revision:1,senderUserId:'sender',createSeq:1,kind:'text',bodyText:'<img src=x onerror=alert(1)> https://example.com',truncated:true};
    const reply = {id:'reply',conversationId:'a',seq:2,bodyText:'reply',replyToMessageId:'source',replySnapshot:quote};
    const selected = [];
    let allowed = true;
    const opts = {onReply:message => selected.push(message),canReply:() => allowed};
    render(root, [source,reply], opts);
    let row = root.querySelector('[data-message-key="reply"]');
    const body = row.querySelector('.collaboration-message-body');
    const quoted = row.querySelector('.collaboration-reply-quote');
    check(quoted, 'immutable reply snapshot is rendered');
    check(quoted.textContent.includes(quote.bodyText), 'quote uses snapshot text, not current source');
    check(quoted.textContent.includes(t('collaboration.reply.truncated')), 'truncation has explicit notice');
    check(!root.querySelector('img,a'), 'untrusted quote markup and URL stay plain text');
    render(root, [{...source,bodyText:'CHANGED'}, {...reply,replySnapshot:{...quote}}], opts);
    check(row === root.querySelector('[data-message-key="reply"]') && body === row.querySelector('.collaboration-message-body') && quoted === row.querySelector('.collaboration-reply-quote'), 'equal snapshots preserve row/body/quote DOM identity');
    check(!quoted.textContent.includes('CHANGED'), 'later source edit cannot rebuild sent quote');
    for (const [snapshot,key] of [[{status:'revoked'},'revoked'],[{status:'unavailable'},'unavailable'],[undefined,'legacy'],[{status:'available',kind:'attachment',bodyText:''},'attachment'],[{status:'available',kind:'workspace_share',bodyText:''},'workspace']]) {
      render(root, [{...reply,replySnapshot:snapshot}], opts);
      check(row.querySelector('.collaboration-reply-quote').textContent.includes(t('collaboration.reply.'+key)), 'explicit placeholder for '+key);
    }
    render(root, [{...reply,revokedAt:'now'}], opts);
    check(!row.querySelector('.collaboration-reply-quote') && !row.querySelector('[data-action="reply-message"]'), 'revoked reply reveals neither quote nor reply action');
    render(root, [source,{...reply,seq:null,id:'local'}], opts);
    check(root.querySelectorAll('[data-action="reply-message"]').length === 1, 'only committed messages can be replied to');
    const action = root.querySelector('[data-action="reply-message"]');
    check(action.tagName === 'BUTTON' && action.getAttribute('aria-label') && action.tabIndex === 0, 'reply uses accessible native keyboard button');
    render(root, [{...source,bodyText:'latest'}], opts); action.click();
    check(selected[0].bodyText === 'latest', 'retained action reads latest row data');
    allowed = false; action.click(); check(selected.length === 1, 'permission checked at action time'); allowed = true;
    render(root, [], opts); action.click(); check(selected.length === 1, 'detached action cannot choose a source');

    const saved = new Map([['a',{text:'draft',replyToMessageId:'source',mentionUserIds:['u1','u2']}]]), writes=[], sends=[], errors=[], sent=[];
    let draftRead = id => Promise.resolve({ok:true,...(saved.get(id)||{text:'',replyToMessageId:null,mentionUserIds:[]})});
    let previewRead = request => Promise.resolve({ok:true,messages:[{...source,conversationId:request.conversationId,id:request.messageIds[0],bodyText:'preview '+request.messageIds[0]}],unavailableMessageIds:[]});
    let sendReply = () => Promise.resolve({ok:false,code:'OFFLINE'});
    window.assistantClient = {collaboration:{
      getDraft:id => draftRead(id), readMessages:request => previewRead(request),
      saveDraft:request => { writes.push(request); saved.set(request.conversationId,{text:request.text,replyToMessageId:request.replyToMessageId,mentionUserIds:request.mentionUserIds}); return Promise.resolve({ok:true}); },
      send:request => { sends.push(request); return sendReply(request); },
    }};
    let composer = init({textarea,sendButton,onError:e=>errors.push(e.message),onSent:(r,o)=>sent.push(o)});
    let selectedConversation = '';
    const selectConversation = id => { selectedConversation=id; composer.setConversation(id); };
    const observedIntent = () => ({text:textarea.value,replyToMessageId:saved.get(selectedConversation)?.replyToMessageId||null,mentionUserIds:saved.get(selectedConversation)?.mentionUserIds||[]});
    const type = value => { textarea.value=value; textarea.dispatchEvent(new Event('input')); };
    selectConversation('a'); await tick(); await tick();
    equal(observedIntent(),{text:'draft',replyToMessageId:'source',mentionUserIds:['u1','u2']},'restore complete draft intent');
    check(preview.textContent.includes('preview source'), 'restored ID preview comes from authorized cache');
    sendReply = request => {
      const draft=saved.get(request.conversationId);
      if (draft?.text===request.bodyText && draft.replyToMessageId===request.replyToMessageId && JSON.stringify(draft.mentionUserIds)===JSON.stringify(request.mentionUserIds)) saved.set(request.conversationId,{text:'',replyToMessageId:null,mentionUserIds:[]});
      return Promise.resolve({ok:true});
    };
    type('instant send'); sendButton.click(); await tick();
    check(saved.get('a').text==='', 'input and same-task send preserve IPC write ordering so old saved draft cannot revive');
    composer.destroy(); saved.set('a',{text:'draft',replyToMessageId:'source',mentionUserIds:['u1','u2']});
    composer=init({textarea,sendButton,onError:e=>errors.push(e.message),onSent:(r,o)=>sent.push(o)}); selectConversation('a'); await tick(); await tick(); sendReply=()=>Promise.resolve({ok:false,code:'OFFLINE'});
    type('edited'); composer.setReply({messageId:'other'}); await tick();
    equal(writes.at(-1),{conversationId:'a',text:'edited',replyToMessageId:'other',mentionUserIds:['u1','u2']},'input and reply persist only complete narrow draft');
    preview.querySelector('[data-action="clear-reply"]').click();
    equal(observedIntent(),{text:'edited',replyToMessageId:null,mentionUserIds:['u1','u2']},'clear reply preserves text and mentions');
    check(preview.hidden, 'clear hides inline preview');
    composer.setReply({messageId:'other'}); selectConversation('b'); await tick(); type('b draft'); selectConversation('a'); await tick();
    equal(observedIntent(),{text:'edited',replyToMessageId:'other',mentionUserIds:['u1','u2']},'conversation roundtrip preserves complete intent');
    composer.destroy(); composer=init({textarea,sendButton,onError:e=>errors.push(e.message),onSent:(r,o)=>sent.push(o)}); selectConversation('a'); await tick(); await tick();
    check(observedIntent().replyToMessageId === 'other' && preview.textContent.includes('preview other'), 'reinit restores saved reply and fresh preview');
    const ordinaryPreviewRead=previewRead;
    previewRead=request=>Promise.resolve({ok:true,messages:[{...source,id:request.messageIds[0],conversationId:'foreign',bodyText:'FOREIGN BODY'}]}); composer.setReply({messageId:'other'}); await tick();
    check(!preview.textContent.includes('FOREIGN BODY') && preview.textContent.includes(t('collaboration.reply.unavailable')), 'cache row from another conversation cannot populate preview');
    previewRead=request=>Promise.resolve({ok:true,messages:[{id:request.messageIds[0],bodyText:'UNSCOPED BODY'}]}); composer.setReply({messageId:'other'}); await tick();
    check(!preview.textContent.includes('UNSCOPED BODY'), 'unscoped cache row cannot populate preview');
    previewRead=request=>Promise.resolve({ok:true,messages:[{...source,conversationId:request.conversationId,id:request.messageIds[0],bodyText:'😀'.repeat(513),replySnapshot:{status:'available',bodyText:'NESTED SECRET'}}]}); composer.setReply({messageId:'other'}); await tick();
    check([...preview.querySelector('.collaboration-reply-content').textContent.split('\\n')[0]].length===512 && !preview.textContent.includes('NESTED SECRET'), 'draft preview caps Unicode codepoints and never expands nested quote');
    previewRead=ordinaryPreviewRead;
    sendButton.click(); await tick(); sendButton.click(); await tick();
    check(sends.at(-1).clientCommandId === sends.at(-2).clientCommandId, 'failed retry reuses UUID for full same intent');
    const priorId=sends.at(-1).clientCommandId;
    composer.setReply({messageId:'source'}); sendButton.click(); await tick();
    check(sends.at(-1).clientCommandId !== priorId, 'same text different reply gets new UUID');
    equal(Object.keys(sends.at(-1)).sort(),['bodyText','clientCommandId','conversationId','mentionUserIds','replyToMessageId'].sort(),'send excludes preview/snapshot/draft timestamps');
    const ack=defer(); sendReply=()=>ack.promise; sendButton.click(); await tick(); composer.setReply({messageId:'other'}); ack.resolve({ok:true}); await tick();
    check(textarea.value === 'edited' && observedIntent().replyToMessageId === 'other', 'late ACK cannot clear same-text new reply');
    const crossAck=defer(); sendReply=()=>crossAck.promise; sendButton.click(); await tick(); selectConversation('b'); await tick(); type('new b draft'); crossAck.resolve({ok:true}); await tick();
    check(textarea.value === 'new b draft', 'cross-conversation ACK preserves current body');
    selectConversation('a'); check(!sendButton.disabled, 'switching does not strand sending set');

    const lateDraft=defer(); draftRead=()=>lateDraft.promise; selectConversation('late'); await tick(); type('typed first');
    lateDraft.resolve({ok:true,text:'OLD',replyToMessageId:'old',mentionUserIds:['old']}); await tick();
    check(textarea.value === 'typed first' && observedIntent().replyToMessageId === null, 'late getDraft cannot overwrite new typing');
    const staleDraftError=defer(); draftRead=()=>staleDraftError.promise; selectConversation('stale'); await tick(); selectConversation('late');
    const errorsBefore=errors.length; staleDraftError.reject(new Error('stale draft')); await tick(); check(errors.length===errorsBefore,'late getDraft rejection has no cross-conversation side effect');
    const oldPreview=defer(); previewRead=()=>oldPreview.promise; composer.setReply({messageId:'old'});
    composer.setReply({messageId:'new'}); oldPreview.resolve({ok:true,messages:[{...source,id:'old',bodyText:'OLD PREVIEW'}]}); await tick();
    check(!preview.textContent.includes('OLD PREVIEW') && observedIntent().replyToMessageId==='new','selection and identity fence delayed previews');
    const revokePreview=defer(); previewRead=()=>revokePreview.promise; composer.setReply({messageId:'source'}); await tick();
    composer.refreshReply([{...source,conversationId:'late',revokedAt:'now'}]);
    check(preview.textContent.includes(t('collaboration.reply.revoked')),'source revoke refresh is immediate');
    revokePreview.resolve({ok:true,messages:[{...source,conversationId:'late'}]}); await tick();
    check(preview.textContent.includes(t('collaboration.reply.revoked')),'late cache response cannot revive revoked preview');
    previewRead=()=>Promise.resolve({ok:true,messages:[],unavailableMessageIds:['missing']}); composer.setReply({messageId:'missing'}); await tick();
    check(preview.textContent.includes(t('collaboration.reply.unavailable')) && observedIntent().replyToMessageId==='missing','missing preview retains ID with explicit unavailable placeholder');
    const hiddenPreview=defer(); previewRead=()=>hiddenPreview.promise; composer.setReply({messageId:'hidden'}); await tick(); const oldClear=preview.querySelector('[data-action="clear-reply"]'); composer.setActive(false);
    oldClear.click(); hiddenPreview.resolve({ok:true,messages:[{...source,id:'hidden',bodyText:'HIDDEN RESULT'}]}); await tick();
    check(observedIntent().replyToMessageId==='hidden' && !preview.textContent.includes('HIDDEN RESULT'),'hidden preview and old clear action are fenced');
    composer.setActive(true); const resetPreview=defer(); previewRead=()=>resetPreview.promise; composer.setReply({messageId:'reset'}); await tick(); composer.reset();
    resetPreview.reject(new Error('reset stale')); await tick(); check(preview.hidden && textarea.value==='' && errors.length===errorsBefore,'reset fences async success and failure');
    draftRead=()=>Promise.resolve({ok:true,text:'ime',replyToMessageId:null,mentionUserIds:[]}); previewRead=request=>Promise.resolve({ok:true,messages:[{...source,conversationId:request.conversationId,id:request.messageIds[0]}]}); selectConversation('ime'); await tick();
    const beforeIme=sends.length;
    for (const options of [{shiftKey:true},{isComposing:true},{keyCode:229}]) textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options}));
    check(sends.length===beforeIme,'Shift+Enter and IME do not send');
    sendReply=()=>Promise.resolve({ok:false,code:'OFFLINE'}); textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); await tick(); check(sends.length===beforeIme+1,'plain Enter still sends');
    for (const locale of ['zh-CN','en','ar']) {
      await setLocale(locale,{persist:false}); render(root,[reply],opts); composer.setReply({messageId:'source'}); await tick();
      check(root.querySelector('[data-action="reply-message"]').getAttribute('aria-label')===t('collaboration.reply.action'),'translated reply aria '+locale);
      check(preview.querySelector('[data-action="clear-reply"]').getAttribute('aria-label')===t('collaboration.reply.clear'),'translated clear aria '+locale);
      check(document.documentElement.dir===(locale==='ar'?'rtl':'ltr'),'direction '+locale);
    }
    const destroyedPreview=defer(); previewRead=()=>destroyedPreview.promise; composer.setReply({messageId:'destroyed'}); await tick(); const detachedClear=preview.querySelector('[data-action="clear-reply"]'); composer.destroy();
    const writesBefore=writes.length; detachedClear.click(); destroyedPreview.resolve({ok:true,messages:[{...source,id:'destroyed',bodyText:'DESTROYED RESULT'}]}); await tick();
    check(writes.length===writesBefore && !preview.textContent.includes('DESTROYED RESULT'),'destroy invalidates detached clear and preview');
    window.replyKeyboard = {count:0};
    render(root,[reply],{onReply:()=>{window.replyKeyboard.count+=1;}});
    root.querySelector('[data-action="reply-message"]').focus();
  })()`);
  win.show(); win.focus(); win.webContents.focus();
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="reply-message"]\').focus()');
  for (const keyCode of ["Enter", "Space"]) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    win.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Enter" ? "\r" : " " });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const activated = await win.webContents.executeJavaScript("window.replyKeyboard.count");
  if (activated !== 2) throw new Error(`Native Enter/Space must activate reply; got ${activated}`);
  await win.webContents.executeJavaScript(`(${exerciseSourceMasks.toString()})(${JSON.stringify(moduleUrl("modules/collaboration-center.js"))})`);
  await win.webContents.executeJavaScript(`(${exerciseBatchedMasks.toString()})(${JSON.stringify(moduleUrl("modules/collaboration-center.js"))})`);
  console.log("collaboration reply UI: actual Electron DOM passed (preload cache stubs; not production two-client acceptance)");
}).then(() => finish(0)).catch(error => { console.error(error); finish(1); });
