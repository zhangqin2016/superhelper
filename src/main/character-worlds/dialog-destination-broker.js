"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DESTINATION_BROKER_PROTOCOL,
} = require("./destination-broker-protocol");
const { importError } = require("./file-authority-shared");
const {
  createReferenceDestinationBroker,
} = require("./reference-destination-broker");

// Directory-bound brokers are cached so repeat exports to the same folder
// reuse one helper, but unbounded growth would leak one helper process per
// destination directory the user ever picks. Cap the cache and evict the
// least-recently-used idle broker (closing its helper process) beyond it.
const MAX_PARENT_BROKERS = 8;

// Production save-dialog destination broker. Electron main hands it the full
// path the user approved in dialog.showSaveDialog — that path is created in
// the main process and never crosses the bridge as renderer input. Each
// approved parent directory gets one directory-bound ReferenceDestinationBroker
// (a helper process with cwd pinned to that directory); reservations stay
// opaque capabilities, so no portable validate-then-open TOCTOU window exists.
class DialogDestinationBroker {
  constructor({
    createBroker = createReferenceDestinationBroker,
    maxParentBrokers = MAX_PARENT_BROKERS,
  } = {}) {
    if (typeof createBroker !== "function") {
      throw new TypeError("createBroker must be a function");
    }
    this.protocol = DESTINATION_BROKER_PROTOCOL;
    this.createBroker = createBroker;
    this.maxParentBrokers = Math.max(1, Math.min(
      Math.floor(Number(maxParentBrokers) || MAX_PARENT_BROKERS),
      64,
    ));
    this.parentBrokers = new Map();
    this.lastUse = 0;
    this.closed = false;
  }

  _touch(entry) {
    this.lastUse += 1;
    entry.lastUse = this.lastUse;
  }

  _activeReservations(broker) {
    try {
      return Number(broker?.stats?.().reservations) || 0;
    } catch {
      return 0;
    }
  }

  _evictForNewEntry() {
    while (this.parentBrokers.size >= this.maxParentBrokers) {
      let oldest = null;
      for (const [parent, entry] of this.parentBrokers) {
        if (this._activeReservations(entry.broker) > 0) continue;
        if (!oldest || entry.lastUse < oldest.entry.lastUse) {
          oldest = { parent, entry };
        }
      }
      // Every cached broker has live reservations: keep them all rather than
      // killing an in-flight export's helper. The cache may exceed the cap
      // transiently and shrinks again on later evictions.
      if (!oldest) return;
      this.parentBrokers.delete(oldest.parent);
      Promise.resolve()
        .then(() => oldest.entry.broker.close())
        .catch(() => {});
    }
  }

  async _brokerFor(parent) {
    let entry = this.parentBrokers.get(parent);
    if (!entry) {
      this._evictForNewEntry();
      entry = { broker: this.createBroker({ approvedParent: parent }), lastUse: 0 };
      this.parentBrokers.set(parent, entry);
    }
    this._touch(entry);
    await entry.broker.ready();
    return entry.broker;
  }

  async reserve(approvedPath, options = {}) {
    if (this.closed) {
      throw importError("EXPORT_DESTINATION_CLOSED", "Destination broker is closed");
    }
    if (typeof approvedPath !== "string" || !path.isAbsolute(approvedPath)) {
      throw importError(
        "EXPORT_DESTINATION_UNAUTHORIZED",
        "Export destination is not authorized",
      );
    }
    let parent;
    try {
      parent = fs.realpathSync(path.dirname(approvedPath));
    } catch {
      throw importError(
        "EXPORT_DESTINATION_UNAUTHORIZED",
        "Export destination is not authorized",
      );
    }
    const broker = await this._brokerFor(parent);
    const reservation = await broker.reserve({ fileName: path.basename(approvedPath) }, options);
    const entry = this.parentBrokers.get(parent);
    if (entry) this._touch(entry);
    return reservation;
  }

  stats() {
    return {
      parents: this.parentBrokers.size,
      closed: this.closed,
    };
  }

  async close(options = {}) {
    if (this.closed) return;
    this.closed = true;
    const failures = [];
    await Promise.all([...this.parentBrokers.values()].map(async (entry) => {
      try {
        await entry.broker.close(options);
      } catch (error) {
        failures.push(error?.code || "EXPORT_CLOSE_FAILED");
      }
    }));
    this.parentBrokers.clear();
    if (failures.length) {
      throw importError("EXPORT_CLOSE_FAILED", "Destination broker cleanup failed");
    }
  }
}

module.exports = { DialogDestinationBroker };
