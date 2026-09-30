import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const file = new URL("../src/main/usage-settings.js", import.meta.url);
const require = createRequire(file);
const { buildUsageSummary } = require("./usage-summary.js");
const date = require("./local-date-key.js").localDateKey();
const detail = { date, providerID: "actual", model: "same", inputTokens: 100 };

function harness({ remote, snapshot, models = [], local = [], runtime = [] }) {
  const module = { exports: {} };
  let localReads = 0;
  const mocks = {
    "./service-client": { getDeviceId: () => "test-device", fetchUsageSummary: remote },
    "./usage-reporter": { getPendingTodayTotals: () => ({ inputTokens: 7 }), getPendingUsageSnapshot: snapshot },
    "./usage-local-store": { getUsageSummary: options => {
      localReads++;
      return buildUsageSummary({ ...options, days: local, byModel: local });
    } },
    "./model-selection-catalog": { listModelSelectionPublic: () => {
      if (models instanceof Error) throw models;
      return { models };
    }, listRuntimeModelIds: () => runtime },
  };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { module, require: id => mocks[id] || require(id) });
  return { read: module.exports.getUsageSettingsPublic, localReads: () => localReads };
}
const stable = () => ({ revision: 0, unconfirmedReports: false, records: [] });
const response = () => ({ ok: true, json: { days: [detail], byModel: [detail] } });

test("remote detail survives IPC and names match both actual model and connection", async () => {
  const h = harness({ remote: async () => response(), snapshot: stable, models: [
    { providerID: "other", modelID: "same", label: "Wrong model", managed: false },
    { providerID: "actual", modelID: "same", label: "Actual model", managed: true },
  ] });
  const data = await h.read();
  assert.equal(data.source, "server");
  assert.equal(data.summary.today.inputTokens, 100, "legacy total snapshot must not be added as well");
  assert.equal(data.summary.modelTotals[0].model, "same");
  assert.equal(data.summary.modelTotals[0].label, "Actual model");
  assert.equal(data.summary.modelTotals[0].connectionType, "managed");
});

test("a concurrent report/read uses local once rather than double counting an acknowledged upload", async () => {
  let state = { revision: 1, records: [{ ...detail, inputTokens: 7 }], unconfirmedReports: false };
  const h = harness({ snapshot: () => state, local: [{ ...detail, inputTokens: 107 }],
    remote: async () => { state = { revision: 2, records: [], unconfirmedReports: false }; return response(); },
  });
  const data = await h.read();
  assert.equal(data.source, "local");
  assert.equal(data.localReason, "syncing");
  assert.equal(data.summary.rangeTotals.inputTokens, 107);
  assert.equal(data.summary.modelTotals[0].inputTokens, 107);
});

test("unconfirmed receipts use local even with a successful but potentially stale server response", async () => {
  const h = harness({ snapshot: () => ({ ...stable(), unconfirmedReports: true }),
    local: [{ ...detail, inputTokens: 120 }], remote: async () => response(),
  });
  const data = await h.read();
  assert.equal(data.source, "local");
  assert.equal(data.summary.rangeTotals.inputTokens, 120);
});

test("server and catalog failures retain local and pending usage without inventing attribution", async () => {
  const h = harness({ remote: async () => { throw Error("offline"); }, models: Error("catalog unavailable"),
    snapshot: () => ({ ...stable(), records: [{ ...detail, providerID: "new", inputTokens: 7 }] }), local: [detail],
  });
  const data = await h.read();
  assert.equal(data.localReason, "offline");
  assert.equal(data.summary.rangeTotals.inputTokens, 107);
  assert.equal(data.summary.modelTotals.length, 2);
  assert.equal(data.summary.modelTotals[0].connectionType, "unknown");
});

// Estimated credits (2026-09-30): only a connection routed through the Lily
// gateway is charged in credits; the user's own connection is not; the rates
// are the server's, and an offline refresh keeps the last ones it sent.
test("credits: gateway rows are estimated at the server's rate, own connections are not charged", async () => {
  const rows = [
    { date, providerID: "gw", model: "deepseek-v4-pro", inputTokens: 1_000_000, outputTokens: 100_000 },
    { date, providerID: "own", model: "kimi-k3", inputTokens: 500_000, outputTokens: 10_000 },
  ];
  const creditRates = { models: { "deepseek-v4-pro": { inputCached: 450, input: 13000, output: 39000 } },
    default: { inputCached: 450, input: 13000, output: 39000 } };
  let online = true;
  const h = harness({ snapshot: stable,
    remote: async () => { if (!online) throw Error("offline"); return { ok: true, json: { days: rows, byModel: rows, creditRates } }; },
    local: rows,
    models: [
      { providerID: "gw", modelID: "deepseek-v4-pro", label: "DeepSeek V4 Pro", managed: true },
      { providerID: "own", modelID: "kimi-k3", label: "Kimi", managed: false },
    ],
    runtime: [
      { providerID: "gw", env: { LILY_OPENCODE_BASE_URL: "https://lilywb.cn/llm/deepseek/v1", LILY_OPENCODE_API_KEY: "$LILY_GATEWAY_TOKEN" } },
      { providerID: "own", env: { LILY_OPENCODE_BASE_URL: "https://api.moonshot.cn/v1", LILY_OPENCODE_API_KEY: "sk-own" } },
    ],
  });
  const check = (data) => {
    const byProvider = Object.fromEntries(data.summary.modelTotals.map(row => [row.providerID, row]));
    assert.equal(byProvider.gw.creditState, "estimated");
    assert.equal(byProvider.gw.estimatedCredits, 13000 + 3900, "all input priced uncached: at or above the real charge");
    assert.equal(byProvider.own.creditState, "notCharged");
    assert.equal(byProvider.own.estimatedCredits, null);
    assert.equal(data.summary.today.estimatedCredits, 16900, "a day sums only what Lily charges");
    assert.equal(data.summary.rangeTotals.estimatedCredits, 16900);
    assert.equal(data.summary.credits.available, true);
  };
  check(await h.read());
  online = false;
  const offline = await h.read();
  assert.equal(offline.source, "local");
  check(offline);
});

test("credits: without server rates nothing is guessed", async () => {
  const h = harness({ snapshot: stable, remote: async () => response(),
    models: [{ providerID: "actual", modelID: "same", label: "Actual", managed: true }],
    runtime: [{ providerID: "actual", env: { LILY_OPENCODE_BASE_URL: "https://lilywb.cn/llm/deepseek/v1" } }] });
  const data = await h.read();
  assert.equal(data.summary.modelTotals[0].creditState, "unknown");
  assert.equal(data.summary.today.estimatedCredits, null);
  assert.equal(data.summary.credits.available, false);
});
