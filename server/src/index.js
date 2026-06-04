import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDb } from "./db.js";

const app = await buildApp();

const shutdown = async () => {
  await app.close();
  await closeDb();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: "0.0.0.0" });
