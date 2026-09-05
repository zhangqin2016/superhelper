import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const requireWeb = createRequire(new URL('../web/package.json', import.meta.url));
const swc = requireWeb('next/dist/build/swc');
await swc.loadBindings();
const React = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
const org = { id: 'org_acceptance', name: 'Enterprise acceptance', status: 'active', role: 'owner', grants: [] };
const redirect = (url) => { throw Object.assign(new Error('redirect'), { url, digest: 'NEXT_REDIRECT' }); };
async function load(relative, overrides = {}) {
  const source = fs.readFileSync(new URL('../web/' + relative, import.meta.url), 'utf8');
  const { code } = await swc.transform(source, { filename: relative, jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' }, module: { type: 'commonjs' } });
  const module = { exports: {} };
  const stubs = {
    'next/link': ({ children }) => React.createElement('a', null, children),
    'next/navigation': { redirect, unstable_rethrow: (error) => { if (error.digest === 'NEXT_REDIRECT') throw error; }, notFound: () => { throw new Error('NOT_FOUND'); } },
    'next/cache': { revalidatePath() {} },
    'next/headers': { cookies: async () => ({ get: () => ({ value: 'test-session' }), set() {} }) },
    ...overrides,
  };
  function require(id) {
    if (id in stubs) return stubs[id];
    if (id.endsWith('/admin-shell')) return { AdminShell: ({ title, children }) => React.createElement('main', null, title, children) };
    if (id.endsWith('/issued-credentials')) return () => React.createElement('aside', null, 'ISSUED_CREDENTIALS');
    if (id.endsWith('/action-form')) return ({ children }) => React.createElement('form', null, children);
    if (id.endsWith('/i18n.mjs')) return { getI18n: async () => ({ t: {} }) };
    if (id.endsWith('/api') || id.endsWith('/user-api') || id.endsWith('/enterprise-page')) return {
      apiGet: async () => ({ ok: true, organization: org }),
      safeApiGet: async (url) => url.includes('/usage') ? { usage: { byMember: [], byModel: [] } } : { ok: true, organization: org },
      userApiGet: async () => ({ ok: true, organization: org }),
      requireEnterpriseOrganization: async () => org,
    };
    if (id.endsWith('/actions')) return new Proxy({}, { get: () => () => {} });
    return requireWeb(id);
  }
  vm.runInNewContext(code, { module, exports: module.exports, require, Buffer, FormData, URL, crypto: globalThis.crypto, process }, { filename: relative });
  return module.exports;
}

const admin = await load('app/admin/enterprise/[id]/page.js');
const html = renderToStaticMarkup(await admin.default({ params: Promise.resolve({ id: org.id }) }));
assert.match(html, /Enterprise acceptance/, 'API success envelope must render enterprise, not not-found');
assert.match(html, /ISSUED_CREDENTIALS/, 'successful creation must display initial owner credentials');

const detail = await load('app/account/enterprise/[id]/page.js');
assert.match(renderToStaticMarkup(await detail.default({ params: Promise.resolve({ id: org.id }) })), /Enterprise acceptance/);

for (const [file, fn, args, response] of [
  ['app/admin/enterprise/actions.js', 'createOrganizationAction', [], { organization: org, owner: { issued: true, loginName: 'owner', initialPassword: 'test-only-password' } }],
  ['app/account/enterprise/actions.js', 'createOrganizationAction', [], { organization: org }],
  ['app/account/enterprise/actions.js', 'provisionAccountsAction', [org.id], { accounts: [{ loginName: 'employee', initialPassword: 'test-only-password' }] }],
  ['app/account/enterprise/actions.js', 'resetAccountPasswordAction', [org.id, 'usr_employee'], { loginName: 'employee', initialPassword: 'test-only-password' }],
]) {
  const api = { apiPost: async () => response, userApiPost: async () => response };
  const actions = await load(file, { '../../../lib/api': api, '../../../lib/user-api': api });
  const form = new FormData(); form.set('name', org.name); form.set('count', '1');
  if (fn === 'provisionAccountsAction' || fn === 'resetAccountPasswordAction') {
    const result = await actions[fn](...args, form);
    assert.equal(result.ok, true); assert.equal(result.issued[0].l, 'employee'); assert.equal(result.issued[0].p, 'test-only-password');
    continue;
  }
  await assert.rejects(actions[fn](...args, form), (error) => error.digest === 'NEXT_REDIRECT' && error.url.includes(org.id), `${fn} must propagate navigation, not swallow redirect as failure`);
}
console.log('enterprise web flow: page envelope, owner credentials and server-action redirects and issuance receipts passed');

const loginActions = await load('app/account/actions.js', {
  '../../lib/user-api': { userApiPost: async () => ({ webSessionToken: 'test-session', user: { passwordMustChange: true } }) },
});
const loginForm = new FormData(); loginForm.set('loginName', 'owner'); loginForm.set('password', 'initial-password'); loginForm.set('next', '/account/enterprise');
assert.equal(typeof loginActions.loginPasswordAccountAction, 'function', 'enterprise web password login must exist');
await assert.rejects(loginActions.loginPasswordAccountAction(null, loginForm), (e) => e.url?.startsWith('/account/password?next='), 'initial password login must route to password change');
console.log('enterprise password web action: forced-change navigation passed');
const proxyModule = await load('proxy.js', {
  'next/server': { NextResponse: { next: () => ({ next: true }), redirect: (url) => ({ url: String(url), cookies: { delete() {} } }) } },
  './lib/admin-auth-shared.mjs': {},
});
const requestFor = (path) => {
  const url = new URL('https://lilyxinjiapo.lilywb.cn' + path);
  return { nextUrl: url, url: url.href, headers: new Headers({ host: url.host, 'x-lily-region': 'uae' }) };
};
for (const path of ['/account/login', '/account/login?mode=sms', '/account/password', '/account/settings', '/account/enterprise', '/account/enterprise/org_acceptance/members']) {
  assert.equal((await proxyModule.proxy(requestFor(path))).next, true, `overseas enterprise route must stay reachable: ${path}`);
}
assert.match((await proxyModule.proxy(requestFor('/account/billing'))).url, /\/download$/, 'existing overseas purchasing restriction remains');
console.log('enterprise web region routes: passed');
const grantsPage = await load('app/account/enterprise/[id]/grants/page.js', {
  '../../../../../lib/enterprise-page': {
    requireEnterpriseOrganization: async () => org,
    requireEnterpriseData: async () => ({ grants: [
      { id: 'active', resource_type: 'token', status: 'active', starts_at: '2020-01-01', expires_at: '2099-01-01', unit_remaining: 120, unit_total: 120 },
      { id: 'expired', resource_type: 'token', status: 'active', expires_at: '2020-01-01', unit_remaining: 500, unit_total: 500 },
      { id: 'future', resource_type: 'token', status: 'active', starts_at: '2098-01-01', expires_at: '2099-01-01', unit_remaining: 600, unit_total: 600 },
      { id: 'disabled', resource_type: 'token', status: 'disabled', expires_at: '2099-01-01', unit_remaining: 700, unit_total: 700 },
      { id: 'images', resource_type: 'image_generation', status: 'active', expires_at: '2099-01-01', unit_remaining: 20, unit_total: 20 },
    ] }),
  },
});
assert.match(renderToStaticMarkup(await grantsPage.default({ params: { id: org.id } })), /text-3xl font-semibold">120</, 'available Token total excludes expired/future/disabled and different resources');
const protectedPage = await load('lib/enterprise-page.js', {
  './user-api': { userApiGetResult: async (url) => url.includes('session/current') ? { ok: true, data: { user: {} } } : { ok: true, data: { organization: { ...org, role: 'member' } } } },
});
await assert.rejects(protectedPage.requireEnterpriseOrganization(org.id, 'admin'), /没有管理/, 'employee cannot open privileged enterprise subpages');
console.log('enterprise web spendable balance and role guards: passed');
const nav = await load('components/admin-nav.js', {
  'next/navigation': { usePathname: () => '/admin/enterprise' },
  'next/link': ({ prefetch, children }) => React.createElement('a', { 'data-prefetch': String(prefetch) }, children),
});
assert.match(renderToStaticMarkup(nav.AdminNav({ groups: [{ title: 'Admin', items: [{ href: '/admin/enterprise', label: 'Enterprise' }] }] })), /data-prefetch="false"/, 'admin menu must not prefetch every protected page and exhaust API auth checks');
console.log('admin navigation prefetch guard: passed');
org.owners = [
  { id: 'owner_initial', loginName: 'first-owner', issued: true, passwordMustChange: true },
  { id: 'owner_active', loginName: 'active-owner', issued: true, passwordMustChange: false },
];
const recoveryHtml = renderToStaticMarkup(await admin.default({ params: { id: org.id } }));
assert.match(recoveryHtml, /first-owner/); assert.match(recoveryHtml, /active-owner/);
assert.equal((recoveryHtml.match(/重新签发负责人初始密码/g) || []).length, 1, 'only unfinished initial owner handoff offers platform password reissue');
const recoveryAction = await load('app/admin/enterprise/actions.js', {
  '../../../lib/api': { apiPost: async (path, body) => { assert.match(path, /owner-initial-password$/); assert.equal(body.userId, 'owner_initial'); return { owner: { loginName: 'first-owner', initialPassword: 'test-only-password' } }; } },
});
const recovery = await recoveryAction.reissueOwnerInitialPasswordAction(org.id, 'owner_initial');
assert.equal(recovery.issued[0].l, 'first-owner'); assert.equal(recovery.issued[0].p, 'test-only-password');
console.log('initial owner credential recovery UI: passed');
