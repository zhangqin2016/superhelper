"use strict";

const { spawn } = require("node:child_process");

function exitAndRemove({ app, window, directory, timer, code }) {
  if (timer) clearTimeout(timer);
  if (window && !window.isDestroyed()) window.destroy();
  const cleanup = [
    "const fs=require('node:fs');",
    "const dir=process.argv[1];",
    "for(let attempt=0;attempt<40;attempt++){",
    "try{fs.rmSync(dir,{recursive:true,force:true});process.exit(0)}catch(error){",
    "if(!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))process.exit(1);",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);",
    "}}process.exit(1);",
  ].join("");
  spawn(process.execPath, ["-e", cleanup, directory], {
    detached: true,
    env: { ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  app.exit(code);
}

module.exports = { exitAndRemove };
