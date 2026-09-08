import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lily-job-packaging-"));
try {
  const app = path.join(temporary, "app");
  const resources = path.join(temporary, "Resources");
  fs.cpSync(path.join(root, "src"), path.join(app, "src"), { recursive: true });
  const helper = path.join(resources, "resources/opencode-plugins/lib/job-observation.cjs");
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.copyFileSync(path.join(root, "resources/opencode-plugins/lib/job-observation.cjs"), helper);
  const code = `
    const assert = require('node:assert/strict');
    process.resourcesPath = process.argv[1];
    const {observeTurnLoop} = require(process.argv[2] + '/src/main/turn-loop-guard');
    const {rememberExecutionProgress} = require(process.argv[2] + '/src/main/task-execution-progress');
    const session = {_turnGates:{}, _pendingPermissions:new Map(), _pendingQuestions:new Map(), _activeTools:new Map()};
    const gate = {}; let decision;
    for(let i=0;i<14;i++) {
      const start={type:'tool.started',payload:{id:'call'+i,name:'lily_pj_job_status',input:{jobId:'job-test'}}};
      const done={type:'tool.done',payload:{id:'call'+i,content:JSON.stringify({ok:true,jobId:'job-test',status:'running',updatedAt:String(i)})}};
      decision=observeTurnLoop(session,{progress:true,drafts:[start,done]});
      rememberExecutionProgress(gate,start); rememberExecutionProgress(gate,done);
    }
    const enabled=process.argv[3]==='enabled';
    assert.equal(decision.stop,enabled);
    assert.equal(gate.progress,enabled?1:14);
  `;
  for (const mode of ["enabled", "missing", "invalid"]) {
    if (mode === "missing") fs.unlinkSync(helper);
    if (mode === "invalid") fs.writeFileSync(helper, "module.exports = {};\n");
    const result = spawnSync(process.execPath, ["-e", code, resources, app, mode], { encoding: "utf8" });
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
  }
  console.log("job-observation-packaging: PASS (external resources, missing/invalid fail-open)");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
