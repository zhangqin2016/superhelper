"use strict";

async function run() {
  const packs = require("./runtime-pack-installer");
  await packs.warmBaseProvidedRuntimePacks();
  return packs.repairInstalledRuntimePacks();
}

run()
  .then((result) => {
    if (process.send) process.send({ type: "runtime-pack-auto-repair-result", result });
  })
  .catch((error) => {
    if (process.send) {
      process.send({
        type: "runtime-pack-auto-repair-error",
        error: error?.stack || error?.message || String(error),
      });
    }
    process.exitCode = 1;
  })
  .finally(() => process.disconnect?.());
