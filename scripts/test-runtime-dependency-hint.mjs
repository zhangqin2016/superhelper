import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../resources/opencode-plugins/runtime-dependency-hint.js', import.meta.url), 'utf8');
const exports = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
assert.deepEqual(Object.keys(exports), ['RuntimeDependencyHint']);
const plugin = await exports.RuntimeDependencyHint();
async function run(text, { sessionID = 'a', tool = 'bash', exit = 1, command = 'python task.py' } = {}) {
  const out = { output: text, metadata: { exit } };
  await plugin['tool.execute.after']({ tool, sessionID, args: { command } }, out);
  assert.ok(out.output.startsWith(text), 'original failure is preserved');
  return out.output.slice(text.length);
}
const trace = (name) => `Traceback (most recent call last):\n  File "task.py", line 1, in <module>\n    import ${name}\nModuleNotFoundError: No module named '${name}'`;
// Compare actual behavior to the catalog, including every top-level Python probe.
const { PACK_SPECS } = require('../src/main/runtime-pack-specs');
for (const spec of Object.values(PACK_SPECS)) {
  if (!spec.pythonPath) continue;
  const modules = spec.probe.startsWith('from ') ? [spec.probe.split(' ')[1]] : spec.probe.replace('import ', '').split(',').map(x => x.trim());
  for (const name of modules) assert.match(await run(trace(name), { sessionID: `${spec.id}:${name}` }), new RegExp(`pack "${spec.id}"`));
}
for (const [exe, pack] of Object.entries({ ffmpeg:'ffmpeg', ffprobe:'ffmpeg', git:'git', pandoc:'pandoc', soffice:'libreoffice', libreoffice:'libreoffice' })) {
  for (const diagnostic of [`/bin/bash: line 1: ${exe}: command not found`, `zsh: command not found: ${exe}`, `'${exe}' is not recognized as an internal or external command,\noperable program or batch file.`, `${exe} : The term '${exe}' is not recognized as the name of a cmdlet, function, script file, or operable program.`, `${exe}: The term '${exe}' is not recognized as a name of a cmdlet, function, script file, or executable program.`]) {
    assert.match(await run(diagnostic, { sessionID: diagnostic, command: `${exe} --version` }), new RegExp(`pack "${pack}"`));
  }
}
for (const text of ['ffmpeg: input.mp4: No such file or directory', "FileNotFoundError: [Errno 2] No such file or directory: 'ffmpeg'", "ImportError: cannot import name 'Thing' from 'PIL'", trace('unknown_module'), trace('PIL.Image'), "Docs say ModuleNotFoundError: No module named 'PIL'", '```\nModuleNotFoundError: No module named \'PIL\'\n```']) assert.equal(await run(text, { sessionID: text }), '');
for (const opts of [{exit:0}, {exit:undefined}, {tool:'read'}, {command:'cat errors.txt; exit 1'}, {command:'printf "ModuleNotFoundError"; exit 1'}]) {
  // Undefined metadata is checked separately because run defaults exit to 1.
  if (opts.exit === undefined && Object.hasOwn(opts,'exit')) continue;
  assert.equal(await run(trace('PIL'), {sessionID: JSON.stringify(opts), ...opts}), '');
}
const raw = { output: trace('PIL') }; await plugin['tool.execute.after']({tool:'bash'}, raw); assert.equal(raw.output, trace('PIL'));
assert.ok(await run(trace('PIL'), {sessionID:'dedup'}));
assert.equal(await run(trace('PIL'), {sessionID:'dedup'}), '');
await run('unrelated success', {sessionID:'dedup', exit:0, command:'echo ok'});
assert.equal(await run(trace('PIL'), {sessionID:'dedup'}), '', 'unrelated success is not recovery');
await run('success', {sessionID:'dedup', exit:0, command:'env PYTHONPATH=/managed python task.py'});
assert.ok(await run(trace('PIL'), {sessionID:'dedup'}), 'same operation recovered, then failed again');
await plugin.event({event:{type:'session.deleted',properties:{info:{id:'dedup'}}}});
assert.ok(await run(trace('PIL'), {sessionID:'dedup'}));
assert.ok(await run(trace('PIL'), {sessionID:null})); assert.ok(await run(trace('PIL'), {sessionID:null}));
for(let i=0;i<257;i++) await run(trace('PIL'), {sessionID:`bound-${i}`});
assert.ok(await run(trace('PIL'), {sessionID:'dedup'}), 'bounded session memory evicts old entries');
process.env.LILY_RUNTIME_DEP_HINT='0'; assert.equal(await run(trace('PIL'), {sessionID:'off'}), ''); delete process.env.LILY_RUNTIME_DEP_HINT;
await plugin['tool.execute.after'](null, null);
assert.match(fs.readFileSync(new URL('../src/main/session-runner-pool.js',import.meta.url),'utf8'), /"runtime-dependency-hint.js"/);

// Pin the actual registered shell -> after-hook bridge, not the unused V2 bash.
const engine = new URL('../opencode/packages/opencode/src/', import.meta.url);
if (fs.existsSync(new URL('tool/registry.ts', engine))) {
  assert.match(fs.readFileSync(new URL('tool/registry.ts',engine),'utf8'), /import \{ ShellTool \} from "\.\/shell"/);
  assert.match(fs.readFileSync(new URL('tool/shell/id.ts',engine),'utf8'), /export const ToolID = "bash"/);
  assert.match(fs.readFileSync(new URL('tool/shell.ts',engine),'utf8'), /metadata: \{[\s\S]*?exit: code,/);
  assert.match(fs.readFileSync(new URL('session/tools.ts',engine),'utf8'), /"tool.execute.after",\s*\{ tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args \},\s*output/);
} else {
  console.log('runtime-dependency-hint: optional OpenCode source checkout absent; plugin behavior and shipped registration still verified');
}

for (const name of ['constructor', 'toString', '__proto__']) {
  assert.equal(await run(trace(name), {sessionID:`prototype-python-${name}`}), '');
  assert.equal(await run(`bash: ${name}: command not found`, {sessionID:`prototype-shell-${name}`}), '');
}
assert.equal(await run('Error: spawn ffmpeg ENOENT', {sessionID:'missing-cwd',command:'node task.js'}), '', 'spawn ENOENT can mean missing cwd');
const nodeTrace = "Error: Cannot find module 'playwright'\nRequire stack:\n- /tmp/task.js\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1:2)\n  code: 'MODULE_NOT_FOUND',\n  requireStack: [ '/tmp/task.js' ]";
assert.equal(PACK_SPECS['web-automation'].health.nodeModule, 'playwright');
assert.match(await run(nodeTrace, {sessionID:'node-module',command:'node task.js'}), /pack "web-automation"/);
assert.equal(await run(trace('playwright'), {sessionID:'python-playwright'}), '', 'Node pack cannot repair Python playwright');
for(const [text,opts] of [
  [nodeTrace,{exit:0}], [nodeTrace,{command:'cat errors.log; exit 1'}],
  [nodeTrace.replace("'playwright'", "'./playwright'"),{}],
  [nodeTrace.replace("MODULE_NOT_FOUND", "ERR_OTHER"),{}],
  ["ffmpeg: input.mp4 is not recognized",{}],
  ["'ffmpeg' is not recognized as an internal or external command,",{}],
]) assert.equal(await run(text,{sessionID:JSON.stringify([text,opts]),...opts}), '');

console.log('runtime-dependency-hint: ok');
