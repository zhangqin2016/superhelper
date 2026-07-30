#!/usr/bin/env node
// Character export destination broker protocol and lifecycle hardening.
// Run: node scripts/test-character-worlds-destination-broker.mjs

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CharacterDestinationWriter,
} = require("../src/main/character-worlds/export-destination-writer.js");
const {
  DESTINATION_BROKER_PROTOCOL,
  DESTINATION_RESERVATION_PROTOCOL,
} = require("../src/main/character-worlds/destination-broker-protocol.js");
const {
  createReferenceDestinationBroker,
} = require("../src/main/character-worlds/reference-destination-broker.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-destination-broker-"));
let checks = 0;

async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok - ${name}`);
}

function codeIs(code) {
  return (error) => error?.code === code;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function reservation(overrides = {}) {
  return {
    protocol: DESTINATION_RESERVATION_PROTOCOL,
    fileName: "card.json",
    async write() {},
    async commit() {
      return {
        fileName: "card.json",
        publication: "broker_transaction",
        atomicVisibility: true,
        maintenanceWarnings: [],
      };
    },
    async reconcile() {
      return { status: "retryable_safe", errorCode: null };
    },
    async release() {},
    ...overrides,
  };
}

function broker(overrides = {}) {
  return {
    protocol: DESTINATION_BROKER_PROTOCOL,
    async reserve() {
      return reservation();
    },
    ...overrides,
  };
}

try {
  console.log("character-worlds-destination-broker:");

  await check("writer rejects legacy or path-only broker contracts", async () => {
    assert.throws(
      () => new CharacterDestinationWriter({
        broker: { async reserve() { return reservation(); } },
      }),
      /broker protocol/i,
    );
    assert.throws(
      () => new CharacterDestinationWriter({
        broker: {
          protocol: {
            name: DESTINATION_BROKER_PROTOCOL.name,
            version: 0,
            capabilities: ["path"],
          },
          async reserve() {
            return {
              targetPath: path.join(tmp, "renderer-controlled.json"),
              async write() {},
              async release() {},
            };
          },
        },
      }),
      /broker protocol/i,
    );
  });

  await check("reference broker fails closed when the approved parent changes during spawn", async () => {
    const parent = path.join(tmp, "spawn-race");
    const outside = path.join(tmp, "spawn-race-outside");
    fs.mkdirSync(parent);
    fs.mkdirSync(outside);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      beforeSpawn() {
        fs.renameSync(parent, `${parent}-old`);
        fs.symlinkSync(outside, parent);
      },
    });
    await assert.rejects(
      brokerInstance.ready(),
      codeIs("EXPORT_DESTINATION_CHANGED"),
    );
    assert.deepEqual(fs.readdirSync(outside), []);
    await assert.rejects(
      brokerInstance.reserve({ fileName: "card.json" }),
      codeIs("EXPORT_DESTINATION_CHANGED"),
    );
    await brokerInstance.close();
  });

  await check("ready failures are internally observed until the caller awaits them", async () => {
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      const invalid = createReferenceDestinationBroker({
        approvedParent: path.join(tmp, "missing-approved-parent"),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(unhandled, []);
      await assert.rejects(
        invalid.ready(),
        codeIs("EXPORT_DESTINATION_UNAUTHORIZED"),
      );
      await invalid.close();

      const parent = path.join(tmp, "startup-timeout");
      fs.mkdirSync(parent);
      let capturedEnv;
      class SilentChild extends EventEmitter {
        send() {}
        kill() {
          this.emit("exit", 0);
          return true;
        }
      }
      const priorSecret = process.env.LILY_SECRET_SENTINEL;
      const priorNodeOptions = process.env.NODE_OPTIONS;
      const priorNodePath = process.env.NODE_PATH;
      process.env.LILY_SECRET_SENTINEL = "must-not-reach-helper";
      process.env.NODE_OPTIONS = "--trace-warnings";
      process.env.NODE_PATH = "/private/secret/modules";
      try {
        const timedOut = createReferenceDestinationBroker({
          approvedParent: parent,
          requestTimeoutMs: 15,
          forkProcess(_helperPath, _args, options) {
            capturedEnv = options.env;
            return new SilentChild();
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(unhandled, []);
        assert.equal(capturedEnv.LILY_SECRET_SENTINEL, undefined);
        assert.equal(capturedEnv.NODE_OPTIONS, undefined);
        assert.equal(capturedEnv.NODE_PATH, undefined);
        assert.equal(capturedEnv.ELECTRON_RUN_AS_NODE, "1");
        await assert.rejects(timedOut.ready(), codeIs("EXPORT_BROKER_TIMEOUT"));
        await timedOut.close();
      } finally {
        if (priorSecret === undefined) delete process.env.LILY_SECRET_SENTINEL;
        else process.env.LILY_SECRET_SENTINEL = priorSecret;
        if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = priorNodeOptions;
        if (priorNodePath === undefined) delete process.env.NODE_PATH;
        else process.env.NODE_PATH = priorNodePath;
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  await check("synchronous commit send failure is cleaned up and remains releasable", async () => {
    const parent = path.join(tmp, "commit-send-throws");
    fs.mkdirSync(parent);
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    class ThrowingCommitChild extends EventEmitter {
      constructor(options) {
        super();
        this.connected = true;
        this.auth = options.env.LILY_DESTINATION_BROKER_AUTH;
        const stat = fs.statSync(options.cwd, { bigint: true });
        queueMicrotask(() => this.emit("message", {
          auth: this.auth,
          kind: "hello",
          version: DESTINATION_BROKER_PROTOCOL.version,
          identity: {
            device: String(stat.dev),
            inode: String(stat.ino),
            mode: String(stat.mode),
          },
        }));
      }

      send(message, callback) {
        if (message.type === "commit") {
          throw Object.assign(new Error("ipc channel closed"), {
            code: "ERR_IPC_CHANNEL_CLOSED",
          });
        }
        const result = message.type === "reserve"
          ? {
              reservationId: "a".repeat(64),
              fileName: message.payload.fileName,
            }
          : message.type === "write"
            ? { bytes: message.payload.bytes.length }
            : message.type === "release"
              ? { released: true }
              : { closed: true };
        queueMicrotask(() => {
          callback?.();
          this.emit("message", {
            auth: this.auth,
            id: message.id,
            ok: true,
            result,
          });
        });
      }

      kill() {
        this.connected = false;
        queueMicrotask(() => this.emit("exit", 0));
        return true;
      }
    }

    let brokerInstance;
    try {
      brokerInstance = createReferenceDestinationBroker({
        approvedParent: parent,
        requestTimeoutMs: 20,
        forkProcess(_helperPath, _args, options) {
          return new ThrowingCommitChild(options);
        },
      });
      await brokerInstance.ready();
      const reserved = await brokerInstance.reserve({ fileName: "card.json" });
      await reserved.write(Buffer.from("safe-to-release"));
      await assert.rejects(
        reserved.commit(),
        codeIs("EXPORT_BROKER_FAILURE"),
      );
      assert.equal(brokerInstance.pending.size, 0);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(unhandled, []);
      assert.equal(await reserved.release(), true);
      await brokerInstance.close();
      assert.deepEqual(brokerInstance.stats(), { reservations: 0, closed: true });
    } finally {
      process.off("unhandledRejection", onUnhandled);
      if (brokerInstance && !brokerInstance.closed) {
        brokerInstance._terminate();
      }
    }
  });

  await check("aborted reference reserve is prompt and compensates late helper success", async () => {
    const parent = path.join(tmp, "abortable-reserve");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      testReserveDelayMs: 50,
    });
    await brokerInstance.ready();
    const controller = new AbortController();
    const startedAt = Date.now();
    const reserving = brokerInstance.reserve(
      { fileName: "cancelled.json" },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(reserving, codeIs("EXPORT_WRITE_CANCELLED"));
    assert(Date.now() - startedAt < 40);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(fs.readdirSync(parent), []);
    assert.deepEqual(brokerInstance.stats(), { reservations: 0, closed: false });
    await brokerInstance.close();
  });

  await check("commit aborts only before send and waits for the published commit result", async () => {
    const parent = path.join(tmp, "commit-abort-boundary");
    const committedTarget = path.join(parent, "committed.json");
    const cancelledTarget = path.join(parent, "cancelled.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      testCommitDelayMs: 100,
    });
    const writer = new CharacterDestinationWriter({
      broker: brokerInstance,
      ownsBroker: true,
    });
    try {
      await brokerInstance.ready();
      const committedCapability = await writer.approve({ fileName: "committed.json" });
      const inFlightAbort = new AbortController();
      const writing = writer.write(
        committedCapability,
        Buffer.from("committed-content"),
        { signal: inFlightAbort.signal },
      );
      await waitFor(
        () => [...writer.capabilities.values()]
          .some((entry) => entry.state === "committing"),
        "commit request was not published",
      );
      inFlightAbort.abort();
      const written = await writing;
      assert.equal(inFlightAbort.signal.aborted, true);
      assert.equal(written.bytes, Buffer.byteLength("committed-content"));
      assert.equal(fs.readFileSync(committedTarget, "utf8"), "committed-content");
      assert.equal(brokerInstance.stats().reservations, 0);

      const cancelledCapability = await writer.approve({ fileName: "cancelled.json" });
      const preSendAbort = new AbortController();
      preSendAbort.abort();
      await assert.rejects(
        writer.write(
          cancelledCapability,
          Buffer.from("must-not-publish"),
          { signal: preSendAbort.signal },
        ),
        codeIs("EXPORT_WRITE_CANCELLED"),
      );
      assert.equal(fs.existsSync(cancelledTarget), false);
      assert.equal(brokerInstance.stats().reservations, 0);
      assert.equal(
        DESTINATION_BROKER_PROTOCOL.capabilities.some(
          (capability) => capability.includes("commit") && capability.includes("abort"),
        ),
        false,
      );
    } finally {
      await writer.close();
    }
  });

  await check("reservation commit admission blocks same-tick release", async () => {
    const parent = path.join(tmp, "commit-admission-release");
    const target = path.join(parent, "card.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      testCommitDelayMs: 50,
    });
    let commitOutcome;
    try {
      await brokerInstance.ready();
      const reserved = await brokerInstance.reserve({ fileName: "card.json" });
      await reserved.write(Buffer.from("same-tick-release"));
      commitOutcome = reserved.commit().then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await assert.rejects(
        reserved.release(),
        codeIs("EXPORT_COMMIT_IN_PROGRESS"),
      );
      const outcome = await commitOutcome;
      assert.equal(outcome.status, "fulfilled");
      assert.equal(outcome.value.bytes, Buffer.byteLength("same-tick-release"));
      assert.equal(fs.readFileSync(target, "utf8"), "same-tick-release");
      assert.equal(brokerInstance.stats().reservations, 0);
    } finally {
      await commitOutcome;
      await brokerInstance.close();
    }
  });

  await check("reservation commit admission blocks same-tick write", async () => {
    const parent = path.join(tmp, "commit-admission-write");
    const target = path.join(parent, "card.json");
    const intended = Buffer.from("intended-commit-bytes");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      testCommitDelayMs: 50,
    });
    let commitOutcome;
    try {
      await brokerInstance.ready();
      const reserved = await brokerInstance.reserve({ fileName: "card.json" });
      await reserved.write(intended);
      commitOutcome = reserved.commit().then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await assert.rejects(
        reserved.write(Buffer.from("must-not-replace-intended")),
        codeIs("EXPORT_COMMIT_IN_PROGRESS"),
      );
      const outcome = await commitOutcome;
      assert.equal(outcome.status, "fulfilled");
      assert.equal(outcome.value.bytes, intended.length);
      assert.deepEqual(fs.readFileSync(target), intended);
      assert.equal(brokerInstance.stats().reservations, 0);
    } finally {
      await commitOutcome;
      await brokerInstance.close();
    }
  });

  await check("reservation commit admission blocks same-tick broker close", async () => {
    const parent = path.join(tmp, "commit-admission-close");
    const target = path.join(parent, "card.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      testCommitDelayMs: 50,
    });
    let commitOutcome;
    try {
      await brokerInstance.ready();
      const reserved = await brokerInstance.reserve({ fileName: "card.json" });
      await reserved.write(Buffer.from("same-tick-close"));
      commitOutcome = reserved.commit().then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await assert.rejects(
        brokerInstance.close(),
        codeIs("EXPORT_COMMIT_IN_PROGRESS"),
      );
      const outcome = await commitOutcome;
      assert.equal(outcome.status, "fulfilled");
      assert.equal(outcome.value.bytes, Buffer.byteLength("same-tick-close"));
      assert.equal(fs.readFileSync(target, "utf8"), "same-tick-close");
      assert.equal(brokerInstance.stats().reservations, 0);
      await brokerInstance.close();
    } finally {
      await commitOutcome;
      if (!brokerInstance.closed) await brokerInstance.close();
    }
  });

  await check("writer close waits for an already-published commit", async () => {
    const parent = path.join(tmp, "close-during-commit");
    const target = path.join(parent, "committed.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      testCommitDelayMs: 100,
    });
    const writer = new CharacterDestinationWriter({
      broker: brokerInstance,
      ownsBroker: true,
      closeTimeoutMs: 500,
    });
    await brokerInstance.ready();
    const capability = await writer.approve({ fileName: "committed.json" });
    const writing = writer.write(capability, Buffer.from("committed-before-close"));
    await waitFor(
      () => [...writer.capabilities.values()]
        .some((entry) => entry.state === "committing"),
      "commit request was not published before close",
    );
    const closing = writer.close();
    const written = await writing;
    await closing;
    assert.equal(written.bytes, Buffer.byteLength("committed-before-close"));
    assert.equal(fs.readFileSync(target, "utf8"), "committed-before-close");
    assert.deepEqual(brokerInstance.stats(), { reservations: 0, closed: true });
  });

  await check("cancel cannot release an already-published commit", async () => {
    const parent = path.join(tmp, "cancel-during-commit");
    const target = path.join(parent, "committed.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      testCommitDelayMs: 100,
    });
    const writer = new CharacterDestinationWriter({
      broker: brokerInstance,
      ownsBroker: true,
    });
    let writingOutcome;
    try {
      await brokerInstance.ready();
      const capability = await writer.approve({ fileName: "committed.json" });
      const writing = writer.write(capability, Buffer.from("cancel-must-not-release"));
      writingOutcome = writing.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await waitFor(
        () => writer.capabilities.get(capability)?.state === "committing",
        "commit request was not published before cancel",
      );
      await assert.rejects(
        writer.cancel(capability),
        codeIs("EXPORT_COMMIT_IN_PROGRESS"),
      );
      const outcome = await writingOutcome;
      assert.equal(outcome.status, "fulfilled");
      assert.equal(outcome.value.bytes, Buffer.byteLength("cancel-must-not-release"));
      assert.equal(fs.readFileSync(target, "utf8"), "cancel-must-not-release");
      assert.equal(brokerInstance.stats().reservations, 0);
    } finally {
      await writingOutcome;
      await writer.close();
    }
  });

  await check("TTL expiry and prune skip an in-flight commit", async () => {
    const parent = path.join(tmp, "ttl-during-commit");
    const target = path.join(parent, "committed.json");
    fs.mkdirSync(parent);
    let now = 0;
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      testCommitDelayMs: 200,
    });
    const writer = new CharacterDestinationWriter({
      broker: brokerInstance,
      ownsBroker: true,
      now: () => now,
      capabilityTtlMs: 50,
      maxCapabilities: 2,
    });
    let writingOutcome;
    try {
      await brokerInstance.ready();
      const capability = await writer.approve({ fileName: "committed.json" });
      const writing = writer.write(capability, Buffer.from("ttl-must-not-release"));
      writingOutcome = writing.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await waitFor(
        () => writer.capabilities.get(capability)?.state === "committing",
        "commit request was not published before TTL expiry",
      );
      await new Promise((resolve) => setTimeout(resolve, 70));
      now = 100;
      const second = await writer.approve({ fileName: "second.json" });
      assert.equal(await writer.cancel(second), true);
      const outcome = await writingOutcome;
      assert.equal(outcome.status, "fulfilled");
      assert.equal(fs.readFileSync(target, "utf8"), "ttl-must-not-release");
    } finally {
      await writingOutcome;
      await writer.close();
    }
  });

  await check("capacity eviction fails busy instead of releasing an in-flight commit", async () => {
    const parent = path.join(tmp, "capacity-during-commit");
    const target = path.join(parent, "committed.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      testCommitDelayMs: 100,
    });
    const writer = new CharacterDestinationWriter({
      broker: brokerInstance,
      ownsBroker: true,
      maxCapabilities: 1,
    });
    let writingOutcome;
    try {
      await brokerInstance.ready();
      const capability = await writer.approve({ fileName: "committed.json" });
      const writing = writer.write(capability, Buffer.from("capacity-must-not-release"));
      writingOutcome = writing.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await waitFor(
        () => writer.capabilities.get(capability)?.state === "committing",
        "commit request was not published before capacity pressure",
      );
      await assert.rejects(
        writer.approve({ fileName: "must-not-reserve.json" }),
        codeIs("EXPORT_DESTINATION_BUSY"),
      );
      const outcome = await writingOutcome;
      assert.equal(outcome.status, "fulfilled");
      assert.equal(fs.readFileSync(target, "utf8"), "capacity-must-not-release");
      assert.equal(fs.existsSync(path.join(parent, "must-not-reserve.json")), false);
    } finally {
      await writingOutcome;
      await writer.close();
    }
  });

  await check("commit deadline reports unknown and late success reconciles exactly", async () => {
    const parent = path.join(tmp, "commit-late-success");
    const target = path.join(parent, "committed.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      requestTimeoutMs: 500,
      testCommitDelayMs: 200,
    });
    const writer = new CharacterDestinationWriter({
      broker: brokerInstance,
      ownsBroker: true,
      commitTimeoutMs: 30,
      closeTimeoutMs: 500,
    });
    try {
      await brokerInstance.ready();
      const capability = await writer.approve({ fileName: "committed.json" });
      const startedAt = Date.now();
      let unknown;
      try {
        await writer.write(capability, Buffer.from("late-commit-content"));
        assert.fail("commit should cross its hard deadline");
      } catch (error) {
        unknown = error;
      }
      const elapsed = Date.now() - startedAt;
      assert.equal(unknown?.code, "EXPORT_COMMIT_OUTCOME_UNKNOWN");
      assert.equal(unknown?.capability, capability);
      assert(elapsed >= 20 && elapsed < 150, `unexpected commit deadline: ${elapsed}ms`);
      assert.equal(writer.capabilities.get(capability)?.state, "outcome_unknown");

      await waitFor(
        () => writer.capabilities.get(capability)?.state === "committed",
        "late commit success was not reconciled",
      );
      const reconciled = await writer.reconcile(capability);
      assert.equal(reconciled.status, "committed");
      assert.equal(reconciled.result.bytes, Buffer.byteLength("late-commit-content"));
      assert.equal(fs.readFileSync(target, "utf8"), "late-commit-content");
      assert.equal(writer.capabilities.has(capability), false);
      assert.equal(brokerInstance.stats().reservations, 0);
    } finally {
      await writer.close();
    }
  });

  await check("late commit error becomes safely releasable after reconciliation", async () => {
    const parent = path.join(tmp, "commit-late-error");
    const target = path.join(parent, "card.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      requestTimeoutMs: 500,
      testCommitDelayMs: 200,
    });
    const writer = new CharacterDestinationWriter({
      broker: brokerInstance,
      ownsBroker: true,
      commitTimeoutMs: 30,
    });
    try {
      await brokerInstance.ready();
      const capability = await writer.approve({ fileName: "card.json" });
      const writing = writer.write(capability, Buffer.from("original-inode"));
      await waitFor(
        () => writer.capabilities.get(capability)?.state === "committing",
        "commit request was not published before replacement",
      );
      fs.unlinkSync(target);
      fs.writeFileSync(target, "replacement-preserved");
      await assert.rejects(writing, codeIs("EXPORT_COMMIT_OUTCOME_UNKNOWN"));
      await waitFor(
        () => writer.capabilities.get(capability)?.state === "retryable_safe",
        "late commit error was not reconciled",
      );
      const reconciled = await writer.reconcile(capability);
      assert.deepEqual(reconciled, {
        status: "retryable_safe",
        errorCode: "EXPORT_RESERVATION_CHANGED",
      });
      assert.equal(await writer.cancel(capability), true);
      assert.equal(fs.readFileSync(target, "utf8"), "replacement-preserved");
      assert.equal(brokerInstance.stats().reservations, 0);
    } finally {
      await writer.close();
    }
  });

  await check("unknown commit keeps recovery state and close fails bounded", async () => {
    const parent = path.join(tmp, "commit-never-responds");
    const target = path.join(parent, "unknown.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      requestTimeoutMs: 500,
      testCommitNeverRespond: true,
    });
    const writer = new CharacterDestinationWriter({
      broker: brokerInstance,
      ownsBroker: true,
      commitTimeoutMs: 30,
      closeTimeoutMs: 60,
      maxCapabilities: 1,
    });
    let capability;
    try {
      await brokerInstance.ready();
      capability = await writer.approve({ fileName: "unknown.json" });
      await assert.rejects(
        writer.write(capability, Buffer.from("unknown-commit-content")),
        (error) => (
          error?.code === "EXPORT_COMMIT_OUTCOME_UNKNOWN"
          && error.capability === capability
        ),
      );
      assert.equal(writer.capabilities.get(capability)?.state, "outcome_unknown");
      assert.equal(fs.readFileSync(target, "utf8"), "unknown-commit-content");
      assert.equal(await writer.release(capability), false);
      await assert.rejects(
        writer.cancel(capability),
        codeIs("EXPORT_COMMIT_OUTCOME_UNKNOWN"),
      );
      await assert.rejects(
        writer.approve({ fileName: "must-stay-busy.json" }),
        codeIs("EXPORT_DESTINATION_BUSY"),
      );
      assert.equal(fs.existsSync(path.join(parent, "must-stay-busy.json")), false);

      const startedAt = Date.now();
      await assert.rejects(
        writer.close(),
        (error) => (
          error?.code === "EXPORT_CLOSE_OUTCOME_UNKNOWN"
          && error.unknownCapabilities?.includes(capability)
        ),
      );
      assert(Date.now() - startedAt < 300);
      assert.equal(writer.capabilities.get(capability)?.state, "outcome_unknown");
      assert.equal(fs.readFileSync(target, "utf8"), "unknown-commit-content");
      assert.deepEqual(brokerInstance.stats(), { reservations: 1, closed: false });
    } finally {
      brokerInstance._terminate();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  await check("cancelled reserve late failure settles compensation without killing broker", async () => {
    const parent = path.join(tmp, "cancelled-reserve-late-error");
    fs.mkdirSync(parent);
    fs.writeFileSync(path.join(parent, "exists.json"), "existing");
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
      requestTimeoutMs: 500,
      testReserveDelayMs: 50,
    });
    try {
      await brokerInstance.ready();
      const controller = new AbortController();
      const reserving = brokerInstance.reserve(
        { fileName: "exists.json" },
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 5);
      await assert.rejects(reserving, codeIs("EXPORT_WRITE_CANCELLED"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(brokerInstance.cancelledRequests.size, 0);

      const next = await brokerInstance.reserve({ fileName: "next.json" });
      await next.release();
      assert.equal(brokerInstance.stats().reservations, 0);
      assert.equal(fs.readFileSync(path.join(parent, "exists.json"), "utf8"), "existing");
    } finally {
      await brokerInstance.close();
    }
  });

  await check("bound parent reservation create and cancel never follow a replacement parent", async () => {
    const parent = path.join(tmp, "bound-parent");
    const displaced = `${parent}-approved`;
    const outside = path.join(tmp, "bound-parent-outside");
    fs.mkdirSync(parent);
    fs.mkdirSync(outside);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
    });
    await brokerInstance.ready();
    fs.renameSync(parent, displaced);
    fs.symlinkSync(outside, parent);

    const writer = new CharacterDestinationWriter({
      broker: brokerInstance,
      ownsBroker: true,
    });
    const capability = await writer.approve({ fileName: "card.json" });
    assert.equal(fs.existsSync(path.join(outside, "card.json")), false);
    assert.equal(await writer.cancel(capability), true);
    assert.equal(fs.existsSync(path.join(outside, "card.json")), false);
    assert.equal(fs.existsSync(path.join(displaced, "card.json")), false);
    assert.deepEqual(fs.readdirSync(displaced), []);
    assert.equal(writer.capabilities.size, 0);
    assert.equal(brokerInstance.stats().reservations, 0);
    await writer.close();
  });

  await check("cancel closes its fd without deleting a replacement basename", async () => {
    const parent = path.join(tmp, "cancel-replacement");
    const target = path.join(parent, "card.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
    });
    await brokerInstance.ready();
    const writer = new CharacterDestinationWriter({
      broker: brokerInstance,
      ownsBroker: true,
    });
    const capability = await writer.approve({ fileName: "card.json" });
    assert.equal(fs.statSync(target).size, 0);
    fs.unlinkSync(target);
    fs.writeFileSync(target, "replacement-content");
    assert.equal(await writer.cancel(capability), true);
    assert.equal(fs.readFileSync(target, "utf8"), "replacement-content");
    assert.equal(brokerInstance.stats().reservations, 0);
    await writer.close();
  });

  await check("commit rejects a replaced basename and preserves the replacement", async () => {
    const parent = path.join(tmp, "commit-replacement");
    const target = path.join(parent, "card.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
    });
    await brokerInstance.ready();
    const replacingBroker = broker({
      async reserve(request, options) {
        const inner = await brokerInstance.reserve(request, options);
        return reservation({
          fileName: inner.fileName,
          async write(bytes, writeOptions) {
            await inner.write(bytes, writeOptions);
            fs.unlinkSync(target);
            fs.writeFileSync(target, "replacement-content");
          },
          commit: inner.commit.bind(inner),
          release: inner.release.bind(inner),
        });
      },
    });
    const writer = new CharacterDestinationWriter({ broker: replacingBroker });
    const capability = await writer.approve({ fileName: "card.json" });
    await assert.rejects(
      writer.write(capability, Buffer.from('{"name":"expected"}')),
      codeIs("EXPORT_RESERVATION_CHANGED"),
    );
    assert.equal(fs.readFileSync(target, "utf8"), "replacement-content");
    assert.equal(brokerInstance.stats().reservations, 0);
    await writer.close();
    await brokerInstance.close();
  });

  await check("reference broker accepts only strict portable basenames", async () => {
    const parent = path.join(tmp, "basename");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
    });
    await brokerInstance.ready();
    for (const fileName of [
      ".",
      "..",
      ".hidden",
      "nested/card.json",
      "nested\\card.json",
      "bad\u0000name.json",
      "bad:name.json",
      "trailing.",
      "trailing ",
      "CON",
      "con.txt",
    ]) {
      await assert.rejects(
        brokerInstance.reserve({ fileName }),
        codeIs("EXPORT_DESTINATION_INVALID"),
        fileName,
      );
    }
    assert.deepEqual(fs.readdirSync(parent), []);
    await brokerInstance.close();
  });

  await check("approve cancellation after delayed reserve waits for release", async () => {
    const reserveStarted = deferred();
    const finishReserve = deferred();
    let released = 0;
    const writer = new CharacterDestinationWriter({
      broker: broker({
        async reserve(_request, { signal, deadline } = {}) {
          assert(signal instanceof AbortSignal);
          assert(Number.isFinite(deadline));
          reserveStarted.resolve();
          await finishReserve.promise;
          return reservation({
            async release() {
              await new Promise((resolve) => setTimeout(resolve, 10));
              released += 1;
            },
          });
        },
      }),
    });
    const controller = new AbortController();
    const approving = writer.approve(
      { saveDialogGrant: "opaque" },
      { signal: controller.signal },
    );
    await reserveStarted.promise;
    controller.abort(Object.assign(new Error("cancelled"), {
      code: "EXPORT_WRITE_CANCELLED",
    }));
    finishReserve.resolve();
    await assert.rejects(approving, codeIs("EXPORT_WRITE_CANCELLED"));
    assert.equal(released, 1);
    assert.equal(writer.capabilities.size, 0);
    await writer.close();
  });

  await check("failed cancellation retains a retryable tombstone", async () => {
    let releaseCalls = 0;
    let reservations = 1;
    const writer = new CharacterDestinationWriter({
      broker: broker({
        async reserve() {
          return reservation({
            async release() {
              releaseCalls += 1;
              if (releaseCalls === 1) throw new Error("injected release failure");
              reservations -= 1;
            },
          });
        },
      }),
    });
    const capability = await writer.approve({ saveDialogGrant: "opaque" });
    await assert.rejects(writer.cancel(capability), codeIs("EXPORT_RELEASE_FAILED"));
    assert.equal(writer.capabilities.size, 1);
    assert.equal(reservations, 1);
    assert.equal(await writer.cancel(capability), true);
    assert.equal(releaseCalls, 2);
    assert.equal(writer.capabilities.size, 0);
    assert.equal(reservations, 0);
    await writer.close();
  });

  await check("cancelled approve retains a pre-capability release tombstone for close retry", async () => {
    const reserveStarted = deferred();
    const finishReserve = deferred();
    let releaseCalls = 0;
    let reservations = 1;
    const writer = new CharacterDestinationWriter({
      broker: broker({
        async reserve() {
          reserveStarted.resolve();
          await finishReserve.promise;
          return reservation({
            async release() {
              releaseCalls += 1;
              if (releaseCalls === 1) throw new Error("injected release failure");
              reservations -= 1;
            },
          });
        },
      }),
    });
    const controller = new AbortController();
    const approving = writer.approve(
      { saveDialogGrant: "opaque" },
      { signal: controller.signal },
    );
    await reserveStarted.promise;
    controller.abort(Object.assign(new Error("cancelled"), {
      code: "EXPORT_WRITE_CANCELLED",
    }));
    finishReserve.resolve();
    await assert.rejects(approving, codeIs("EXPORT_RELEASE_FAILED"));
    assert.equal(writer.maintenanceEntries.size, 1);
    assert.equal(reservations, 1);
    await writer.close();
    assert.equal(releaseCalls, 2);
    assert.equal(reservations, 0);
    assert.equal(writer.maintenanceEntries.size, 0);
  });

  await check("close retries cleanup, reports aggregate failure, and remains retryable", async () => {
    let failRelease = true;
    let releaseCalls = 0;
    const writer = new CharacterDestinationWriter({
      broker: broker({
        async reserve() {
          return reservation({
            async release() {
              releaseCalls += 1;
              if (failRelease) throw new Error("persistent release failure");
            },
          });
        },
      }),
      closeTimeoutMs: 200,
    });
    await writer.approve({ saveDialogGrant: "opaque" });
    await assert.rejects(
      writer.close(),
      (error) => error?.code === "EXPORT_CLOSE_FAILED"
        && Array.isArray(error.failures)
        && error.failures.every((code) => code === "EXPORT_RELEASE_FAILED"),
    );
    assert(releaseCalls >= 2);
    assert.equal(writer.capabilities.size, 1);
    failRelease = false;
    await writer.close();
    assert.equal(writer.capabilities.size, 0);
  });

  await check("owned reference broker cleanup failure remains retryable", async () => {
    if (process.platform === "win32") return;
    const parent = path.join(tmp, "reference-close-retry");
    const target = path.join(parent, "card.json");
    fs.mkdirSync(parent);
    const brokerInstance = createReferenceDestinationBroker({
      approvedParent: parent,
    });
    await brokerInstance.ready();
    const writer = new CharacterDestinationWriter({
      broker: brokerInstance,
      ownsBroker: true,
      closeTimeoutMs: 500,
    });
    await writer.approve({ fileName: "card.json" });
    fs.chmodSync(parent, 0o500);
    try {
      await assert.rejects(writer.close(), codeIs("EXPORT_CLOSE_FAILED"));
      assert.equal(brokerInstance.stats().closed, false);
      assert.equal(brokerInstance.stats().reservations, 1);
    } finally {
      fs.chmodSync(parent, 0o700);
    }
    await writer.close();
    assert.deepEqual(brokerInstance.stats(), { reservations: 0, closed: true });
    assert.equal(fs.existsSync(target), false);
  });

  await check("close aborts a hung reserve and uses owned broker shutdown to drain it", async () => {
    const reserveStarted = deferred();
    let reserveSignal;
    let reserveDeadline;
    let rejectReserve;
    let brokerClosed = 0;
    const writer = new CharacterDestinationWriter({
      broker: broker({
        reserve(_request, { signal, deadline } = {}) {
          reserveSignal = signal;
          reserveDeadline = deadline;
          reserveStarted.resolve();
          return new Promise((_resolve, reject) => {
            rejectReserve = reject;
          });
        },
        async close() {
          brokerClosed += 1;
          rejectReserve(Object.assign(new Error("broker closed"), {
            code: "EXPORT_DESTINATION_CLOSED",
          }));
        },
      }),
      ownsBroker: true,
      closeTimeoutMs: 100,
    });
    const approving = writer.approve({ saveDialogGrant: "opaque" });
    await reserveStarted.promise;
    const startedAt = Date.now();
    await writer.close();
    assert(Date.now() - startedAt < 500);
    await assert.rejects(approving, codeIs("EXPORT_DESTINATION_CLOSED"));
    assert.equal(reserveSignal.aborted, true);
    assert(Number.isFinite(reserveDeadline));
    assert.equal(brokerClosed, 1);
    assert.equal(writer.capabilities.size, 0);
    assert.equal(writer.approvals.size, 0);
  });

  await check("close is bounded and fail-loud for an uncooperative shared broker", async () => {
    const reserveStarted = deferred();
    const writer = new CharacterDestinationWriter({
      broker: broker({
        async reserve(_request, { signal, deadline } = {}) {
          assert(signal instanceof AbortSignal);
          assert(Number.isFinite(deadline));
          reserveStarted.resolve();
          await new Promise(() => {});
        },
      }),
      closeTimeoutMs: 40,
    });
    void writer.approve({ saveDialogGrant: "opaque" });
    await reserveStarted.promise;
    const startedAt = Date.now();
    await assert.rejects(writer.close(), codeIs("EXPORT_CLOSE_TIMEOUT"));
    assert(Date.now() - startedAt < 500);
    assert.equal(writer.capabilities.size, 0);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`character-worlds-destination-broker: ${checks} checks passed`);
