#!/usr/bin/env node
/**
 * A conversation must survive everything that is not a real model change.
 *
 * The engine reads its config once, at boot, so a rotating gateway credential
 * genuinely forces the session onto a new serve. What it must NOT do is cost
 * the conversation its continuity, and what a stale engine must NOT receive is
 * a model reference it cannot resolve. Both went wrong together on 2026-09-23:
 * an hourly token rotation read as "the operator switched models" and threw the
 * resume id away, and in the window before the restart landed, compaction asked
 * a serve for a provider it had never loaded and died — leaving a long session
 * unable to compact at all.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const facts = require("../src/main/runtime/engine-config-facts.js");
const { configFingerprints, modelConfigTransition, modelConfigDiagnostics } = require("../src/main/opencode-config-freshness.js");

let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

const gatewayConfig = (token, { model = "lily/DeepSeek-V4.1-Flash", baseURL = "https://gw.example.com/llm/daypop/v1", org = "" } = {}) => JSON.stringify({
  model,
  provider: {
    [model.split("/")[0]]: {
      npm: "@ai-sdk/openai-compatible",
      name: "Lily",
      options: {
        baseURL,
        apiKey: token,
        includeUsage: false,
        headers: { Authorization: `Bearer ${token}`, ...(org ? { "x-lily-organization-id": org } : {}) },
      },
      models: { [model.split("/")[1]]: {} },
    },
  },
});

// ---------------------------------------------------------------- redaction
{
  const a = configFingerprints(gatewayConfig("lilygw.aaa.bbb"));
  const b = configFingerprints(gatewayConfig("lilygw.ccc.ddd"));
  assert.notEqual(a.modelConfigFingerprint, b.modelConfigFingerprint, "the verbatim fingerprint must still notice a new config: the engine has to move to a serve carrying the new token");
  assert.equal(a.routeConfigFingerprint, b.routeConfigFingerprint, "a token rotation is not a model change");
  check("rotating a credential changes the config, not the route");
}

{
  const base = configFingerprints(gatewayConfig("t"));
  assert.notEqual(base.routeConfigFingerprint, configFingerprints(gatewayConfig("t", { model: "lily/SomeOtherModel" })).routeConfigFingerprint, "a different model must change the route");
  assert.notEqual(base.routeConfigFingerprint, configFingerprints(gatewayConfig("t", { baseURL: "https://other.example.com/v1" })).routeConfigFingerprint, "a different endpoint must change the route");
  assert.notEqual(base.routeConfigFingerprint, configFingerprints(gatewayConfig("t", { org: "org_42" })).routeConfigFingerprint, "an organization header selects a different upstream pool, so it is routing");
  check("model, endpoint and organization all still count as route changes");
}

{
  // Over-matching would be the dangerous direction: a redacted baseURL would
  // make a genuine endpoint change invisible.
  for (const key of ["apiKey", "api_key", "x-api-key", "Authorization", "token", "secret", "credentials", "password"]) {
    assert.equal(facts.isSecretKey(key), true, `${key} carries a credential`);
  }
  for (const key of ["baseURL", "headers", "includeUsage", "models", "npm", "name", "keyKind", "x-lily-organization-id", "monkey"]) {
    assert.equal(facts.isSecretKey(key), false, `${key} is routing or structure, never a credential`);
  }
  check("the secret rule covers credentials without swallowing routing fields");
}

{
  const redacted = facts.redactSecrets({ options: { baseURL: "u", headers: { Authorization: "Bearer x", "x-lily-organization-id": "org_1" } } });
  assert.equal(redacted.options.headers.Authorization, facts.REDACTED);
  assert.equal(redacted.options.headers["x-lily-organization-id"], "org_1", "redaction reaches into nested objects without flattening their siblings");
  assert.equal(redacted.options.baseURL, "u");
  check("redaction is deep and leaves non-secret siblings intact");
}

{
  // The printed diagnostics and the route fingerprint must agree on what a
  // secret is, or the log can never explain why the fingerprint moved.
  const diag = modelConfigDiagnostics(gatewayConfig("lilygw.a.b"));
  assert.ok(!diag.providerOptions.includes("apiKey"), "a credential is never printed");
  assert.ok(diag.providerOptions.includes("baseURL"), "routing options stay visible");
  check("diagnostics and the route fingerprint share one secret rule");
}

// -------------------------------------------------------------- transition
const session = (overrides = {}) => ({ _server: {}, busy: false, ...overrides });

{
  const before = configFingerprints(gatewayConfig("token-1"));
  const after = configFingerprints(gatewayConfig("token-2"));
  const t = modelConfigTransition(
    session({ _activeModelConfigFingerprint: before.modelConfigFingerprint, _activeRouteConfigFingerprint: before.routeConfigFingerprint }),
    after,
  );
  assert.equal(t.action, "recycle", "a credential rotation moves the session without discarding it");
  assert.equal(t.reason, "credential_rotated");
  check("a rotated credential recycles the engine, keeping the conversation");
}

{
  const before = configFingerprints(gatewayConfig("token-1"));
  const after = configFingerprints(gatewayConfig("token-1", { model: "lily/AnotherModel" }));
  const t = modelConfigTransition(
    session({ _activeModelConfigFingerprint: before.modelConfigFingerprint, _activeRouteConfigFingerprint: before.routeConfigFingerprint }),
    after,
  );
  assert.equal(t.action, "restart", "a genuinely different model deserves a fresh engine session");
  check("switching models still restarts, so old context cannot leak into a new model");
}

{
  const before = configFingerprints(gatewayConfig("token-1"));
  const after = configFingerprints(gatewayConfig("token-2"));
  // No route fingerprint recorded (an engine started before this change shipped):
  // the comparison cannot be made, so the previous, stricter behaviour stands.
  const t = modelConfigTransition(session({ _activeModelConfigFingerprint: before.modelConfigFingerprint }), after);
  assert.equal(t.action, "restart", "without route evidence the decision falls back to today's behaviour");
  check("a missing route fingerprint degrades to the previous behaviour, never to a wrong reuse");
}

{
  assert.equal(modelConfigTransition(session({ busy: true }), configFingerprints(gatewayConfig("x"))).action, "none", "a busy engine is never torn out from under a running turn");
  assert.equal(modelConfigTransition({ _server: null, busy: false }, configFingerprints(gatewayConfig("x"))).action, "none");
  const same = configFingerprints(gatewayConfig("x"));
  assert.equal(modelConfigTransition(session({ _activeModelConfigFingerprint: same.modelConfigFingerprint, _activeRouteConfigFingerprint: same.routeConfigFingerprint }), same).action, "none", "an unchanged config does nothing at all");
  check("busy engines, absent engines and unchanged configs are all left alone");
}

// ------------------------------------------------------------- reconcile
{
  const live = gatewayConfig("t", { model: "lily-model-c3b3/DeepSeek-V4.1-Flash" });
  const declared = facts.reconcileModelRef({ configContent: live, providerID: "lily-model-c3b3", modelID: "DeepSeek-V4.1-Flash" });
  assert.equal(declared.reason, "declared");
  assert.equal(declared.providerID, "lily-model-c3b3", "a reference the engine declares is passed through untouched");

  // The field case: Lily had moved on to the gateway provider while the engine
  // was still running the custom-preset config.
  const stale = facts.reconcileModelRef({ configContent: live, providerID: "lily", modelID: "DeepSeek-V4.1-Flash" });
  assert.equal(stale.reason, "substituted_default");
  assert.equal(stale.providerID, "lily-model-c3b3", "an unresolvable provider becomes one the engine actually has");
  check("a model reference the running engine cannot resolve is repaired, not sent");
}

{
  const noDefault = JSON.stringify({ provider: { "lily-model-c3b3": { models: { m: {} } } } });
  assert.equal(facts.reconcileModelRef({ configContent: noDefault, providerID: "lily", modelID: "m" }).reason, "omitted", "with nothing to substitute, the reference is dropped so the engine falls back to the session's own model");
  assert.equal(facts.reconcileModelRef({ configContent: "not json", providerID: "lily", modelID: "m" }).reason, "unverified", "an unreadable config never makes things worse than before");
  assert.equal(facts.reconcileModelRef({ configContent: gatewayConfig("t") }).reason, "unset");
  check("compaction always has a reference it can send, or none at all");
}

// ------------------------------------------------------ compaction wiring
{
  const { createRequire: cr } = await import("node:module");
  const req = cr(import.meta.url);
  const runtimePath = req.resolve("../src/main/context-compaction-runtime.js");
  const source = (await import("node:fs")).readFileSync(runtimePath, "utf8");
  assert.ok(/reconcileModelRef/.test(source), "compaction must reconcile its model reference");
  assert.ok(!/compactOptions\(model, decision\.reason\)\s*\)/.test(source), "every compaction call site passes the runner whose live config is being checked");
  check("the compaction path reconciles against the engine it is talking to");
}

console.log(`engine-config-continuity: ok (${checks} checks)`);
