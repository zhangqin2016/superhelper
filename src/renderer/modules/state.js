/**
 * Reactive state store — single source of truth for the renderer.
 */

const store = {
  _state: {
    activeProjectId: null,
    projects: [],
    activeSessionId: null,
    sessions: [],
    conversation: [],
    isBusy: false,
    runningSessionId: null,
    runningSessionIds: [],
    activeBubble: null,
    activeMarkdown: "",
    pendingFiles: [],
    pendingQueueCount: 0,
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
