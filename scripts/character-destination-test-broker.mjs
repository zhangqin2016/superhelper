import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DESTINATION_BROKER_PROTOCOL,
  DESTINATION_RESERVATION_PROTOCOL,
} = require("../src/main/character-worlds/destination-broker-protocol.js");
const {
  createReferenceDestinationBroker,
} = require("../src/main/character-worlds/reference-destination-broker.js");

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function contained(root, candidate) {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

// Tests still express save-dialog grants as paths. This adapter is deliberately
// test-only: it authorizes the path, then delegates the actual transaction to
// the same bound-directory broker contract production wiring will consume.
export function createTestDestinationBroker(root, hooks = {}) {
  const requestedRoot = path.resolve(root);
  const canonicalRoot = fs.realpathSync(root);
  const parentBrokers = new Map();
  const liveReservations = new Set();
  let closed = false;

  async function brokerFor(parent) {
    let broker = parentBrokers.get(parent);
    if (!broker) {
      broker = createReferenceDestinationBroker({ approvedParent: parent });
      parentBrokers.set(parent, broker);
    }
    await broker.ready();
    return broker;
  }

  return {
    protocol: DESTINATION_BROKER_PROTOCOL,

    async reserve(filePath, options = {}) {
      if (closed) {
        throw codedError("EXPORT_DESTINATION_CLOSED", "Destination broker is closed");
      }
      if (typeof filePath !== "string") {
        throw codedError(
          "EXPORT_DESTINATION_UNAUTHORIZED",
          "Export destination is not authorized",
        );
      }
      const requestedTarget = path.resolve(filePath);
      if (!contained(requestedRoot, requestedTarget)) {
        throw codedError(
          "EXPORT_DESTINATION_UNAUTHORIZED",
          "Export destination is not authorized",
        );
      }
      let parent;
      try {
        parent = fs.realpathSync(path.dirname(requestedTarget));
      } catch {
        throw codedError(
          "EXPORT_DESTINATION_UNAUTHORIZED",
          "Export destination is not authorized",
        );
      }
      if (!contained(canonicalRoot, parent)) {
        throw codedError(
          "EXPORT_DESTINATION_UNAUTHORIZED",
          "Export destination is not authorized",
        );
      }

      const fileName = path.basename(requestedTarget);
      const target = path.join(parent, fileName);
      hooks.beforeOpen?.({ target, parent });
      const parentBroker = await brokerFor(parent);
      const inner = await parentBroker.reserve({ fileName }, options);
      let committed = false;
      let released = false;
      const wrapped = {
        protocol: DESTINATION_RESERVATION_PROTOCOL,
        fileName: inner.fileName,
        async write(data, writeOptions = {}) {
          const bytes = Buffer.from(data);
          await hooks.beforeWrite?.({ target, bytes, signal: writeOptions.signal });
          return inner.write(bytes, writeOptions);
        },
        async commit(commitOptions = {}) {
          const result = await inner.commit(commitOptions);
          committed = true;
          hooks.afterCommit?.({ target });
          return result;
        },
        async reconcile() {
          const result = await inner.reconcile();
          if (result?.status === "committed") {
            if (!committed) hooks.afterCommit?.({ target });
            committed = true;
            released = true;
            liveReservations.delete(wrapped);
          }
          return result;
        },
        async release(releaseOptions = {}) {
          if (released) return false;
          const result = await inner.release(releaseOptions);
          released = true;
          liveReservations.delete(wrapped);
          hooks.afterRelease?.({ target, committed });
          return result;
        },
      };
      liveReservations.add(wrapped);
      return wrapped;
    },

    stats() {
      return {
        reservations: liveReservations.size,
        closed,
      };
    },

    async close(options = {}) {
      if (closed) return;
      closed = true;
      const failures = [];
      await Promise.all([...parentBrokers.values()].map(async (broker) => {
        try {
          await broker.close(options);
        } catch (error) {
          failures.push(error);
        }
      }));
      if (failures.length > 0) {
        const aggregate = new AggregateError(failures, "Test destination broker close failed");
        aggregate.code = "EXPORT_CLOSE_FAILED";
        throw aggregate;
      }
      liveReservations.clear();
    },
  };
}
