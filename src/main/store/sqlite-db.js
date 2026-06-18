"use strict";

/**
 * Thin wrapper over Node's built-in `node:sqlite` (DatabaseSync).
 *
 * Why built-in instead of better-sqlite3: Electron 41 bundles Node 24, whose
 * `node:sqlite` ships SQLite with FTS5 + WAL compiled in. Using it means ZERO
 * native modules — no electron-rebuild, no asarUnpack, no cross-compiling a
 * .node binary for the mac/win release pipeline. The driver is isolated here so
 * it can be swapped without touching callers.
 *
 * The API is intentionally close to better-sqlite3 (synchronous prepared
 * statements + a transaction() helper) so the data layer reads conventionally.
 */

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

class Db {
  /**
   * @param {string} filePath  absolute path to the .db file (":memory:" for tests)
   */
  constructor(filePath) {
    this.filePath = filePath;
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.raw = new DatabaseSync(filePath);
    this._stmts = new Map();
    this._applyPragmas();
  }

  _applyPragmas() {
    // WAL: concurrent readers during a write + crash-safe (a torn write never
    // corrupts the main db). NORMAL fsync is the WAL-recommended durability/perf
    // balance for desktop apps. busy_timeout avoids spurious SQLITE_BUSY.
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA synchronous = NORMAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
    this.raw.exec("PRAGMA temp_store = MEMORY;");
  }

  /** Prepared-statement cache keyed by SQL text. */
  _prepare(sql) {
    let stmt = this._stmts.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this._stmts.set(sql, stmt);
    }
    return stmt;
  }

  run(sql, ...params) {
    return this._prepare(sql).run(...params);
  }

  get(sql, ...params) {
    return this._prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this._prepare(sql).all(...params);
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  pragma(name) {
    const row = this.raw.prepare(`PRAGMA ${name}`).get();
    return row ? Object.values(row)[0] : undefined;
  }

  /**
   * Wrap `fn` so it runs inside a single transaction. Re-entrant safe via
   * SAVEPOINT so nested transaction() calls compose. Returns fn's result.
   */
  transaction(fn) {
    return (...args) => {
      const savepoint = `sp_${this._stmts.size}_${args.length}`;
      const nested = this._txDepth > 0;
      if (nested) this.raw.exec(`SAVEPOINT ${savepoint}`);
      else this.raw.exec("BEGIN");
      this._txDepth = (this._txDepth || 0) + 1;
      try {
        const result = fn(...args);
        this._txDepth -= 1;
        if (nested) this.raw.exec(`RELEASE ${savepoint}`);
        else this.raw.exec("COMMIT");
        return result;
      } catch (err) {
        this._txDepth -= 1;
        if (nested) this.raw.exec(`ROLLBACK TO ${savepoint}`);
        else this.raw.exec("ROLLBACK");
        throw err;
      }
    };
  }

  /**
   * Apply ordered migrations. Each migration is `(db) => void`; index in the
   * array IS the target user_version. Already-applied migrations are skipped.
   * Each runs in its own transaction so a failure leaves a consistent version.
   */
  migrate(migrations) {
    let version = Number(this.pragma("user_version")) || 0;
    for (let i = version; i < migrations.length; i += 1) {
      const apply = this.transaction(() => {
        migrations[i](this);
        // user_version can't be parameterized; i+1 is a trusted integer.
        this.raw.exec(`PRAGMA user_version = ${i + 1}`);
      });
      apply();
      version = i + 1;
    }
    return version;
  }

  /** WAL checkpoint — fold the WAL back into the main db file. */
  checkpoint() {
    try {
      this.raw.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      /* best effort */
    }
  }

  close() {
    this.checkpoint();
    this._stmts.clear();
    try {
      this.raw.close();
    } catch {
      /* already closed */
    }
  }
}

function openDatabase(filePath) {
  return new Db(filePath);
}

module.exports = { Db, openDatabase };
