"use strict";

function createProcessJobDispatch({ evaluateHealth, legacy }) {
  function runtime(options = {}) {
    const durable = options.durable || (
      process.env.LILY_LONG_TASK_DB && process.env.LILY_PROCESS_JOBS_SCOPE_SECRET
        ? { dbPath: process.env.LILY_LONG_TASK_DB, secret: process.env.LILY_PROCESS_JOBS_SCOPE_SECRET }
        : null
    );
    if (!durable?.dbPath || !durable?.secret) return null;
    const { DurableProcessJobRuntime } = require("./process-job-runtime");
    return new DurableProcessJobRuntime({ ...durable, evaluateHealth });
  }
  return {
    startJob: (input = {}, options = {}) => runtime(options)?.start(input) || legacy.start(input, options),
    statusJob: (input = {}, options = {}) => runtime(options)?.status(input) || legacy.status(input, options),
    logsJob: (input = {}, options = {}) => runtime(options)?.logs(input) || legacy.logs(input, options),
    stopJob: (input = {}, options = {}) => runtime(options)?.stop(input) || legacy.stop(input, options),
    listJobs: (input = {}, options = {}) => runtime(options)?.list(input) || legacy.list(input, options),
  };
}

module.exports = { createProcessJobDispatch };
