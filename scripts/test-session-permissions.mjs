#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-session-permissions-"));

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: (name) => {
        if (name === "userData") return path.join(tempRoot, "userData");
        if (name === "home") return tempRoot;
        if (name === "documents") return tempRoot;
        return tempRoot;
      },
    },
  },
};

const SessionManager = require("../src/main/session-manager.js");
const {
  listSessionPermissionsPublic,
  resolveSessionPermissionMode,
  setActivePermissionMode,
} = require("../src/main/permission-settings.js");

const projectManager = {
  projects: [{ id: "p1", name: "Workspace", path: tempRoot }],
  getActive() {
    return this.projects[0];
  },
};

try {
  setActivePermissionMode("ask");
  const manager = new SessionManager(projectManager);
  manager.load();
  const session = manager.getActive();
  if (!session) throw new Error("expected default session");

  let publicState = listSessionPermissionsPublic(session);
  if (!publicState.inherited || publicState.modeId !== null || publicState.effectiveModeId !== "ask") {
    throw new Error(`default inherit failed: ${JSON.stringify(publicState)}`);
  }

  if (!manager.setPermissionMode(session.id, "plan")) {
    throw new Error("set session permission failed");
  }
  const overridden = manager.findById(session.id);
  publicState = listSessionPermissionsPublic(overridden);
  if (publicState.inherited || publicState.modeId !== "plan" || resolveSessionPermissionMode(overridden) !== "plan") {
    throw new Error(`session override failed: ${JSON.stringify(publicState)}`);
  }

  setActivePermissionMode("full");
  publicState = listSessionPermissionsPublic(overridden);
  if (publicState.effectiveModeId !== "plan" || publicState.globalModeId !== "full") {
    throw new Error(`override should not follow global: ${JSON.stringify(publicState)}`);
  }

  if (!manager.setPermissionMode(session.id, "inherit")) {
    throw new Error("clear session permission failed");
  }
  const inherited = manager.findById(session.id);
  publicState = listSessionPermissionsPublic(inherited);
  if (!publicState.inherited || publicState.effectiveModeId !== "full") {
    throw new Error(`inherit after clear failed: ${JSON.stringify(publicState)}`);
  }

  if (manager.setPermissionMode(session.id, "not-a-mode")) {
    throw new Error("invalid permission mode should be rejected");
  }

  const listItem = manager.listForProject("p1")[0];
  if (listItem.permissionModeId !== null || listItem.permissionCustomized !== false) {
    throw new Error(`listForProject permission fields failed: ${JSON.stringify(listItem)}`);
  }

  console.log("session-permissions: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
