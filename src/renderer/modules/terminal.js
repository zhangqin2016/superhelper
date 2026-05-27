/**
 * Native terminal panel (right panel) — @xterm/xterm integration.
 */

import store from "./state.js";
import { $ } from "./dom.js";

let term = null;
let fitAddon = null;
let terminalReady = false;

export async function initTerminal() {
  const toggleBtn = $("toggleTerminalBtn");
  const container = $("terminalContainer");

  if (!toggleBtn || !container) return;

  toggleBtn.addEventListener("click", () => {
    if (container.hidden) {
      container.hidden = false;
      toggleBtn.textContent = "收起";
      if (!terminalReady) createTerminal(container);
    } else {
      container.hidden = true;
      toggleBtn.textContent = "展开";
    }
  });
}

async function createTerminal(container) {
  try {
    const { Terminal } = await import("../../node_modules/@xterm/xterm/lib/xterm.js");
    const { FitAddon } = await import("../../node_modules/@xterm/addon-fit/lib/addon-fit.js");

    term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      theme: {
        background: "#0d1117",
        foreground: "#d7e1ea",
        cursor: "#6c63ff",
        selectionBackground: "#2a2d50",
        black: "#1a1d30",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e6f0",
        brightBlack: "#5c6080",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde68a",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      },
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    const project = store.get("projects")?.find((p) => p.id === store.get("activeProjectId"));
    const cwd = project ? project.path : undefined;

    await window.assistantClient.terminalCreate({
      terminalId: "main",
      cwd,
      cols: term.cols,
      rows: term.rows,
    });

    term.onData((data) => {
      window.assistantClient.terminalWrite("main", data);
    });

    window.assistantClient.onTerminalData((payload) => {
      if (payload.terminalId === "main" && term) {
        term.write(payload.data);
      }
    });

    term.onResize(({ cols, rows }) => {
      window.assistantClient.terminalResize("main", cols, rows);
    });

    window.addEventListener("resize", () => {
      try { fitAddon?.fit(); } catch {}
    });

    terminalReady = true;
  } catch (err) {
    container.textContent = `终端初始化失败：${err.message}`;
  }
}
