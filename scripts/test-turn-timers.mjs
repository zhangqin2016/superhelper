#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TimerBank } = require("../src/main/turn-timers.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bank = new TimerBank();

// Arming the same name replaces the previous timer — only the latest fires.
let fired = [];
bank.arm("a", 30, () => fired.push("first"));
bank.arm("a", 30, () => fired.push("second"));
await sleep(60);
if (fired.join(",") !== "second") {
  throw new Error(`re-arm must replace, got: ${fired}`);
}

// clear() prevents firing.
fired = [];
bank.arm("b", 20, () => fired.push("b"));
bank.clear("b");
await sleep(40);
if (fired.length !== 0) throw new Error("cleared timer must not fire");

// A fired timer removes itself BEFORE the callback runs, so heartbeat
// callbacks that re-arm see has() === false and can safely re-arm.
let hasDuringCallback = null;
bank.arm("hb", 20, () => {
  hasDuringCallback = bank.has("hb");
  bank.arm("hb", 20, () => fired.push("hb2"));
});
await sleep(30);
if (hasDuringCallback !== false) {
  throw new Error("timer must self-remove before its callback runs");
}
if (!bank.has("hb")) throw new Error("re-armed heartbeat must be tracked");
await sleep(30);
if (fired.join(",") !== "hb2") throw new Error("heartbeat re-arm must fire");

// clearPrefix removes only matching names.
fired = [];
bank.arm("lease:t1", 20, () => fired.push("t1"));
bank.arm("lease:t2", 20, () => fired.push("t2"));
bank.arm("idle", 20, () => fired.push("idle"));
bank.clearPrefix("lease:");
if (bank.has("lease:t1") || bank.has("lease:t2") || !bank.has("idle")) {
  throw new Error("clearPrefix must clear only the prefix");
}
await sleep(40);
if (fired.join(",") !== "idle") throw new Error(`clearPrefix leak: ${fired}`);

// clearAll wipes everything.
bank.arm("x", 20, () => fired.push("x"));
bank.clearAll();
await sleep(40);
if (fired.join(",") !== "idle") throw new Error("clearAll must cancel all timers");

console.log("turn-timers: ok");
