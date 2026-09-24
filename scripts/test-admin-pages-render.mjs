#!/usr/bin/env node
// "The build compiles" was the only thing standing between an admin page and
// production, and it does not look inside a function body: the contacts page
// shipped reading `cursor`, `params` and `rows` it never declared, so it threw
// on every visit while the build stayed green.
//
// This renders EVERY admin page, for real: each page and everything it imports
// is compiled with Next's own swc and rendered through React's prerenderer
// (which awaits async server components), with the API answering each read
// with that page's own declared fallback. A page that cannot survive its own
// empty state is a page that is broken — this is where that is found.
// The tables whose cells carry meaning (seat use, version drift, the release a
// platform is offered) are also rendered with rows, so a cell that throws or
// says nothing is caught too.
// [gate: admin-pages-render]
// Run: node scripts/test-admin-pages-render.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const requireWeb = createRequire(path.join(WEB, "package.json"));
let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

const React = requireWeb("react");
const { prerenderToNodeStream } = requireWeb("react-dom/static");
const swc = requireWeb("next/dist/build/swc");
await swc.loadBindings();
const { dictionaries } = await import("../web/lib/i18n.mjs");

class NextControl extends Error {}
const LOCALE = "zh";
const t = dictionaries[LOCALE];

// A check may answer one endpoint with rows; every other read gets its fallback.
const samples = new Map();
const requested = [];

// The seams a page reaches outside itself. Everything else is the real code.
const stubFor = (file) => {
  const rel = path.relative(WEB, file).replace(/\\/g, "/");
  if (rel === "lib/api.js") {
    return {
      loadAdmin: async (apiPath, fallback) => {
        const hit = [...samples.keys()].find((prefix) => apiPath.startsWith(prefix));
        if (hit) requested.push(apiPath);
        return hit ? samples.get(hit) : fallback;
      },
      // A direct read's empty state is "not found": the detail pages that read
      // this way branch on 404, exactly as they would for a deleted record.
      apiGet: async () => { throw Object.assign(new Error("not found"), { status: 404 }); },
      apiPost: async () => { throw new Error("offline"); },
      apiRequest: async () => { throw new Error("offline"); },
    };
  }
  if (rel === "lib/i18n.mjs") return { ...requireWebModule(file), getI18n: async () => ({ locale: LOCALE, dir: "ltr", t }) };
  if (rel === "lib/use-i18n.js") return { useI18n: () => ({ locale: LOCALE, dir: "ltr", t }) };
  if (rel === "lib/admin-load-ledger.js") return { adminLoadFailures: () => [], recordAdminLoadFailure: () => null };
  if (rel === "app/admin/actions.js") return new Proxy({}, { get: (_, key) => (key === "__esModule" ? true : async () => {}) });
  return null;
};

const bare = {
  "next/navigation": {
    useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
    usePathname: () => "/admin",
    useSearchParams: () => new URLSearchParams(),
    redirect: () => { throw new NextControl("redirect"); },
    notFound: () => { throw new NextControl("notFound"); },
  },
  "next/headers": {
    cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
    headers: async () => new Headers(),
  },
  "server-only": {},
};

const cache = new Map();
function resolveLocal(from, id) {
  const base = path.resolve(path.dirname(from), id);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${id} from ${path.relative(ROOT, from)}`);
}

function requireWebModule(file) {
  const source = fs.readFileSync(file, "utf8");
  const { code } = swc.transformSync
    ? swc.transformSync(source, swcOptions(file))
    : (() => { throw new Error("swc transformSync unavailable"); })();
  const module = { exports: {} };
  vm.runInThisContext(`(function (module, exports, require, process) {${code}\n})`, { filename: file })(
    module, module.exports, (id) => load(file, id), process,
  );
  return module.exports;
}

function swcOptions(file) {
  return {
    filename: path.basename(file),
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
    module: { type: "commonjs" },
  };
}

function load(from, id) {
  if (id in bare) return bare[id];
  if (!id.startsWith(".")) return requireWeb(id);
  const file = resolveLocal(from, id);
  if (cache.has(file)) return cache.get(file);
  const exports = stubFor(file) || requireWebModule(file);
  cache.set(file, exports);
  return exports;
}

async function render(element) {
  const errors = [];
  const { prelude } = await prerenderToNodeStream(element, { onError: (error) => { errors.push(error); } });
  let html = "";
  for await (const chunk of prelude) html += chunk;
  const real = errors.filter((error) => !(error instanceof NextControl));
  if (real.length) throw real[0];
  return { html, control: errors.length > real.length };
}

const pages = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name === "page.js") pages.push(full);
  }
};
walk(path.join(WEB, "app/admin"));

await check(`every admin page renders its own empty state (${pages.length} pages)`, async () => {
  assert.ok(pages.length >= 40, `expected the whole console, found ${pages.length}`);
  const broken = [];
  let rendered = 0;
  for (const file of pages) {
    const rel = path.relative(ROOT, file);
    try {
      const Page = load(path.join(WEB, "x.js"), `./${path.relative(WEB, file)}`).default;
      assert.equal(typeof Page, "function", `${rel} has a default export`);
      const props = { searchParams: Promise.resolve({}), params: Promise.resolve({ id: "sample_id", slug: "sample" }) };
      const element = React.createElement(async () => {
        try {
          return await Page(props);
        } catch (error) {
          if (error instanceof NextControl) return null;
          throw error;
        }
      });
      await render(element);
      rendered += 1;
    } catch (error) {
      broken.push(`${rel}: ${error?.message || error}`);
    }
  }
  assert.deepEqual(broken, [], `these pages throw instead of rendering:\n  ${broken.join("\n  ")}`);
  assert.equal(rendered, pages.length);
});

const tables = load(path.join(WEB, "x.js"), "./components/admin-tables.js");
const day = 24 * 60 * 60 * 1000;

await check("licenses say how many seats are used and which ones are running out", async () => {
  const rows = [
    { id: "lic_a", customer_name: "A", plan: "pro", seats: 5, active_devices: 0, expires_at: new Date(Date.now() - day).toISOString(), status: "active" },
    { id: "lic_b", customer_name: "B", plan: "pro", seats: 5, active_devices: 3, expires_at: new Date(Date.now() + 10 * day).toISOString(), status: "active" },
  ];
  const { html } = await render(React.createElement(tables.LicensesTable, { rows, empty: null }));
  assert.match(html, /0<!-- --> \/ <!-- -->5|0 \/ 5/, "unused seats are visible");
  assert.ok(html.includes(t.admin.cols.expired), "an expired license says so");
  assert.ok(html.includes(t.admin.cols.expiresInDays.replace("{n}", "10")), "an expiring one counts down");
  assert.ok(html.includes(t.admin.cols.disableAction), "the button is a verb");
});

await check("devices show drift from the release their platform is offered", async () => {
  const rows = [
    { id: "dev_old", platform: "darwin", arch: "arm64", app_version: "0.1.99", last_seen_at: new Date().toISOString(), license_id: "lic_a", license_device_id: "ld_1", license_status: "active" },
    { id: "dev_new", platform: "darwin", arch: "arm64", app_version: "0.1.183", last_seen_at: new Date().toISOString(), trial_ends_at: new Date(Date.now() + day).toISOString() },
  ];
  const { html } = await render(React.createElement(tables.DevicesTable, { rows, latest: { "darwin-arm64": "0.1.183" }, empty: null }));
  assert.ok(html.includes("→ <!-- -->0.1.183") || html.includes("→ 0.1.183"), "0.1.99 is behind 0.1.183 — compared by meaning, not text");
  assert.equal((html.match(/→ /g) || []).length, 1, "the current device is not flagged");
  assert.ok(html.includes(t.admin.cols.trial), "an unlicensed device shows its trial");
  assert.ok(html.includes("darwin-arm64"), "platform and arch read as the release's platform key");
});

await check("releases say which row each platform is offered, not a column of identical words", async () => {
  const rows = [
    { id: "r2", version: "0.1.183", platform: "darwin-arm64", enabled: true, force_update: false, url: "https://cdn.example/app/Lily-0.1.183-arm64.dmg", created_at: new Date().toISOString() },
    { id: "r1", version: "0.1.182", platform: "darwin-arm64", enabled: true, force_update: false, url: "https://cdn.example/app/Lily-0.1.182-arm64.dmg", created_at: new Date().toISOString() },
    { id: "r0", version: "0.1.181", platform: "darwin-arm64", enabled: false, force_update: true, url: "https://cdn.example/app/Lily-0.1.181-arm64.dmg", created_at: new Date().toISOString() },
  ];
  const { html } = await render(React.createElement(tables.ReleasesTable, { rows, latest: { "darwin-arm64": "0.1.183" }, empty: null }));
  const copy = t.admin.releasesList;
  assert.equal(html.split(copy.current).length - 1, 1, "exactly one row is what clients get");
  assert.ok(html.includes(copy.superseded), "older enabled rows read as superseded");
  assert.ok(html.includes("Lily-0.1.183-arm64.dmg") && !html.includes(">https://cdn.example"), "the file is named, the raw URL is not the cell text");
});

const renderPage = async (rel, searchParams = {}) => {
  const Page = load(path.join(WEB, "x.js"), `./${rel}`).default;
  return (await render(React.createElement(async () => Page({ searchParams: Promise.resolve(searchParams), params: Promise.resolve({}) })))).html;
};

await check("a contact request can be marked handled, and the inbox opens on what is still waiting", async () => {
  samples.set("/api/admin/contact-requests", {
    contacts: [{ id: "c_1", name: "N", email: "n@example.com", message: "hello", status: "new", created_at: new Date().toISOString(), attachments: [] }],
    nextCursor: "", total: 1, counts: { new: 1, handled: 33, all: 34 },
  });
  requested.length = 0;
  const html = await renderPage("app/admin/contacts/page.js");
  const copy = t.admin.contacts;
  assert.ok(requested[0].includes("status=new"), "the default view is the waiting ones");
  assert.ok(html.includes(copy.markHandled), "a waiting request offers the action");
  assert.ok(html.includes(`${copy.statusHandled} 33`), "the filter says how many are in each state");
  samples.clear();
});

await check("the device list opens on the fleet that is running, and says which window it shows", async () => {
  samples.set("/api/admin/devices", { devices: [], nextCursor: "", total: 0, latest: {} });
  requested.length = 0;
  const html = await renderPage("app/admin/devices/page.js");
  assert.ok(requested[0].includes("seen=30d"), "default is the last 30 days, not 1,210 installs mostly dead");
  assert.ok(html.includes(t.admin.devicesList.seenAll), "and everything is one click away");
  await renderPage("app/admin/devices/page.js", { seen: "all", cursor: "abc" });
  assert.ok(requested[1].includes("seen=all") && requested[1].includes("cursor=abc"), "the window and the cursor both reach the API");
  samples.clear();
});

await check("users hide three always-zero billing figures until the first order exists", async () => {
  const user = { id: "u_1", phoneMasked: "+86 138****0000", status: "active", createdAt: new Date().toISOString(), orderCount: 0, paidOrderCount: 0, totalPaidCents: 0 };
  const [c] = [t.admin.usersView];
  samples.set("/api/admin/users", { users: [user], stats: { totalUsers: 75, activeUsers: 64, paidOrders: 0 } });
  const none = await renderPage("app/admin/users/page.js");
  assert.ok(!none.includes(c.table[5]) && !none.includes(c.stats[5]), "no revenue column or card with no orders anywhere");
  assert.ok(none.includes(c.filters.active), "status reads as a word, in a badge");
  samples.set("/api/admin/users", { users: [{ ...user, orderCount: 1, paidOrderCount: 1, totalPaidCents: 9900 }], stats: { totalUsers: 75, paidOrders: 1, revenueCents: 9900 } });
  const some = await renderPage("app/admin/users/page.js");
  assert.ok(some.includes(c.table[5]) && some.includes("99.00"), "the day there is an order, the columns appear");
  samples.clear();
});

await check("diagnostics: the list fits its card, ranks kinds by reach, and keeps traces on the record", async () => {
  const device = "dev_5a2b5f4e-4b7a-4311-b447-2602b0cb1631";
  samples.set("/api/admin/diagnostics", {
    diagnostics: [{ id: "diag_1", created_at: new Date().toISOString(), severity: "error", normalized_kind: "EMPTY_ASSISTANT_COMPLETION", summary: "the model returned nothing", device_id: device, platform: "darwin", arch: "arm64", app_version: "0.1.183" }],
    byKind: [{ kind: "EMPTY_ASSISTANT_COMPLETION", severity: "error", count: 108, devices: 23 }, { kind: "MODEL_NO_RESPONSE", severity: "warning", count: 29, devices: 4 }],
    nextCursor: "next", total: 525,
  });
  requested.length = 0;
  const html = await renderPage("app/admin/diagnostics/page.js");
  const c = t.admin.diag;
  assert.ok(requested[0].includes("days=7"), "opens on the last week");
  assert.match(html, /class="overflow-x-auto"><table/, "the table scrolls sideways inside its card instead of being clipped by it");
  assert.ok(!html.includes("<pre"), "no trace is inlined into the list");
  assert.ok(html.includes('href="/admin/diagnostics/diag_1"'), "each row opens its record");
  assert.ok(html.includes(c.onDevices.replace("{n}", "23")), "a kind says how many machines it reaches");
  assert.ok(html.includes(`title="${device}"`) && !html.includes(`>${device}<`), "the long device id is shortened, full on hover");
  assert.ok(!html.includes(c.claude), "the always-empty Claude version column is gone");
  assert.ok(html.includes(t.admin.paging.next || "下一页"), "and the list can be walked past its first page");
  samples.clear();
  const api = fs.readFileSync(path.join(ROOT, "server/src/routes/admin/diagnostics.js"), "utf8");
  assert.match(api, /select\(LIST_COLUMNS\)/, "the list query does not carry traces");
  assert.ok(!/LIST_COLUMNS = \[[^\]]*"trace"/.test(api));
});

await check("a delivery rule can be edited, starting from what is saved", async () => {
  const builder = load(path.join(WEB, "x.js"), "./components/config-profile-config-builder.js");
  // A rule the form fully models round-trips; one with fields it does not is
  // loaded verbatim so a save cannot drop them.
  const formConfig = builder.buildConfig({ ...builder.draftFromConfig({}), selectedTemplateId: "deepseek", menuProviders: ["deepseek"], permissionMode: "acceptEdits", imageProviders: ["dashscope"], imageDefault: "dashscope" }, { id: "deepseek", provider: "deepseek" });
  assert.equal(builder.formCanEditConfig(formConfig), true, "a config the form wrote is editable in the form");
  const richConfig = { ...formConfig, collaboration: { enabled: true }, characterWorlds: { enabled: false } };
  assert.equal(builder.formCanEditConfig(richConfig), false, "extra sections force verbatim JSON editing");

  const profile = (id, config, enabled) => ({ id, name: `rule ${id}`, scope: "organization", target_id: "org_1", priority: 7, rollout_percent: 40, enabled, config });
  samples.set("/api/admin/config-profiles/", { profile: profile("rich", richConfig, false) });
  const rich = await renderPage("app/admin/config/profiles/[id]/page.js");
  const copy = (await import("../web/components/config-profile-copy.js")).localeLabels("zh");
  assert.match(rich, /name="id"[^>]*readOnly=""|readOnly=""[^>]*name="id"/i, "the id cannot be changed");
  assert.match(rich, /value="rich"/);
  assert.ok(rich.includes(copy.editJsonOnly), "the operator is told why the JSON is in charge");
  assert.ok(rich.includes("collaboration") && rich.includes("characterWorlds"), "fields the form does not model are loaded, not dropped");
  const disabledBox = (html) => (html.match(/<input[^>]*name="disabled"[^>]*>/) || [""])[0];
  assert.match(disabledBox(rich), /checked=""/, "a disabled rule stays disabled when saved unchanged");
  assert.ok(rich.includes(copy.scopeOrganization), "an organization rule shows its own scope, not 'all clients'");
  assert.match(rich, /name="priority"[^>]*value="7"/);
  assert.match(rich, /name="rolloutPercent"[^>]*value="40"/);

  samples.set("/api/admin/config-profiles/", { profile: profile("plain", formConfig, true) });
  const plain = await renderPage("app/admin/config/profiles/[id]/page.js");
  assert.ok(!plain.includes(copy.editJsonOnly), "a config the form models is edited in the form");
  const hidden = (/<input[^>]*name="config"[^>]*>/.exec(plain)?.[0].match(/value="([^"]*)"/) || [])[1] || "";
  const submitted = JSON.parse(hidden.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  delete submitted.models.capabilities;
  const stored = JSON.parse(JSON.stringify(formConfig));
  delete stored.models.capabilities;
  assert.deepEqual(submitted, stored, "saving without a change writes back exactly what was stored");
  assert.doesNotMatch(disabledBox(plain), /checked=""/, "and an enabled one stays enabled");
  samples.clear();

  const tablesSource = fs.readFileSync(path.join(WEB, "components/admin-tables.js"), "utf8");
  assert.match(tablesSource, /href=\{`\/admin\/config\/profiles\/\$\{encodeURIComponent\(row\.original\.id\)\}`\}/, "every rule in the list links to its editor");
});

await check("releases open on who is offered what, with only the rollout moves that exist", async () => {
  samples.set("/api/admin/rollouts", { platforms: [
    { platform: "darwin-arm64", activeWeek: 80, full: { id: "r1", version: "0.1.183", installed: 60 },
      active: { id: "rol_a", version: "0.1.184", platform: "darwin-arm64", state: "rolling", percent: 25, installed: 9,
        health: { verdict: "worse", rate: 0.4, baseRate: 0.1, baseline: { version: "0.1.183" } } },
      drafts: [], halted: [] },
    { platform: "win32-x64", activeWeek: 40, full: { id: "r2", version: "0.1.182", installed: 30 }, active: null,
      drafts: [{ id: "rol_b", version: "0.1.184", immutableFeed: true }], halted: [{ id: "rol_c", version: "0.1.183", percent: 10 }] },
  ] });
  samples.set("/api/admin/releases", { releases: [], nextCursor: "", total: 0, latest: {} });
  const html = await renderPage("app/admin/releases/page.js", { rolloutError: "0.1.9 is already rolling" });
  const copy = t.admin.rollouts;
  assert.ok(html.includes(copy.widenTo.replace("{n}", "50")) && !html.includes(copy.widenTo.replace("{n}", "10")), "only widening steps above 25% are offered");
  assert.ok(html.includes(copy.healthWorse), "a worse version says so next to its rollout");
  assert.ok(html.includes(copy.start) && html.includes('value="start"'), "a draft can be started");
  assert.ok(html.includes(copy.reopen), "a halted rollout can be reopened");
  assert.match(html, /role="alert"[^>]*>(?:[^<]|<!-- -->)*0\.1\.9 is already rolling/, "a refused move comes back as a notice");
  samples.clear();
});

await check("no toggle is labelled with a state word", () => {
  const offenders = [];
  for (const dir of ["web/components", "web/app/admin"]) {
    const stack = [path.join(ROOT, dir)];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith(".js")) {
          const src = fs.readFileSync(full, "utf8");
          // "已禁用" on a button that disables reads as the current state, not the action.
          if (/<Button[^>]*>\{[^}]*t\.admin\.common\.(enabled|disabled)[^}]*\}<\/Button>/.test(src)) offenders.push(path.relative(ROOT, full));
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `buttons that name a state instead of an action: ${offenders.join(", ")}`);
  for (const locale of ["zh", "en", "ar"]) {
    const cols = dictionaries[locale].admin.cols;
    assert.ok(cols.disableAction && cols.enableAction, `${locale} has the verbs`);
    assert.notEqual(cols.disableAction, dictionaries[locale].admin.common.disabled, `${locale}: the verb is not the state`);
  }
});

console.log(`\n${checks} checks passed (admin pages render)`);
