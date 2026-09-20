import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const { OpencodeServerManager } = require("../src/main/runtime/opencode-server-manager");
const { resetSharedServer } = require("../src/main/runtime/opencode-shared-server");
const { createOpencodeSdkSession } = require("../src/main/runtime/opencode-sdk-session");
// The engine's first session on a fresh profile installs plugin SDKs from npm; the
// app routes that to a reachable mirror and so must this harness (registry.npmjs.org
// hung 8–30+ s here, 2026-09-20). Realpath: on macOS os.tmpdir() is /var/… while the
// engine reports /private/var/…, so the event filter below never matched.
const { applyEngineNpmRegistry } = require("../src/main/engine-npm-registry");
const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "bundles", `${process.platform}-${process.arch}`, "opencode/bin", process.platform === "win32" ? "opencode.exe" : "opencode");
if (!fs.existsSync(binary)) { console.log("SKIP native plugin: engine missing"); process.exit(0); }
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-plugin-probe-")));
// State (HOME, data, cache) is fresh per run; the engine's package cache is not.
// A configured plugin makes the engine install @opencode-ai/plugin into
// XDG_CONFIG_HOME/opencode on the first session (968 KB, dozens of registry
// fetches, 10–30 s even from the mirror), which alone can outrun the 30 s
// session-create timeout. One shared config home per machine pays that once.
const configHome = path.join(path.dirname(temp), "lily-plugin-probe-config");
fs.mkdirSync(configHome, { recursive: true });
const marker = path.join(temp, "hook.json");
const office = process.env.LILY_TEST_OFFICE_PLUGIN === "1";
const command = office ? '& "C:\\Program Files\\LibreOffice\\program\\soffice.exe" --version; Write-Output "exit=$LASTEXITCODE"' : 'echo BEFORE_PLUGIN';
const plugin = path.join(temp, "probe.mjs");
fs.writeFileSync(plugin, `import fs from 'node:fs'; export default async()=>({'tool.execute.before':async(input,output)=>{fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({input,output}));if(input.tool==='bash')output.args.command='echo AFTER_PLUGIN';}});`);
if (office) fs.writeFileSync(plugin, `import fs from 'node:fs'; import factory from ${JSON.stringify(pathToFileURL(path.join(root,'resources/opencode-plugins/windows-office-cli.js')).href)}; export default async()=>{const hooks=await factory();return {'tool.execute.before':async(input,output)=>{await hooks['tool.execute.before'](input,output);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({platform:process.platform,input,output}));}}};`);
const events = [];
const api = http.createServer(async(req,res)=>{
  const chunks=[]; for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  const isTitle=body.messages?.some(m=>m.role==='system' && String(m.content).includes('title generator'));
  const call=!isTitle&&!body.messages?.some(m=>m.role==='tool');
  const delta=call?{role:'assistant',tool_calls:[{index:0,id:'call_probe',type:'function',function:{name:'bash',arguments:JSON.stringify({command,description:'Offline plugin probe',timeout:10000})}}]}:{role:'assistant',content:'Done.'};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  for(const [d,finish] of [[delta,null],[{},call?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'probe',object:'chat.completion.chunk',created:1,model:'probe',choices:[{index:0,delta:d,finish_reason:finish}]})}\n\n`);
  res.end('data: [DONE]\n\n');
});
let server;
try {
  await new Promise(r=>api.listen(0,'127.0.0.1',r));
  const model={providerID:'fixture',modelID:'probe'};
  const selectedPlugin = plugin;
  server=new OpencodeServerManager({serverCommand:binary,cwd:temp,dataDir:path.join(temp,'engine.db'),model,
    env:applyEngineNpmRegistry({HOME:temp,XDG_CONFIG_HOME:configHome,XDG_DATA_HOME:path.join(temp,'data'),XDG_CACHE_HOME:path.join(temp,'cache'),XDG_STATE_HOME:path.join(temp,'state'),OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_DEFAULT_PLUGINS:'1'}),
    configContent:JSON.stringify({model:'fixture/probe',small_model:'fixture/probe',enabled_providers:['fixture'],plugin:[process.env.LILY_PLUGIN_URL==='1'?pathToFileURL(selectedPlugin).href:selectedPlugin],provider:{fixture:{npm:'@ai-sdk/openai-compatible',options:{baseURL:`http://127.0.0.1:${api.address().port}/v1`,apiKey:'fixture'},models:{probe:{limit:{context:32000,output:4096}}}}},permission:{'*':'deny',bash:'allow'}})});
  server.on('error',e=>console.error(e.message));
  await server.start();
  // First session on a cold config home: the engine installs the plugin SDK
  // before answering, longer than the harness's 30 s create timeout on a slow
  // registry. Warm it through the same SDK seam with a patient timeout; the
  // timed create below then measures the engine, not the network.
  // If even that cannot finish, the registry is unreachable from this machine:
  // an environment precondition (like a missing engine), not a plugin defect.
  let skipReason = "";
  try {
    await createOpencodeSdkSession(server._shared.clientFor(temp), temp, { timeouts: { create: 180_000 } }).create();
  } catch (error) {
    if (!/OPENCODE_HTTP_TIMEOUT/.test(String(error?.message))) throw error;
    skipReason = "engine could not install its plugin SDK within 180s (npm registry unreachable)";
  }
  if (skipReason) console.log(`SKIP native plugin: ${skipReason}`); else {
  const id=await server.createSession();server._shared.onEvent((dir,e)=>{if(dir===temp)events.push(e);});server.subscribe();
  await server.sendPrompt({text:'Run the offline echo probe once.',model});
  const deadline=Date.now()+30000;
  while(!events.some(e=>e.type==='session.idle'&&e.properties.sessionID===id)){if(Date.now()>deadline)throw Error('Native plugin timeout');await new Promise(r=>setTimeout(r,50));}
  if (!office) assert.ok(fs.existsSync(marker),'configured plugin must actually execute');
  const parts=events.filter(e=>e.type==='message.part.updated').map(e=>e.properties.part);
  if (office) console.log(JSON.stringify(parts.filter(p=>p.type==='tool').map(p=>p.state)));
  assert.ok(parts.some(p=>p.type==='tool'&&p.state?.status==='completed'&&p.state.output.includes(office ? 'exit=0' : 'AFTER_PLUGIN')),'engine must execute modified args');
  console.log('native plugin: passed');
  }
} finally {server?.terminate();resetSharedServer();api.closeAllConnections();await new Promise(r=>api.close(r));console.log(`Evidence: ${temp}`);}
