/**
 * Terminal View — xterm.js-based PTY terminal that replaces the
 * message panel. User sees the full Claude CLI TUI natively.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const terminals = new Map();

/**
 * Create and mount a terminal for a session.
 * @param {string} sessionId
 * @param {HTMLElement} container — the DOM element to mount into
 * @param {{ cwd?: string, cols?: number, rows?: number }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function createTerminal(sessionId, container, opts = {}) {
  if (terminals.has(sessionId)) {
    destroyTerminal(sessionId);
  }

  // Create the PTY session on main process (CLI path resolved internally)
  const result = await window.assistantClient.ptyCreate({
    sessionId,
    cwd: opts.cwd || "",
    permissionMode: "default",
    additionalDirs: [],
  });

  if (!result?.ok) {
    return { ok: false, error: result?.error || "PTY creation failed" };
  }

  const fit = new FitAddon();
  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontSize: 14,
    fontFamily: '"JetBrains Mono", "SF Mono", "Fira Code", Menlo, monospace',
    theme: {
      background: "#0d1117",
      foreground: "#e6edf3",
      cursor: "#6c63ff",
      selectionBackground: "rgba(108, 99, 255, 0.35)",
      black: "#161b22",
      red: "#f85149",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ff6e67",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
    allowProposedApi: true,
    allowTransparency: false,
    cols: opts.cols || 120,
    rows: opts.rows || 40,
  });

  term.loadAddon(fit);
  term.open(container);

  // Fit to container after mount
  setTimeout(() => {
    try {
      fit.fit();
      const dims = term._core._renderService.dimensions;
      if (dims) {
        window.assistantClient.ptyResize(sessionId, dims.cols, dims.rows);
      }
    } catch {
      // fit may fail if container has zero size
    }
  }, 100);

  // Forward keyboard input to PTY
  term.onData((data) => {
    window.assistantClient.ptyInput(sessionId, data);
  });

  // Resize observer
  const resizeObserver = new ResizeObserver(() => {
    try {
      fit.fit();
      const dims = term._core._renderService.dimensions;
      if (dims) {
        window.assistantClient.ptyResize(sessionId, dims.cols, dims.rows);
      }
    } catch {
      // ignore
    }
  });
  resizeObserver.observe(container);

  // Listen for PTY data
  const onData = (payload) => {
    if (payload.sessionId === sessionId) {
      term.write(payload.data);
    }
  };
  window.assistantClient.onPtyData(onData);

  // Listen for PTY exit
  const onExit = (payload) => {
    if (payload.sessionId === sessionId) {
      term.write(`\r\n\n[Process exited with code ${payload.exitCode}]\r\n`);
    }
  };
  window.assistantClient.onPtyExit(onExit);

  const onError = (payload) => {
    if (payload.sessionId === sessionId) {
      term.write(`\r\n\n[Error: ${payload.message}]\r\n`);
    }
  };
  window.assistantClient.onPtyError(onError);

  terminals.set(sessionId, {
    term,
    fit,
    container,
    resizeObserver,
    onData,
    onExit,
    onError,
  });

  container.classList.add("terminal-container");
  return { ok: true };
}

/**
 * Write user message to the PTY (e.g., from composer).
 */
export function writeToTerminal(sessionId, text) {
  window.assistantClient.ptyInput(sessionId, `${text}\n`);
}

/**
 * Destroy a terminal instance.
 */
export function destroyTerminal(sessionId) {
  const entry = terminals.get(sessionId);
  if (!entry) return;
  entry.resizeObserver?.disconnect();
  entry.term?.dispose();
  terminals.delete(sessionId);
  window.assistantClient.ptyDestroy(sessionId);
}

/**
 * Resize the terminal to fit its container.
 */
export function fitTerminal(sessionId) {
  const entry = terminals.get(sessionId);
  if (!entry) return;
  try {
    entry.fit.fit();
    const dims = entry.term._core._renderService.dimensions;
    if (dims) {
      window.assistantClient.ptyResize(sessionId, dims.cols, dims.rows);
    }
  } catch {
    // ignore
  }
}

export { terminals };
