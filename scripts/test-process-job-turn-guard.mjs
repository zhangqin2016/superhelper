#!/usr/bin/env node

import { createRequire } from "node:module";
import { assert, finish } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const {
  findBlockingRunningProcessJobs,
  runningProcessJobNotice,
} = require("../src/main/process-job-turn-guard.js");

const renderTool = {
  id: "tool_render",
  name: "job_status",
  status: "done",
  result: {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        jobId: "job_blender",
        status: "running",
        state: "running",
        phase: "render",
        progress: { label: "frame", current: 700, total: 2440 },
        outputFiles: ["output/yugong_blender/frame_0007.png"],
      }),
    }],
  },
};

const blockers = findBlockingRunningProcessJobs([renderTool]);
assert(blockers.length === 1, `running render job should block completion: ${JSON.stringify(blockers)}`);
assert(blockers[0].jobId === "job_blender", "job id is preserved for follow-up");
assert(blockers[0].progress.current === 700, "progress is preserved");
assert(runningProcessJobNotice(blockers).includes("job_blender"), "notice names the running job");

const serviceTool = {
  id: "tool_server",
  name: "job_start",
  status: "done",
  result: {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        jobId: "job_dev_server",
        status: "running",
        state: "running",
        health: { ok: true, type: "http" },
      }),
    }],
  },
};
assert(
  findBlockingRunningProcessJobs([serviceTool]).length === 0,
  "healthy long-lived service without deliverable progress should not block completion",
);

const finishedRenderTool = {
  ...renderTool,
  result: {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        jobId: "job_blender",
        status: "exited",
        state: "exited",
        progress: { current: 2440, total: 2440 },
        outputFiles: ["output/yugong_blender/yugong_blender_0000-2439.mp4"],
      }),
    }],
  },
};
assert(
  findBlockingRunningProcessJobs([finishedRenderTool]).length === 0,
  "exited render job should not block completion",
);

finish("test-process-job-turn-guard", 5);
