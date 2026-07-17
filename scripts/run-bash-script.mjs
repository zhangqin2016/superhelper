#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const env = { ...process.env };

while (args[0] === "--env") {
  const assignment = args[1] || "";
  const index = assignment.indexOf("=");
  if (index <= 0) {
    console.error(`[run-bash-script] invalid --env assignment: ${assignment}`);
    process.exit(1);
  }
  env[assignment.slice(0, index)] = assignment.slice(index + 1);
  args.splice(0, 2);
}

if (!args.length) {
  console.error("[run-bash-script] usage: node scripts/run-bash-script.mjs [--env KEY=VALUE] <script> [...args]");
  process.exit(1);
}

function existing(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function gitBashPath() {
  if (process.platform !== "win32") return null;
  return existing([
    path.join(process.env.ProgramFiles || "", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
  ]);
}

const bash = gitBashPath() || "bash";
const result = spawnSync(bash, args, {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`[run-bash-script] failed to launch ${bash}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
