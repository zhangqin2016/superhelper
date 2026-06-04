process.env.DATABASE_URL ||= "postgres://smoke:smoke@localhost:5432/smoke";

const { buildApp } = await import("../src/app.js");
const { closeDb } = await import("../src/db.js");

const app = await buildApp();

async function assertResponse(method, url, expectedStatus) {
  const response = await app.inject({ method, url });
  if (response.statusCode !== expectedStatus) {
    throw new Error(`${method} ${url} expected ${expectedStatus}, got ${response.statusCode}: ${response.body}`);
  }
}

try {
  await assertResponse("GET", "/health", 200);
  await assertResponse("GET", "/api/admin/summary", 401);
  console.log("server-smoke: ok");
} finally {
  await app.close();
  await closeDb();
}
