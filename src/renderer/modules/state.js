/**
 * Reactive state store — single source of truth for the renderer.
 */

import { $, el, scrollToBottom } from "./dom.js";

const store = {
  _state: {
    // Projects
    activeProjectId: null,
    projects: [],

    // Sessions
    activeSessionId: null,
    sessions: [],
    conversation: [],

    // File tree
    fileTree: [],

    // Chat
    isBusy: false,
    activeBubble: null,
    activeMarkdown: "",

    // Diff
    diffs: [],
    diffSummary: { added: 0, deleted: 0, files: 0 },

    // Tasks
    tasks: [],

    // Templates
    templates: [],

    // Plugins
    plugins: [],

    // Pending files for composer
    pendingFiles: [],

    // Working directory display
    workingDir: "",

    // Mode
    mode: "fast",
  },
  _listeners: {},

  get(key) { return this._state[key]; },

  set(key, value) {
    this._state[key] = value;
    this._notify(key, value);
  },

  on(key, fn) {
    (this._listeners[key] = this._listeners[key] || []).push(fn);
  },

  _notify(key, value) {
    for (const fn of this._listeners[key] || []) fn(value);
  },
};

export default store;
