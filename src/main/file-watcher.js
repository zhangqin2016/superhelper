"use strict";

/**
 * Watches a project directory for file changes and emits events.
 * Uses fs.watch with recursive option (macOS native).
 */

const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const IGNORED = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".cache"]);

class FileWatcher extends EventEmitter {
  constructor() {
    super();
    this.watchers = new Map();
  }

  /**
   * Start watching a project directory.
   * @param {string} projectId
   * @param {string} dirPath
   */
  watch(projectId, dirPath) {
    this.unwatch(projectId);
    try {
      const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const segments = filename.split(path.sep);
        if (segments.some((s) => IGNORED.has(s))) return;
        this.emit("change", { projectId, eventType, filename });
      });
      this.watchers.set(projectId, watcher);
    } catch {
      // directory may not exist or be inaccessible
    }
  }

  unwatch(projectId) {
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(projectId);
    }
  }

  unwatchAll() {
    for (const [id] of this.watchers) {
      this.unwatch(id);
    }
  }
}

module.exports = FileWatcher;
