import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { syncEngineGuideMirror, clearMirrorAttributes, repairGuideDir } = await import(
  pathToFileURL(path.join(__dirname, "../src/main/agent-guide-mirror.js")).href
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-guide-mirror-"));

try {
  const configDir = path.join(root, "cfg");
  fs.mkdirSync(configDir, { recursive: true });
  const agent = path.join(configDir, "AGENT.md");
  const mirror = path.join(configDir, "CLAUDE.md");

  fs.writeFileSync(agent, "v1\n", "utf8");
  if (!syncEngineGuideMirror(agent, configDir)) throw new Error("first sync failed");
  if (fs.readFileSync(mirror, "utf8") !== "v1\n") throw new Error("mirror content v1");

  fs.writeFileSync(agent, "v2\n", "utf8");
  if (process.platform === "win32") {
    execFileSync("attrib", ["+H", "+R", mirror], { stdio: "ignore" });
  } else if (process.platform === "darwin") {
    execFileSync("chflags", ["hidden", mirror], { stdio: "ignore" });
  }

  clearMirrorAttributes(mirror);
  if (!syncEngineGuideMirror(agent, configDir)) throw new Error("second sync failed");
  if (fs.readFileSync(mirror, "utf8") !== "v2\n") {
    throw new Error("mirror not updated after hidden/read-only (EPERM regression)");
  }

  const sessionRoot = path.join(root, "session-guides", "sess-a");
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, "AGENT.md"), "session\n", "utf8");
  fs.writeFileSync(path.join(sessionRoot, "CLAUDE.md"), "stale-session\n", "utf8");
  if (process.platform === "win32") {
    execFileSync("attrib", ["+H", "+R", path.join(sessionRoot, "CLAUDE.md")], {
      stdio: "ignore",
    });
  } else if (process.platform === "darwin") {
    execFileSync("chflags", ["hidden", path.join(sessionRoot, "CLAUDE.md")], {
      stdio: "ignore",
    });
  }
  if (!repairGuideDir(sessionRoot)) throw new Error("repairGuideDir session failed");
  if (fs.readFileSync(path.join(sessionRoot, "CLAUDE.md"), "utf8") !== "session\n") {
    throw new Error("session mirror not repaired");
  }

  const globalDir = path.join(root, "lily-config");
  fs.mkdirSync(globalDir, { recursive: true });
  fs.writeFileSync(path.join(globalDir, "AGENT.md"), "global\n", "utf8");
  fs.writeFileSync(path.join(globalDir, "CLAUDE.md"), "stale-global\n", "utf8");
  if (process.platform === "win32") {
    execFileSync("attrib", ["+H", "+R", path.join(globalDir, "CLAUDE.md")], {
      stdio: "ignore",
    });
  } else if (process.platform === "darwin") {
    execFileSync("chflags", ["hidden", path.join(globalDir, "CLAUDE.md")], {
      stdio: "ignore",
    });
  }
  if (!repairGuideDir(globalDir)) throw new Error("repairGuideDir global failed");
  if (fs.readFileSync(path.join(globalDir, "CLAUDE.md"), "utf8") !== "global\n") {
    throw new Error("global mirror not repaired");
  }

  console.log("agent-guide-mirror: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
