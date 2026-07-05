import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/lily_test";

const { decideRuntimePackUpsert } = await import("../server/src/routes/admin/runtime-packs.js");

assert.deepEqual(decideRuntimePackUpsert(null), { action: "create", id: null });
assert.deepEqual(decideRuntimePackUpsert({ id: "rpack_existing" }), {
  action: "update",
  id: "rpack_existing",
});

console.log("runtime-pack admin upsert: ok");
