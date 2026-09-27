"use strict";

/**
 * What a background job actually ended with, for a notice the host writes
 * itself when no model turn will read it.
 *
 * A paused continuation used to say only "no new progress": the job's exit
 * code and error never reached the model or the user, and a release that
 * failed on its first packaging step read as a vague stop (2026-09-27). This
 * states the terminal state and the job's own last error lines — read from its
 * logs, bounded, with every value of its launch environment and anything shaped
 * like a credential removed (a launch environment can carry a release password).
 */

const fs = require("node:fs");
const path = require("node:path");

const STATUS_ZH = Object.freeze({
  succeeded: "成功", failed: "失败", cancelled: "已取消", outcome_unknown: "结果未知", timed_out: "超时",
});
const SIGNAL_RE = /error|fail|unknown argument|exception|denied|not found|timed? ?out|cannot|refused|错误|失败|超时/i;
const MAX_LINES = 6;
const MAX_LINE = 240;
const TAIL_BYTES = 16 * 1024;

function tail(file) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch {
    return "";
  }
}

/** Values the job was launched with: never echoed back, whatever they are. */
function launchEnvValues(job) {
  try {
    const dir = path.dirname(job.stdoutPath || job.stderrPath || "");
    const launch = JSON.parse(fs.readFileSync(path.join(dir, `${job.id}.launch.json`), "utf8"));
    return Object.values(launch?.env || {}).map(String).filter((value) => value.length >= 6);
  } catch {
    return [];
  }
}

function redact(text, secrets) {
  let out = String(text || "");
  for (const secret of secrets) out = out.split(secret).join("***");
  return out
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
    .replace(/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)\S+/gi, "$1***")
    // Token-shaped: one long run of letters and digits (a path has slashes).
    .replace(/(?<![\w/.-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}/g, "***");
}

/** The last lines that say what went wrong, else simply the last lines. */
function tellingLines(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
  const signal = lines.filter((line) => SIGNAL_RE.test(line));
  return (signal.length ? signal : lines).slice(-MAX_LINES).map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line));
}

function jobOutcomeSummary(job) {
  if (!job?.id) return "";
  const status = STATUS_ZH[job.status] || job.status || "未知";
  const exit = job.exitCode == null ? "" : `，退出码 ${job.exitCode}`;
  const head = `后台作业 ${job.id}：${status}${exit}${job.signal ? `，信号 ${job.signal}` : ""}。`;
  if (job.status === "succeeded") return head;
  const secrets = launchEnvValues(job);
  const lines = tellingLines(`${tail(job.stdoutPath)}\n${tail(job.stderrPath)}`);
  const error = job.error ? redact(job.error, secrets).slice(0, MAX_LINE) : "";
  const body = lines.length ? `\n最后的输出：\n${lines.map((line) => `    ${redact(line, secrets)}`).join("\n")}` : "";
  return `${head}${error ? `\n错误：${error}` : ""}${body}`;
}

module.exports = { jobOutcomeSummary, redact, tellingLines };
