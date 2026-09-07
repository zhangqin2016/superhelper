import assert from 'node:assert/strict';
import fs from 'node:fs';
import { taskRunSummaryForView } from '../src/renderer/modules/turn-view-status.js';
for (const locale of ['zh-CN', 'en', 'ar']) {
  const messages = JSON.parse(fs.readFileSync(new URL(`../src/renderer/i18n/locales/${locale}.json`, import.meta.url), 'utf8'));
  const t = (key, vars = {}) => (messages[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
  for (const status of ['delivered_unverified', 'verified_complete', 'completed_observed', 'failed', 'interrupted', 'unknown_backend_value', 'constructor', '__proto__', 'toString']) {
    const text = taskRunSummaryForView({ completionStatus: status, verification: { status: 'unverified' }, evidence: [], risks: [] }, t);
    assert.ok(!text.includes(status) || ['failed', 'interrupted'].includes(status) && locale === 'en', `${locale} leaks internal status: ${text}`);
    assert.ok(!text.includes('task.summary.'), `${locale} missing translation: ${text}`);
    if (locale === 'zh-CN') assert.match(text, /待验证/);
  }
}
console.log('task-summary-localization: passed');
