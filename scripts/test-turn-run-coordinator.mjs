#!/usr/bin/env node

import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { TurnRunCoordinator } = require("../src/main/turn-run-coordinator.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

{
  const coordinator = new TurnRunCoordinator();
  const order = [];
  const first = coordinator.wake("s1", 1, async () => {
    order.push("start-1");
    await sleep(20);
    order.push("end-1");
  });
  const second = coordinator.wake("s1", 2, async () => {
    order.push("start-2");
    await sleep(1);
    order.push("end-2");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"], "same session wakes drain sequentially");
}

{
  const coordinator = new TurnRunCoordinator();
  const order = [];
  await Promise.all([
    coordinator.wake("s1", 1, async () => {
      order.push("s1-start");
      await sleep(20);
      order.push("s1-end");
    }),
    coordinator.wake("s2", 1, async () => {
      order.push("s2-start");
      await sleep(1);
      order.push("s2-end");
    }),
  ]);
  assert(order.indexOf("s2-end") < order.indexOf("s1-end"), "different sessions can run concurrently");
}

{
  const coordinator = new TurnRunCoordinator();
  const order = [];
  const first = coordinator.wake("s1", 1, async () => {
    order.push("start-1");
    await sleep(20);
    order.push("end-1");
  });
  coordinator.wake("s1", 2, async () => {
    order.push("stale-2");
  });
  coordinator.interrupt("s1", 2);
  await first;
  await sleep(5);
  assert.deepEqual(order, ["start-1", "end-1"], "interrupt boundary suppresses stale queued wake");
}

{
  const coordinator = new TurnRunCoordinator();
  const stale = await coordinator.wake("s1", 1, async () => {});
  coordinator.interrupt("s1", 2);
  const rejected = await coordinator.wake("s1", 2, async () => {
    throw new Error("stale wake should not run");
  });
  assert.equal(stale.ok, true, "initial wake runs");
  assert.equal(rejected.stale, true, "wake at interrupt boundary is rejected");
}

console.log("turn-run-coordinator: ok");
