"use strict";

/**
 * Is a background job actually working, or merely still running?
 *
 * A pid that is alive says nothing about a server that stopped answering, so a
 * job declares how it should be checked (process, tcp, http, log) and this is
 * where each kind is answered. Kept apart from the job registry because the
 * probes are pure I/O against the outside world: the registry's own tests need
 * no sockets, and a new probe kind lands here without touching job bookkeeping.
 *
 * The two utilities that come from the registry side (liveness by pid, reading
 * a log tail) are injected rather than imported, so this module cannot reach
 * back into job state.
 *
 * The network modules come in too: a probe reaches the outside world, and a
 * test that controls that boundary must be able to hand its own in.
 *
 * @param {{ isPidAlive: (pid: number) => boolean,
 *           readRange: (file: string, opts: { tailBytes: number }) => { text: string },
 *           logTailBytes: number, timeoutMs: number,
 *           http: object, https: object, net: object }} deps
 */
function createJobHealthProbes({ isPidAlive, readRange, logTailBytes, timeoutMs: defaultTimeoutMs, http, https, net }) {
  const DEFAULT_HEALTH_TIMEOUT_MS = defaultTimeoutMs;
  const DEFAULT_LOG_TAIL_BYTES = logTailBytes;

  function healthProcess(record) {
    return {
      ok: isPidAlive(record.pid),
      type: "process",
      detail: isPidAlive(record.pid) ? "process_alive" : "process_not_running",
    };
  }
  
  function healthTcp(check = {}) {
    return new Promise((resolve) => {
      const host = check.host || "127.0.0.1";
      const port = Number(check.port);
      if (!Number.isInteger(port) || port <= 0) {
        resolve({ ok: false, type: "tcp", detail: "port_required" });
        return;
      }
      const socket = net.createConnection({ host, port });
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, type: "tcp", detail: "timeout" });
      }, Number(check.timeoutMs || DEFAULT_HEALTH_TIMEOUT_MS));
      socket.once("connect", () => {
        clearTimeout(timeout);
        socket.end();
        resolve({ ok: true, type: "tcp", detail: `${host}:${port}` });
      });
      socket.once("error", (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, type: "tcp", detail: err?.code || err?.message || "connect_failed" });
      });
    });
  }
  
  function healthHttp(check = {}) {
    return new Promise((resolve) => {
      if (!check.url) {
        resolve({ ok: false, type: "http", detail: "url_required" });
        return;
      }
      let parsed;
      try {
        parsed = new URL(check.url);
      } catch {
        resolve({ ok: false, type: "http", detail: "invalid_url" });
        return;
      }
      const client = parsed.protocol === "https:" ? https : http;
      const req = client.request(parsed, { method: "GET", timeout: Number(check.timeoutMs || DEFAULT_HEALTH_TIMEOUT_MS) }, (res) => {
        res.resume();
        const min = Number(check.minStatus || 200);
        const max = Number(check.maxStatus || 399);
        resolve({ ok: res.statusCode >= min && res.statusCode <= max, type: "http", detail: `status_${res.statusCode}` });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, type: "http", detail: "timeout" });
      });
      req.on("error", (err) => resolve({ ok: false, type: "http", detail: err?.code || err?.message || "request_failed" }));
      req.end();
    });
  }
  
  function healthLog(record, check = {}) {
    const needle = String(check.contains || "");
    if (!needle) return { ok: false, type: "log", detail: "contains_required" };
    const tailBytes = Number(check.tailBytes || DEFAULT_LOG_TAIL_BYTES);
    const stdout = readRange(record.stdoutPath, { tailBytes }).text;
    const stderr = readRange(record.stderrPath, { tailBytes }).text;
    const ok = stdout.includes(needle) || stderr.includes(needle);
    return { ok, type: "log", detail: ok ? "matched" : "not_found" };
  }
  
  async function evaluateHealth(record = {}, check = null) {
    const healthcheck = check || record.healthcheck || { type: "process" };
    const type = String(healthcheck.type || "process");
    if (type === "none") return { ok: true, type: "none", detail: "not_required" };
    if (type === "process") return healthProcess(record);
    if (type === "tcp") return healthTcp(healthcheck);
    if (type === "http") return healthHttp(healthcheck);
    if (type === "log") return healthLog(record, healthcheck);
    return { ok: false, type, detail: "unsupported_healthcheck" };
  }

  return { evaluateHealth };
}

module.exports = { createJobHealthProbes };
