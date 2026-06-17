"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");
const {
  normalizePlaybookSpec,
  redactConnectorSecrets,
} = require("./connector-protocol");

function defaultRootDir() {
  return userDataPath("connector-playbooks");
}

function createConnectorStore(options = {}) {
  const rootDir = path.resolve(options.rootDir || defaultRootDir());

  function fileFor(id) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(String(id || ""))) {
      throw new Error("connector playbook id is invalid");
    }
    return path.join(rootDir, `${id}.json`);
  }

  function savePlaybook(input) {
    const playbook = normalizePlaybookSpec(input);
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(fileFor(playbook.id), JSON.stringify(playbook, null, 2) + "\n", "utf8");
    return playbook;
  }

  function getPlaybook(id) {
    const file = fileFor(id);
    if (!fs.existsSync(file)) return null;
    return normalizePlaybookSpec(JSON.parse(fs.readFileSync(file, "utf8")));
  }

  function listPlaybooks() {
    let files = [];
    try {
      files = fs.readdirSync(rootDir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const playbooks = [];
    for (const file of files) {
      try {
        playbooks.push(normalizePlaybookSpec(JSON.parse(fs.readFileSync(path.join(rootDir, file), "utf8"))));
      } catch {
        // Invalid drafts are ignored by the public list; loading a specific id
        // still fails loud through getPlaybook after file inspection.
      }
    }
    return playbooks.sort((a, b) => a.name.localeCompare(b.name));
  }

  function listPlaybooksPublic() {
    return listPlaybooks().map((playbook) => redactConnectorSecrets(playbook));
  }

  function removePlaybook(id) {
    const file = fileFor(id);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }

  return {
    rootDir,
    savePlaybook,
    getPlaybook,
    listPlaybooks,
    listPlaybooksPublic,
    removePlaybook,
  };
}

module.exports = {
  createConnectorStore,
  defaultRootDir,
};
