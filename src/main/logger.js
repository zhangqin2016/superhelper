"use strict";

class Logger {
  constructor(namespace) {
    this.namespace = namespace;
  }

  _log(level, message, ...args) {
    const timestamp = new Date().toISOString().split("T")[1].slice(0, 12);
    const prefix = `[${timestamp} ${level.toUpperCase()} ${this.namespace}]`;
    if (level === "error") {
      console.error(prefix, message, ...args);
    } else if (level === "warn") {
      console.warn(prefix, message, ...args);
    } else {
      console.log(prefix, message, ...args);
    }
  }

  debug(msg, ...args) { this._log("debug", msg, ...args); }
  info(msg, ...args) { this._log("info", msg, ...args); }
  warn(msg, ...args) { this._log("warn", msg, ...args); }
  error(msg, ...args) { this._log("error", msg, ...args); }
}

const loggers = new Map();

function getLogger(namespace) {
  if (!loggers.has(namespace)) {
    loggers.set(namespace, new Logger(namespace));
  }
  return loggers.get(namespace);
}

module.exports = { Logger, getLogger };
