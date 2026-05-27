"use strict";

/**
 * Manages PTY terminal sessions via node-pty.
 */

const os = require("node:os");
const { EventEmitter } = require("node:events");

class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.terminals = new Map();
  }

  /**
   * Create a new PTY terminal.
   * @param {string} terminalId
   * @param {{cwd?: string, cols?: number, rows?: number}} opts
   */
  create(terminalId, { cwd, cols = 80, rows = 24 } = {}) {
    if (this.terminals.has(terminalId)) {
      this.destroy(terminalId);
    }

    let pty;
    try {
      const ptyModule = require("node-pty");
      const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/zsh");
      pty = ptyModule.spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: cwd || os.homedir(),
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch (err) {
      // node-pty not available
      this.emit("error", { terminalId, message: `终端初始化失败：${err.message}` });
      return;
    }

    this.terminals.set(terminalId, pty);

    pty.onData((data) => {
      this.emit("data", { terminalId, data });
    });

    pty.onExit(({ exitCode }) => {
      this.terminals.delete(terminalId);
      this.emit("exit", { terminalId, exitCode });
    });
  }

  write(terminalId, data) {
    const pty = this.terminals.get(terminalId);
    if (pty) pty.write(data);
  }

  resize(terminalId, cols, rows) {
    const pty = this.terminals.get(terminalId);
    if (pty) pty.resize(cols, rows);
  }

  destroy(terminalId) {
    const pty = this.terminals.get(terminalId);
    if (pty) {
      pty.kill();
      this.terminals.delete(terminalId);
    }
  }

  destroyAll() {
    for (const [id] of this.terminals) {
      this.destroy(id);
    }
  }
}

module.exports = TerminalManager;
