#!/usr/bin/env node
// Mobile Command protocol/version fail-safe guard. Unsupported protocol or
// oversized command frames must be denied before local admission so remote
// failure never mutates the Lily session.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  handleRelayCommandFrame,
  MAX_ATTACHMENTS,
  MAX_COMMAND_TEXT,
  SUPPORTED_PROTOCOL_VERSION,
} = require(path.join(ROOT, 'src/main/mobile-agent-bridge.js'));

let admitCalls = 0;
const deps = {
  admit: async () => {
    admitCalls += 1;
    throw new Error('admission must not run');
  },
};

const unsupported = await handleRelayCommandFrame({
  type: 'command',
  protocolVersion: SUPPORTED_PROTOCOL_VERSION + 1,
  commandId: 'cmd_protocol_2',
  correlationId: 'corr_protocol_2',
  text: 'hello',
}, deps);
assert.equal(unsupported.reply.type, 'command.rejected');
assert.equal(unsupported.reply.commandId, 'cmd_protocol_2');
assert.equal(unsupported.reply.correlationId, 'corr_protocol_2');
assert.equal(unsupported.reply.code, 'CLIENT_UPGRADE_REQUIRED');

const tooLong = await handleRelayCommandFrame({
  type: 'command',
  protocolVersion: SUPPORTED_PROTOCOL_VERSION,
  commandId: 'cmd_too_long',
  text: 'x'.repeat(MAX_COMMAND_TEXT + 1),
}, deps);
assert.equal(tooLong.reply.type, 'command.rejected');
assert.equal(tooLong.reply.code, 'COMMAND_TEXT_TOO_LARGE');

const tooManyAttachments = await handleRelayCommandFrame({
  type: 'command',
  protocolVersion: SUPPORTED_PROTOCOL_VERSION,
  commandId: 'cmd_too_many_files',
  text: 'see files',
  attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
    name: `${i}.jpg`,
    mimeType: 'image/jpeg',
    dataBase64: 'eA==',
  })),
}, deps);
assert.equal(tooManyAttachments.reply.type, 'command.rejected');
assert.equal(tooManyAttachments.reply.code, 'ATTACHMENT_COUNT_EXCEEDED');

assert.equal(admitCalls, 0, 'invalid protocol/oversized frames must not reach admission');

console.log('mobile-protocol-version: ok');
