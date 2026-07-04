"use strict";

const util = require("node:util");

class Logger {
  constructor(namespace) {
    this.namespace = namespace;
  }

  _log(level, message, ...args) {
    const timestamp = new Date().toISOString().split("T")[1].slice(0, 12);
    const prefix = `[${timestamp} ${level.toUpperCase()} ${this.namespace}]`;
    const text = args.length ? util.format(message, ...args) : message;
    if (level === "error") {
      console.error(prefix, text);
    } else if (level === "warn") {
      console.warn(prefix, text);
    } else {
      console.log(prefix, text);
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
