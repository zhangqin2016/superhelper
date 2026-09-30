import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDb } from "./db.js";

const app = await buildApp();

// Stopping drains: no new connections, requests in flight (a model answer
// still streaming) finish, then the process exits. Bounded, so a stuck
// request cannot hold the old release forever; the container's stop grace
// (stop_grace_period) is longer than this bound. Deploys switch traffic to the
// new release before stopping this one (deploy-api-bluegreen.sh), so the drain
// normally has nothing left to wait for.
const DRAIN_TIMEOUT_MS = Math.max(1_000, Number(process.env.LILY_DRAIN_TIMEOUT_MS) || 110_000);
let stopping = false;

const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  const started = Date.now();
  app.log.info({ signal, drainTimeoutMs: DRAIN_TIMEOUT_MS }, "shutdown: draining requests in flight");
  const bound = setTimeout(() => {
    app.log.warn({ signal, waitedMs: Date.now() - started }, "shutdown: drain bound reached; exiting with requests still open");
    process.exit(1);
  }, DRAIN_TIMEOUT_MS);
  bound.unref();
  try {
    await app.close();
    await closeDb();
    app.log.info({ signal, waitedMs: Date.now() - started }, "shutdown: drained");
    process.exit(0);
  } catch (err) {
    app.log.error({ err, signal }, "shutdown: close failed");
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await app.listen({ port: config.port, host: "0.0.0.0" });
