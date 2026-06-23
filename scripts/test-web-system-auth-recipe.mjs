#!/usr/bin/env node
/**
 * Auth recipe learning: after the user logs in, Lily should learn where auth
 * headers come from without storing token values in skills/plans.
 */
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { learnAuthRecipe, resolveHeaderSource, defaultAuthRecipePath } = require("../resources/skills-catalog/lily-web-system-learning/scripts/learn_auth_recipe.cjs");

try {
  const storageState = {
    cookies: [
      { name: "XSRF-TOKEN", value: "csrf-cookie-value", domain: "erp.example.com", path: "/" },
      { name: "SESSION", value: "session-secret", domain: "erp.example.com", path: "/" },
    ],
    origins: [
      {
        origin: "https://erp.example.com",
        localStorage: [
          { name: "access_token", value: "access-secret" },
        ],
      },
    ],
    lilySessionStorage: [
      {
        origin: "https://erp.example.com",
        sessionStorage: [
          { name: "id_token", value: "session-secret" },
        ],
      },
    ],
  };
  const har = { log: { entries: [
    {
      _resourceType: "fetch",
      request: {
        method: "GET",
        url: "https://erp.example.com/api/leaves",
        headers: [
          { name: "Authorization", value: "Bearer access-secret" },
          { name: "X-CSRF-Token", value: "csrf-cookie-value" },
          { name: "X-XSRF-Token", value: "session-secret" },
        ],
      },
      response: { status: 200, content: { mimeType: "application/json", text: "[]" } },
    },
    {
      _resourceType: "fetch",
      request: {
        method: "POST",
        url: "https://erp.example.com/api/auth/refresh",
        headers: [{ name: "Authorization", value: "Bearer access-secret" }],
      },
      response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
    },
    {
      _resourceType: "fetch",
      request: {
        method: "GET",
        url: "https://evil.com/api",
        headers: [{ name: "Authorization", value: "Bearer access-secret" }],
      },
      response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
    },
  ] } };

  const bearer = resolveHeaderSource("Bearer access-secret", [
    { source: "localStorage", key: "access_token", value: "access-secret" },
  ]);
  assert(bearer.source === "localStorage" && bearer.key === "access_token" && bearer.format === "Bearer {{value}}", "Bearer header source learned");

  const recipe = learnAuthRecipe({ storageState, har, baseUrl: "https://erp.example.com", allowedDomains: ["example.com"] });
  assert(recipe.headerRules.length === 3, `three auth header rules learned, got ${recipe.headerRules.length}`);
  const auth = recipe.headerRules.find((rule) => rule.name === "Authorization");
  const csrf = recipe.headerRules.find((rule) => rule.name === "X-CSRF-Token");
  const sessionHeader = recipe.headerRules.find((rule) => rule.name === "X-XSRF-Token");
  assert(auth.source === "localStorage" && auth.key === "access_token" && auth.format === "Bearer {{value}}", "Authorization resolves to localStorage source");
  assert(csrf.source === "cookie" && csrf.key === "XSRF-TOKEN", "CSRF resolves to cookie source");
  assert(sessionHeader.source === "sessionStorage" && sessionHeader.key === "id_token", "sessionStorage token source learned");
  assert(recipe.refreshCandidates.some((item) => item.endpoint === "https://erp.example.com/api/auth/refresh"), "refresh endpoint candidate learned");
  assert(!JSON.stringify(recipe).includes("access-secret"), "recipe must not contain raw access token");
  assert(!JSON.stringify(recipe).includes("csrf-cookie-value"), "recipe must not contain raw csrf token");
  assert(!JSON.stringify(recipe).includes("session-secret"), "recipe must not contain raw sessionStorage token");
  assert(defaultAuthRecipePath("/tmp/demo.json") === "/tmp/demo.auth-recipe.json", "default auth recipe path");

  console.log("PASS: test-web-system-auth-recipe (11 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
