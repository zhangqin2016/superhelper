import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const deployDir = path.join(repoRoot, "deploy", "baota");

const modes = [
  ["docker-compose.yml"],
  ["docker-compose.external-postgres.yml"],
  ["docker-compose.app-only.yml"],
  ["docker-compose.images-app-only.yml"],
  ["docker-compose.yml", "docker-compose.litellm.yml"],
  ["docker-compose.external-postgres.yml", "docker-compose.litellm.yml"],
  ["docker-compose.app-only.yml", "docker-compose.litellm.yml"],
  ["docker-compose.images-app-only.yml", "docker-compose.litellm.yml"],
];

function dockerComposeCommand() {
  const dockerCompose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  if (dockerCompose.status === 0) return ["docker", "compose"];
  const legacy = spawnSync("docker-compose", ["version"], { stdio: "ignore" });
  if (legacy.status === 0) return ["docker-compose"];
  return null;
}

function buildEnvFile() {
  const deployEnvFile = path.join(deployDir, ".env");
  if (fs.existsSync(deployEnvFile)) {
    return { file: deployEnvFile, cleanup: () => {} };
  }
  const content = fs.readFileSync(path.join(deployDir, ".env.example"), "utf8")
    .replace(/^DB_MODE=.*/m, "DB_MODE=external")
    .replace(/^GATEWAY_MODE=.*/m, "GATEWAY_MODE=external")
    .replace(/^DATABASE_URL=.*/m, "DATABASE_URL=postgres://lily:lily@127.0.0.1:5432/lily_workbench")
    .replace(/^ADMIN_TOKEN=.*/m, "ADMIN_TOKEN=compose-check-admin-token")
    .replace(/^SESSION_SECRET=.*/m, "SESSION_SECRET=compose-check-session-secret-at-least-32-chars")
    .replace(/^POSTGRES_PASSWORD=.*/m, "POSTGRES_PASSWORD=compose-check-postgres-password")
    .replace(/^MODEL_GATEWAY_TOKEN_SECRET=.*/m, "MODEL_GATEWAY_TOKEN_SECRET=compose-check-model-gateway-token-secret");
  const file = deployEnvFile;
  fs.writeFileSync(file, content);
  return { file, cleanup: () => fs.rmSync(file, { force: true }) };
}

const command = dockerComposeCommand();
if (!command) {
  console.log("baota-compose-check: skipped (docker compose unavailable)");
  process.exit(0);
}

const temp = buildEnvFile();
try {
  for (const files of modes) {
    const args = [
      ...command.slice(1),
      "--env-file",
      temp.file,
      ...files.flatMap((file) => ["-f", file]),
      "config",
      "--quiet",
    ];
    const result = spawnSync(command[0], args, { cwd: deployDir, encoding: "utf8" });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout || "");
      throw new Error(`compose config failed for ${files.join(" + ")}`);
    }
  }
  console.log(`baota-compose-check: ok (${modes.length} modes)`);
} finally {
  temp.cleanup();
}
