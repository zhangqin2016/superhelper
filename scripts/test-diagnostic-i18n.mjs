import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/main/support-diagnostics.js', import.meta.url), 'utf8');
// Exercise the actual pure checks and redaction used by the public diagnostic payload.
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function safeCall'), source.indexOf('function requestUrl')), context);
const checks = vm.runInContext(`[
  activeModelCheck({presets: []}),
  activeModelCheck({presets: [{id: 'custom', custom: true}], activePresetId: 'custom'}),
  activeModelCheck({presets: [{}]}, {managed: true, ok: false}),
  activeModelCheck({presets: [{}]}),
  serviceConfigCheck({remoteReady: false}),
  serviceConfigCheck({remoteReady: true}),
  serviceConfigCheck({refreshResult: {ok: false, error: 'NETWORK_DOWN'}}),
].map(redact)`, context);
const supportPath = require.resolve('../src/main/support-diagnostics.js');
require.cache[supportPath] = { id: supportPath, filename: supportPath, loaded: true,
  exports: {runSupportDiagnosticsPublic: async () => ({checks})} };
const {collectStartupIssues} = require('../src/main/startup-health.js');
const issues = await collectStartupIssues({getAgentBootstrap: () => ({ok: false})});
assert.equal(issues.length, 2);
const renderer = fs.readFileSync(new URL('../src/renderer/modules/diagnostic-text.js', import.meta.url), 'utf8');
for (const locale of ['zh-CN', 'en', 'ar']) {
  const messages = JSON.parse(fs.readFileSync(new URL(`../src/renderer/i18n/locales/${locale}.json`, import.meta.url)));
  const code = renderer.replace('import { t } from "../i18n/index.js";', `const messages = ${JSON.stringify(messages)};
    const t = (key, params = {}) => (messages[key] ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => params[name] ?? '{' + name + '}');`);
  const {diagnosticText} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  for (const check of [...checks, ...issues]) {
    for (const field of ['labelCode', 'detailCode', 'messageCode']) {
      if (check[field]) assert(messages[check[field]], `${locale}: ${check[field]}`);
    }
    const result = diagnosticText(check);
    assert(result.message);
    if (locale !== 'zh-CN') assert(!/[\u3400-\u9fff]/u.test(result.message), result.message);
  }
  assert(diagnosticText(checks[6]).detail.includes('NETWORK_DOWN'));
  assert.equal(diagnosticText({message: 'Legacy issue'}).message, 'Legacy issue');
  assert.equal(diagnosticText({detailCode: 'unknown', detail: 'Original error'}).detail, 'Original error');
}
console.log('diagnostic-i18n: all three locales, startup payload, redaction and fallback passed');
