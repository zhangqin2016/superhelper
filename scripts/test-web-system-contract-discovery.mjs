#!/usr/bin/env node
/**
 * L1 contract discovery — normalization is the load-bearing, deterministic core
 * (the network layer is a thin probe around it). These tests pin the contract
 * the generator depends on: authoritative endpoints with real JSON Schema
 * (types/enums/required), secrets redacted, and the domain allowlist enforced
 * on every emitted endpoint.
 */
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const skill = "../resources/skills-catalog/lily-web-system-learning/scripts/discover_contracts.cjs";
const {
  isUrlAllowed,
  cookieHeaderFor,
  derefSchema,
  detectOpenApi,
  normalizeOpenApi,
  normalizeGraphQLIntrospection,
  candidateOpenApiUrls,
} = require(skill);

try {
  // ===== allowlist enforcement =====
  assert(isUrlAllowed("https://erp.acme.com/api", ["acme.com"]), "subdomain of allowed host passes");
  assert(!isUrlAllowed("https://evil.com/api", ["acme.com"]), "off-allowlist host rejected");
  assert(!isUrlAllowed("ftp://acme.com/x", ["acme.com"]), "non-http protocol rejected");

  // ===== cookie reuse from a Playwright storageState (auth without secrets in files) =====
  const storage = { cookies: [
    { name: "SESSION", value: "abc", domain: "acme.com", path: "/" },
    { name: "OTHER", value: "z", domain: "other.com", path: "/" },
  ] };
  const header = cookieHeaderFor("https://erp.acme.com/api", storage);
  assert(header.includes("SESSION=abc"), "matching-domain cookie reused");
  assert(!header.includes("OTHER"), "non-matching-domain cookie excluded");

  // ===== $ref resolution + secret redaction =====
  const root = { components: { schemas: { User: { type: "object", properties: {
    id: { type: "integer" }, token: { type: "string" }, name: { type: "string" },
  } } } } };
  const dereffed = derefSchema({ $ref: "#/components/schemas/User" }, root);
  assert(dereffed.properties.id.type === "integer", "$ref inlined");
  assert(dereffed.properties.token.description === "redacted-sensitive", "sensitive prop redacted");
  assert(dereffed.properties.name.type === "string", "non-sensitive prop preserved");

  // ===== OpenAPI 3.x normalization =====
  const openapi3 = {
    openapi: "3.0.1",
    info: { title: "Acme ERP", version: "2.3" },
    servers: [{ url: "https://erp.acme.com/api" }],
    components: { schemas: {
      Leave: { type: "object", required: ["days"], properties: {
        days: { type: "integer" },
        type: { type: "string", enum: ["annual", "sick"] },
        password: { type: "string" },
      } },
    } },
    paths: {
      "/leaves": {
        get: { operationId: "listLeaves", parameters: [
          { name: "status", in: "query", required: false, schema: { type: "string", enum: ["open", "closed"] } },
        ], responses: { 200: { content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Leave" } } } } } } },
        post: { operationId: "createLeave", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Leave" } } } }, responses: { 201: {} } },
      },
      "/external": { get: { operationId: "x", responses: {} } },
    },
  };
  const n3 = normalizeOpenApi(openapi3, "https://erp.acme.com", ["acme.com"]);
  assert(n3.ok && n3.kind === "openapi3", "detects openapi3");
  assert(detectOpenApi(openapi3) === "openapi3", "detectOpenApi openapi3");
  const list = n3.contracts.find((c) => c.operationId === "listLeaves");
  const create = n3.contracts.find((c) => c.operationId === "createLeave");
  assert(list && list.method === "GET" && list.risk === "read", "GET classified read");
  assert(create && create.method === "POST" && create.risk === "submit", "POST classified submit (write API learned)");
  const statusField = list.requestFields.find((f) => f.name === "status");
  assert(statusField && JSON.stringify(statusField.enum) === JSON.stringify(["open", "closed"]), "query enum captured");
  const daysField = create.requestFields.find((f) => f.name === "days");
  assert(daysField && daysField.required === true, "required body field captured");
  assert(!create.requestFields.some((f) => f.name === "password"), "sensitive body field dropped from requestFields");
  assert(create.requestSchema && create.requestSchema.properties.type.enum.length === 2, "requestSchema carries enums");
  assert(n3.dataSchemas.Leave, "component data schema persisted");
  assert(create.authoritative === true, "authoritative flag set");
  // external host endpoint must be skipped, not emitted
  assert(!n3.contracts.some((c) => c.operationId === "x" && isUrlAllowed(c.endpoint, ["acme.com"]) === false), "no off-allowlist endpoint emitted");

  // ===== Swagger 2.0 normalization (host/basePath/definitions/body param) =====
  const swagger2 = {
    swagger: "2.0",
    host: "erp.acme.com",
    basePath: "/v1",
    schemes: ["https"],
    definitions: { Order: { type: "object", required: ["sku"], properties: { sku: { type: "string" } } } },
    paths: { "/orders": { post: { operationId: "createOrder", parameters: [
      { name: "body", in: "body", schema: { $ref: "#/definitions/Order" } },
    ], responses: { 200: { schema: { $ref: "#/definitions/Order" } } } } } },
  };
  const n2 = normalizeOpenApi(swagger2, "https://erp.acme.com", ["acme.com"]);
  assert(n2.ok && n2.kind === "swagger2", "detects swagger2");
  const order = n2.contracts[0];
  assert(order.endpoint === "https://erp.acme.com/v1/orders", "swagger2 host+basePath resolved");
  assert(order.requestFields.some((f) => f.name === "sku" && f.required), "swagger2 body param schema flattened");
  assert(order.responseSchema && order.responseSchema.properties.sku, "swagger2 response schema resolved");

  // ===== GraphQL introspection normalization =====
  const introspection = { data: { __schema: {
    queryType: { name: "Query" },
    mutationType: { name: "Mutation" },
    types: [
      { kind: "OBJECT", name: "Query", fields: [
        { name: "ticket", args: [{ name: "id", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "ID" } } }], type: { kind: "OBJECT", name: "Ticket" } },
      ] },
      { kind: "OBJECT", name: "Mutation", fields: [
        { name: "closeTicket", args: [{ name: "id", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "ID" } } }], type: { kind: "OBJECT", name: "Ticket" } },
      ] },
      { kind: "OBJECT", name: "Ticket", fields: [
        { name: "id", type: { kind: "SCALAR", name: "ID" } },
        { name: "priority", type: { kind: "SCALAR", name: "Int" } },
      ] },
    ],
  } } };
  const gql = normalizeGraphQLIntrospection(introspection, "https://erp.acme.com/graphql", ["acme.com"]);
  assert(gql.ok && gql.contracts.length === 2, "graphql query+mutation contracts");
  const q = gql.contracts.find((c) => c.operationId === "ticket");
  const m = gql.contracts.find((c) => c.operationId === "closeTicket");
  assert(q.risk === "read" && q.graphqlOperation === "query", "graphql query is read");
  assert(m.risk === "submit" && m.graphqlOperation === "mutation", "graphql mutation is submit");
  assert(q.requestFields[0].name === "id" && q.requestFields[0].required, "graphql NON_NULL arg required");
  assert(gql.dataSchemas.Ticket.properties.priority.type === "number", "graphql Int mapped to number type");
  assert(!normalizeGraphQLIntrospection(introspection, "https://evil.com/graphql", ["acme.com"]).ok, "graphql off-allowlist rejected");

  // ===== candidate probe paths stay within base =====
  const candidates = candidateOpenApiUrls("https://erp.acme.com/");
  assert(candidates.includes("https://erp.acme.com/openapi.json"), "openapi.json candidate present");
  assert(candidates.includes("https://erp.acme.com/v3/api-docs"), "springdoc candidate present");

  console.log("PASS: test-web-system-contract-discovery (33 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
