import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildTaskContract } = require('../src/main/task-contract');
const { hasExecutionIntent } = require('../src/main/parent-task-closure');
const { assessObjectiveCoverage } = require('../src/main/task-original-acceptance');
const { createTaskCoreEnvelope } = require('../src/main/task-core-contracts');
const { resolveTurnIntelligence } = require('../src/main/turn-intelligence');
const { compactIntentContract } = require('../src/main/intent-contract');
for (const text of ['生成一个 Excel 文件，包含三张图表', '创建一份 Word 报告，包含三张表格', '生成一张海报图片']) {
  const taskContract = buildTaskContract({ text });
  assert.equal(hasExecutionIntent(taskContract), true, `${taskContract.taskType}/${taskContract.semanticIntent?.operation}: ${text}`);
  assert.equal((await assessObjectiveCoverage({ state: { taskContract, enginePayload: { rawText: text } } })).status, 'unknown', 'creation must not bypass acceptance');
  const core = createTaskCoreEnvelope({ sessionId: 's', admission: { sessionId: 's' }, contextSnapshot: { sessionId: 's' }, taskContract });
  const wake = resolveTurnIntelligence({ session: { id: 's' }, text: 'Continue completed background job abc', previousIntentContract: core.contract.intentContract });
  assert.equal(hasExecutionIntent(wake.taskContract), true, 'background resume must preserve creation operation, not only the document/media type');
  const summary = compactIntentContract(taskContract.intentContract);
  const continued = buildTaskContract({ text: '继续', messages: [], previousIntentContract: summary });
  assert.equal(hasExecutionIntent(continued), true, 'summary-only resume must preserve creation operation without a TaskCore');
  assert.equal((await assessObjectiveCoverage({ state: { taskContract: continued, enginePayload: { rawText: '继续' } } })).status, 'unknown');
}
for (const text of ['阅读这个 Word 文档并总结', '这份 Excel 里有什么数据', '你好']) {
  assert.equal(hasExecutionIntent(buildTaskContract({ text })), false, text);
  const first = buildTaskContract({ text });
  assert.equal(hasExecutionIntent(buildTaskContract({ text: '继续', messages: [], previousIntentContract: compactIntentContract(first.intentContract) })), false, 'read-only summary stays read-only');
}
console.log('task execution classification passed');
