#!/usr/bin/env node
/**
 * Lightweight checks for stream-json text merging (no Electron / no engine binary).
 */
import { appendTextSegment, sanitizeError } from "../src/main/agent-runner.js";
import { sameSpawnOptions } from "../src/main/runner-spawn-options.js";

const merged = appendTextSegment("hello", "world");
if (merged !== "hello\n\nworld") throw new Error(`appendTextSegment failed: ${merged}`);

const friendly = sanitizeError("engine-upstream: command not found");
if (!friendly.includes("助手")) throw new Error(`sanitizeError failed: ${friendly}`);

if (
  !sameSpawnOptions(
    { agentCommand: "/a/lily-workbench", permissionMode: "default", disallowedTools: ["WebFetch", "WebSearch"] },
    { agentCommand: "/a/lily-workbench", permissionMode: "default", disallowedTools: ["WebSearch", "WebFetch"] },
  )
) {
  throw new Error("sameSpawnOptions order sensitivity failed");
}

if (
  sameSpawnOptions(
    { agentCommand: "/a/lily-workbench", permissionMode: "default", disallowedTools: [] },
    { agentCommand: "/a/lily-workbench", permissionMode: "bypassPermissions", disallowedTools: [] },
  )
) {
  throw new Error("sameSpawnOptions permissionMode failed");
}

if (
  sameSpawnOptions(
    { agentCommand: "/a/lily-workbench", permissionMode: "default", disallowedTools: ["WebSearch"] },
    { agentCommand: "/a/lily-workbench", permissionMode: "default", disallowedTools: [] },
  )
) {
  throw new Error("sameSpawnOptions disallowedTools failed");
}

if (
  sameSpawnOptions(
    { agentCommand: "/a/lily-workbench", permissionMode: "default", stagingDir: "/tmp/a" },
    { agentCommand: "/a/lily-workbench", permissionMode: "default", stagingDir: "/tmp/b" },
  )
) {
  throw new Error("sameSpawnOptions stagingDir failed");
}

console.log("agent-runner: ok");
