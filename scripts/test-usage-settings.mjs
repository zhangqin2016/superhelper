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

function harness({ remote, snapshot, models = [], local = [] }) {
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
    } },
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
