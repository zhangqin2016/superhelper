#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const specPath = process.argv[2];
if (!specPath) process.exit(125);
const child = spawn(process.execPath, [path.join(__dirname, "worker-launcher.js"), specPath], {
  detached: true,
  stdio: "inherit",
  windowsHide: true,
});
child.unref();
