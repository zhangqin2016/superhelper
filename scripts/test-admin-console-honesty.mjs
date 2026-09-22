#!/usr/bin/env node
// The admin console had 81 reads through a helper that swallowed every error and
// returned an empty fallback: an API that was down rendered exactly like a
// console with nothing configured, on 30 of those sites. It also had almost no
// gates — 49 pages and 55 components guarded by "the build compiles".
//
// This holds the honesty contract: the swallowing reader is deleted (not
// deprecated), every page reads through the ledger, the ledger's behaviour is
// exercised directly, and the shell is RENDERED with a failed read to prove the
// banner reaches the page in every locale.
// [gate: admin-console-honesty]
// Run: node scripts/test-admin-console-honesty.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

await check("the swallowing reader is gone, and nothing may reintroduce it", () => {
  const api = fs.readFileSync(path.join(ROOT, "web/lib/api.js"), "utf8");
  assert.ok(!/export async function safeApiGet/.test(api), "safeApiGet is deleted, not deprecated");
  const ledgerSrc = fs.readFileSync(path.join(ROOT, "web/lib/admin-load-ledger.js"), "utf8");
  assert.match(ledgerSrc, /export const adminLoadFailures = cache\(\(\) => \[\]\)/, "the ledger is request-scoped");
  assert.match(ledgerSrc, /if \(ledger\.some\(\(entry\) => entry\.path === path\)\) return null;/, "one entry per endpoint");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") && /safeApiGet/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, "web"));
  assert.deepEqual(offenders, [], `these files still swallow read failures: ${offenders.join(", ")}`);
});

await check("every admin read goes through the ledger", () => {
  const pages = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.js") pages.push(full);
    }
  };
  walk(path.join(ROOT, "web/app/admin"));
  assert.ok(pages.length >= 40, `expected the whole console, found ${pages.length} pages`);
  const reading = pages.filter((file) => /loadAdmin\(/.test(fs.readFileSync(file, "utf8")));
  assert.ok(reading.length >= 25, `only ${reading.length} pages read through the ledger`);
  for (const file of reading) {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /from "(\.\.\/)+lib\/api"/, `${path.relative(ROOT, file)} imports the shared reader`);
  }
});

await check("the shell reports a failed read on the page, in every locale", async () => {
  const shell = fs.readFileSync(path.join(ROOT, "web/components/admin-shell.js"), "utf8");
  assert.match(shell, /const failures = adminLoadFailures\(\)/);
  assert.match(shell, /role="alert"/, "the banner is announced to assistive tech");
  assert.match(shell, /t\.admin\.dataUnavailable\.title/);
  assert.match(shell, /\{failure\.path\} — \{failure\.message\}/, "it names the endpoint and the reason");
  const { dictionaries } = await import("../web/lib/i18n.mjs");
  for (const locale of ["zh", "en", "ar"]) {
    const copy = dictionaries[locale]?.admin?.dataUnavailable;
    assert.ok(copy?.title && copy?.body, `${locale} has the banner copy`);
  }
  assert.notEqual(dictionaries.ar.admin.dataUnavailable.title, dictionaries.en.admin.dataUnavailable.title, "Arabic is translated, not inherited English");
});

await check("the ledger records a failure once per endpoint, with a reason", async () => {
  const { recordAdminLoadFailure } = await import("../web/lib/admin-load-ledger.js");
  const ledger = [];
  const first = recordAdminLoadFailure(ledger, "/api/admin/config-profiles", new Error("API failed: 502"));
  assert.deepEqual(first, { path: "/api/admin/config-profiles", message: "API failed: 502" });
  assert.equal(recordAdminLoadFailure(ledger, "/api/admin/config-profiles", new Error("again")), null, "the same endpoint is reported once, not once per read");
  recordAdminLoadFailure(ledger, "/api/admin/health", "boom");
  assert.deepEqual(ledger.map((e) => e.path), ["/api/admin/config-profiles", "/api/admin/health"]);
  assert.equal(ledger[1].message, "boom", "a non-Error reason still reaches the operator");
  // A caller without a ledger must not crash a page over reporting.
  assert.equal(recordAdminLoadFailure(null, "/x", new Error("y")), null);
  // The reader keeps the page renderable and reports through this ledger.
  const api = fs.readFileSync(path.join(ROOT, "web/lib/api.js"), "utf8");
  assert.match(api, /recordAdminLoadFailure\(adminLoadFailures\(\), path, error\)/);
  assert.match(api, /return fallback;/, "a failed read still returns the fallback, so half a console beats a stack trace");
});

await check("a release may not be published against an artifact that is definitely absent", async () => {
  const { checkReleaseArtifact, artifactErrorResponse, ARTIFACT_MISSING } = await import("../server/src/services/release-artifact-check.js");
  const missing = await checkReleaseArtifact("https://cdn.example/app.exe", { fetchImpl: async () => ({ status: 404, headers: { get: () => null } }) });
  assert.equal(missing.code, ARTIFACT_MISSING);
  assert.match(artifactErrorResponse(missing).message, /does not exist/);
  // Everything short of a definite absence stays publishable: the old behaviour
  // accepted every URL, and a guarded or unreachable host must not block a release.
  for (const status of [200, 401, 403, 405, 500, 503]) {
    const out = await checkReleaseArtifact("https://cdn.example/app.exe", { fetchImpl: async () => ({ status, headers: { get: () => null } }) });
    assert.equal(out.ok, true, `status ${status} does not block a release`);
  }
  const offline = await checkReleaseArtifact("https://cdn.example/app.exe", { fetchImpl: async () => { throw new Error("network"); } });
  assert.deepEqual(offline, { ok: true, checked: false });
  const src = fs.readFileSync(path.join(ROOT, "server/src/routes/admin/releases.js"), "utf8");
  assert.match(src, /const artifact = await checkReleaseArtifact\(input\.url\)/, "release creation runs the check");
  assert.match(src, /return reply\.code\(400\)\.send\(artifactErrorResponse\(artifact\)\)/);
});

await check("operator-facing messages are a translated catalog, not literals in the action file", async () => {
  const { ADMIN_MESSAGE_KEYS, ADMIN_MESSAGES, formatAdminMessage } = await import("../web/lib/admin-messages.mjs");
  assert.ok(ADMIN_MESSAGE_KEYS.length >= 25, `only ${ADMIN_MESSAGE_KEYS.length} messages are in the catalog`);
  for (const key of ADMIN_MESSAGE_KEYS) {
    const entry = ADMIN_MESSAGES[key];
    assert.ok(entry.zh && entry.en, `${key} is missing a translation`);
    assert.notEqual(entry.zh, entry.en, `${key} is not actually translated`);
  }
  assert.equal(formatAdminMessage("releaseCreated", "zh", { id: "rel_9" }), "发布记录 rel_9 已创建。");
  assert.equal(formatAdminMessage("releaseCreated", "ar", { id: "rel_9" }), "Release rel_9 created.", "Arabic inherits English here exactly as the rest of the admin dictionary does");
  assert.equal(formatAdminMessage("unknown-key", "zh"), "unknown-key", "an unknown key degrades to itself, never to a crash");
  // The action file may not answer an operator in a language it picked itself.
  const actions = fs.readFileSync(path.join(ROOT, "web/app/admin/actions.js"), "utf8");
  const literals = actions.match(/message: ["`][A-Z][^"`]{6,}/g) || [];
  assert.deepEqual(literals, [], `these messages bypass the catalog: ${literals.join(" | ")}`);
  assert.ok(actions.indexOf('"use server"') < actions.indexOf("import"), "the server directive stays first");
});

await check("the config rule form is no longer the most dangerous file in the console", () => {
  const form = fs.readFileSync(path.join(ROOT, "web/components/config-profile-form.js"), "utf8");
  assert.ok(form.split("\n").length < 700, "the form itself is what a reviewer can hold in their head");
  assert.match(form, /from "\.\/config-profile-copy\.js"/, "its three-locale copy lives apart");
  assert.match(form, /from "\.\/config-profile-config-builder\.js"/, "and so does what the draft means as stored config");
  const builder = fs.readFileSync(path.join(ROOT, "web/components/config-profile-config-builder.js"), "utf8");
  assert.ok(!/useState|useEffect|<[A-Z]/.test(builder), "the builder is pure: no state, no markup");
});

await check("rendered: a failed read is on the page, a clean request shows no banner", async () => {
  const { createRequire } = await import("node:module");
  const requireWeb = createRequire(path.join(ROOT, "web/package.json"));
  const React = requireWeb("react");
  const { renderToStaticMarkup } = requireWeb("react-dom/server");
  // Next ships the swc bindings; the enterprise flow gate uses the same door.
  const swc = requireWeb("next/dist/build/swc");
  await swc.loadBindings();
  const vm = await import("node:vm");

  const render = async (failures, locale) => {
    const source = fs.readFileSync(path.join(ROOT, "web/components/admin-shell.js"), "utf8");
    const { code } = await swc.transform(source, {
      filename: "admin-shell.js",
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    });
    const { dictionaries } = await import("../web/lib/i18n.mjs");
    const stubs = {
      "lucide-react": new Proxy({}, { get: () => () => React.createElement("span") }),
      "../app/admin/actions": new Proxy({}, { get: () => () => {} }),
      "./language-switcher": { LanguageSwitcher: () => React.createElement("span") },
      "./admin-nav": { AdminNav: () => React.createElement("nav") },
      "../lib/i18n.mjs": { getI18n: async () => ({ locale, dir: "ltr", t: dictionaries[locale] }) },
      "../lib/admin-load-ledger.js": { adminLoadFailures: () => failures },
    };
    const module = { exports: {} };
    vm.runInNewContext(code, {
      module, exports: module.exports, process, Buffer, URL,
      require: (id) => (id in stubs ? stubs[id] : requireWeb(id)),
    }, { filename: "admin-shell.js" });
    const element = await module.exports.AdminShell({ title: "T", subtitle: "", children: React.createElement("div", null, "BODY") });
    return renderToStaticMarkup(element);
  };

  const { dictionaries } = await import("../web/lib/i18n.mjs");
  for (const locale of ["zh", "en", "ar"]) {
    const html = await render([{ path: "/api/admin/config-profiles", message: "API failed: 502" }], locale);
    const copy = dictionaries[locale].admin.dataUnavailable;
    assert.ok(html.includes(copy.title), `${locale}: the banner title is on the page`);
    assert.ok(html.includes("/api/admin/config-profiles"), `${locale}: the endpoint is named`);
    assert.ok(html.includes("API failed: 502"), `${locale}: the reason is named`);
    assert.ok(html.includes('role="alert"'), `${locale}: the banner is announced`);
    assert.ok(html.includes("BODY"), `${locale}: the page still renders its content`);
  }
  const clean = await render([], "zh");
  assert.ok(!clean.includes(dictionaries.zh.admin.dataUnavailable.title), "a healthy request shows no banner");
  assert.ok(clean.includes("BODY"));
});

console.log(`\n${checks} checks passed (admin console honesty)`);
