#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { inferProgramTaskIntent } = require("../src/main/program-task-intent.js");

const colloquial = inferProgramTaskIntent({ text: "给我写一个牛逼的程序" });
assert.equal(colloquial.active, true);
assert.equal(colloquial.operation, "implement");
assert.equal(colloquial.routeTaskType, "code_change");
assert.equal(colloquial.outputMode, "workspace_change");
assert(colloquial.targetKinds.includes("program"));
assert(colloquial.qualitySignals.includes("high_quality"));

const production = inferProgramTaskIntent({ text: "从零开发一个生产级库存管理应用并运行测试" });
assert.equal(production.routeTaskType, "code_change");
assert(production.targetKinds.includes("app"));
assert(production.qualitySignals.includes("production"));
assert(production.qualitySignals.includes("tested"));

const attachedRepair = inferProgramTaskIntent({
  text: "修复这个",
  files: [{ name: "login.ts", path: "/tmp/login.ts" }],
});
assert.equal(attachedRepair.operation, "debug");
assert(attachedRepair.sourceKinds.includes("code_attachment"));

assert.equal(inferProgramTaskIntent({ text: "程序员工资排行榜" }).active, false);
assert.equal(inferProgramTaskIntent({ text: "帮我写一封客户邮件" }).active, false);
assert.equal(inferProgramTaskIntent({ text: "你好" }).active, false);

console.log("program-task-intent: ok");
