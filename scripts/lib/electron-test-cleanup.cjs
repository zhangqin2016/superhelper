"use strict";
const fs = require("node:fs");

// Chromium can retain profile handles until process exit on Windows.
module.exports = function cleanupElectronTest(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
    console.warn("Electron test profile still locked; retained for cleanup after exit:", directory);
  }
};
