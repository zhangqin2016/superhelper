# API documentation standard

Every HTTP endpoint on the server **must** be documented in OpenAPI / Swagger.
This is enforced by `scripts/test-server-api-docs.mjs` (runs in `npm run test:unit`):
a route with no `schema.summary` or no `schema.tags` fails the suite.

Swagger UI is served at **`/docs`** (open in every environment) and the raw spec at
**`/docs/json`**.

## The rule

Pass a `schema` as the route options object on every route:

```js
import { zodBody, okResponse } from "../../openapi.js";

app.post(
  "/api/devices/register",
  {
    schema: {
      tags: ["public:devices"],                 // REQUIRED — one of OPENAPI_TAGS
      summary: "Register or upsert a device",    // REQUIRED — short imperative phrase
      description: "Upserts the device record and returns trial status.", // optional, longer
      body: zodBody(registerDeviceSchema),       // request body, from the route's Zod schema
      response: { 200: okResponse({ trial: { type: "object" } }) }, // documented response shape
    },
  },
  async (request, reply) => { /* handler — Zod .parse() unchanged */ },
);
```

GET/DELETE routes that take no body omit `body`. Path params (`/:id`) are picked up
automatically; add `params`/`querystring` (also via `zodBody`) when useful.

## Documentation only — never validation

Schemas attached to routes are **for Swagger only**. The handler's `zodSchema.parse()`
remains the single source of truth for validation, and Fastify keeps its default JSON
serialization. This is guaranteed by `installDocOnlyCompilers()` in `src/openapi.js`,
which installs a pass-through validator + serializer, so:

- `body`/`querystring`/`params` schemas are **not** enforced by Fastify (Zod still is);
- `response` schemas do **not** strip fields from responses.

Because of this, do **not** rely on Fastify schema validation for new routes — keep
validating with Zod in the handler.

## Tags

Use a tag from `OPENAPI_TAGS` in `src/openapi.js`, named `surface:resource`
(`public:devices`, `admin:licenses`, `gateway:model`, …). Add a new tag there if you
add a new resource area.

## Helpers (`src/openapi.js`)

- `zodBody(zodSchema)` — Zod → draft-7 JSON Schema (input side) for request bodies.
  Returns `undefined` if the schema can't be represented, so docs never crash a route.
- `okResponse(extra)` — the standard `{ ok: true, ... }` response envelope.

## Adding a new endpoint

1. Write the route with a `schema` (`tags` + `summary` minimum).
2. `node scripts/test-server-api-docs.mjs` must pass.
3. Eyeball it at `http://localhost:<port>/docs`.
