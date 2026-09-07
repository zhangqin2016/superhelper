#!/usr/bin/env node
// Explicit opt-in; synthetic accounts only. Does not send messages/change contacts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { stableStringify } = require('../src/main/crypto-signing');
const WebSocket = require('../server/node_modules/ws');
let stage = 'preflight';
const clients = [], sockets = [], heartbeats = [];
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const pass = name => console.log(JSON.stringify({ stage: name, status: 'passed' }));
async function main() {
  const args = process.argv.slice(2);
  check(args.length === 3 && args[0] === '--credentials' && ['--preflight', '--allow-live-writes'].includes(args[2]), 'EXPLICIT_FLAGS_REQUIRED');
  const stat = fs.lstatSync(args[1]);
  check(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.size < 16384, 'PRIVATE_CREDENTIAL_FILE_REQUIRED');
  const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  const origin = new URL(config.baseUrl);
  check(origin.protocol === 'https:' && !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/', 'HTTPS_ORIGIN_REQUIRED');
  check(config.accounts?.length === 2 && config.accounts[0].loginName !== config.accounts[1].loginName, 'TWO_DISTINCT_TEST_ACCOUNTS_REQUIRED');
  for (const a of config.accounts) check(typeof a.loginName === 'string' && typeof a.password === 'string' && a.password.length, 'ACCOUNT_FIELDS_REQUIRED');
  pass('private_credentials_and_https_origin');
  if (args[2] === '--preflight') return;
  async function request(path, body, headers = {}) {
    const response = await fetch(`${origin.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) });
    const value = await response.json();
    check(response.ok && value.ok === true, `HTTP_${response.status}`);
    return value;
  }
  async function login(account) {
    const deviceId = `presence-acceptance-${crypto.randomUUID()}`;
    const keys = crypto.generateKeyPairSync('ed25519');
    const auth = await request('/api/auth/password/login', { deviceId, platform: process.platform, arch: process.arch, appVersion: 'presence-acceptance', keyAlg: 'ed25519', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), loginName: account.loginName, password: account.password });
    // Login already created a server session, even if the account is not ready.
    if (auth.refreshToken) clients.push({ refreshToken: auth.refreshToken });
    check(auth.accessToken && auth.refreshToken && auth.user?.id && !auth.user.passwordMustChange, 'READY_TEST_ACCOUNT_REQUIRED');
    const client = { userId: auth.user.id, refreshToken: auth.refreshToken, async post(path, fields) {
      const body = { deviceId, ...fields }, timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
      const bodyHash = crypto.createHash('sha256').update(stableStringify(body)).digest('hex');
      const signature = crypto.sign(null, Buffer.from(stableStringify({ method: 'POST', pathname: path, timestamp, nonce, bodyHash })), keys.privateKey).toString('base64url');
      return request(path, body, { authorization: `Bearer ${auth.accessToken}`, 'x-lily-device-id': deviceId, 'x-lily-timestamp': timestamp, 'x-lily-nonce': nonce, 'x-lily-body-sha256': bodyHash, 'x-lily-signature': signature });
    } };
    return client;
  }
  async function connect(client) {
    const ticket = await client.post('/api/collaboration/v1/ws-ticket', { clientCommandId: crypto.randomUUID() });
    const url = new URL('/api/collaboration/v1/realtime', origin); url.protocol = 'wss:'; url.searchParams.set('ticket', ticket.ticket);
    const socket = new WebSocket(url, { handshakeTimeout: 15000 }); sockets.push(socket);
    // Never log socket errors: they may contain the one-time ticket URL.
    socket.on('error', () => {});
    await new Promise((resolve, reject) => {
      let opened = false;
      socket.once('open', () => { opened = true; });
      const timer = setTimeout(() => reject(new Error(opened ? 'WS_READY_TIMEOUT' : 'WS_HANDSHAKE_TIMEOUT')), 16000);
      socket.on('message', bytes => { try { if (JSON.parse(String(bytes)).type === 'realtime.ready') { clearTimeout(timer); resolve(); } } catch {} });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('WS_CONNECT_FAILED')); });
    });
    const heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'realtime.heartbeat', schemaVersion: 1 }));
    }, 30000);
    heartbeats.push(heartbeat);
    socket.once('close', () => clearInterval(heartbeat));
    return socket;
  }
  async function state(viewer, target) {
    const value = await viewer.post('/api/collaboration/v1/presence', { userIds: [target.userId] });
    check(value.states?.length === 1 && value.states[0].userId === target.userId, 'PRESENCE_RESPONSE_INVALID');
    assert.deepEqual(Object.keys(value.states[0]).sort(), ['onlineUntil', 'presence', 'userId']);
    return value.states[0].presence;
  }
  async function converge(viewer, target, expected) {
    // A new Redis epoch intentionally keeps negative results unknown for 75s.
    // Allow that real recovery window without shortening production leases.
    for (let attempt = 0; attempt < 95; attempt++) {
      if (await state(viewer, target) === expected) return;
      await delay(1000);
    }
    throw new Error(`PRESENCE_NOT_${expected.toUpperCase()}`);
  }
  try {
    stage = 'test_account_login';
    const a = await login(config.accounts[0]), b = await login(config.accounts[1]);
    check(a.userId !== b.userId, 'IDENTITIES_NOT_DISTINCT');
    stage = 'cross_account_online';
    const sa = await connect(a), sb = await connect(b);
    await converge(a, b, 'online'); await converge(b, a, 'online'); pass(stage);
    stage = 'closed_peer_offline';
    sb.close(); await converge(a, b, 'offline'); pass(stage);
    stage = 'peer_reconnect';
    await connect(b); await converge(a, b, 'online'); pass(stage);
    stage = 'revoked_session_offline';
    await request('/api/auth/session/logout', { refreshToken: b.refreshToken });
    await converge(a, b, 'offline'); pass(stage);
    sa.close();
  } finally {
    for (const heartbeat of heartbeats) clearInterval(heartbeat);
    for (const socket of sockets) socket.terminate();
    let cleanupFailed = false;
    for (const client of clients) {
      try { await request('/api/auth/session/logout', { refreshToken: client.refreshToken }); }
      catch { cleanupFailed = true; console.error(JSON.stringify({ stage: 'cleanup', status: 'session_logout_failed' })); }
    }
    check(!cleanupFailed, 'SESSION_CLEANUP_FAILED');
  }
}
main().catch(error => {
  const safe = /^[A-Z][A-Z0-9_]{0,100}$/.test(error?.code || error?.message || '') ? error.code || error.message : 'ACCEPTANCE_FAILED';
  console.error(JSON.stringify({ stage, status: 'failed', code: safe })); process.exitCode = 1;
});
