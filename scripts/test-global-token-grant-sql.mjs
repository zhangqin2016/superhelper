#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("./ops/grant-global-100m-tokens.sql", import.meta.url), "utf8");

assert.match(sql, /\\set ON_ERROR_STOP on/i, "production grant must stop on the first SQL error");
assert.match(sql, /begin;/i, "grant and ledger writes must share one transaction");
assert.match(sql, /pg_advisory_xact_lock/i, "concurrent operators must serialize the batch");
assert.match(sql, /global-100m-2026-08-03/g, "the batch needs one stable idempotency identity");
assert.match(sql, /100000000/g, "each user must receive exactly 100 million tokens");
assert.match(sql, /not exists\s*\([\s\S]*wallet_grants/i, "reruns must skip users already granted in this batch");
assert.match(sql, /wallet_ledger/i, "every grant must have an auditable ledger entry");
assert.match(sql, /raise exception/i, "the transaction must fail if any user is missing or duplicated");
assert.match(sql, /commit;/i, "the verified batch must commit explicitly");

console.log("global-token-grant-sql: ok");
