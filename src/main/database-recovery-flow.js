"use strict";

/** UI-independent, single-flight recovery admission. A database restored from an
 * older snapshot is not permission to execute any of its pending operations.
 */
class DatabaseRecoveryFlow {
  constructor({ service, confirm = async () => false, onHealthy = () => {}, onChange = () => {}, allowRestore = true, admitAction = "inspect" }) {
    Object.assign(this, { service, confirm, onHealthy, onChange, allowRestore, admitAction });
    this.closed = false;
    this.admitted = false;
    this.state = { phase: allowRestore ? "checking" : "blocked", reason: "startup_failed", candidates: [], busy: false, allowRestore };
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    if (!this.closed) this.onChange(this.state);
  }

  async act(action, id) {
    if (this.closed || this.admitted) return this.state;
    if (this.state.busy) return { ok: false, reason: "busy" };
    if (!["inspect", "probe", "prepare", "restore"].includes(action)) return { ok: false, reason: "invalid_action" };
    if (!this.allowRestore) return this.state;
    const candidate = this.state.candidates.find(item => item.id === id);
    if (action === "restore" && !candidate) return { ok: false, reason: "invalid_candidate" };
    this.update({ busy: true, phase: action === "restore" ? "restoring" : "checking" });
    try {
      if (action === "restore" && !await this.confirm(candidate)) {
        this.update({ phase: "blocked" });
        return this.state;
      }
      if (this.closed) return this.state;
      const result = await this.service.run(action, id);
      if (this.closed) return this.state;
      // Both actions are admission checks; "probe" is "inspect" minus the page
      // scan, which the caller re-runs in the background once the app is open.
      // The window's own retry button always sends "inspect": a user looking at
      // this page has a reason to want the thorough answer.
      if ((action === "inspect" || action === "probe") && result.ok) {
        this.admitted = true;
        this.update({ phase: "ready", reason: null, receipt: result.restoreReceipt || this.state.receipt });
        this.onHealthy(this.state);
      } else if (action === "restore" && result.ok) {
        this.update({ phase: "restored", reason: null, receipt: result.receipt, candidates: [] });
      } else {
        this.update({ phase: "blocked", reason: action === "prepare" && result.ok ? this.state.reason : result.reason || this.state.reason,
          ...(action === "prepare" ? { candidates: result.candidates || [] } : {}) });
      }
    } catch {
      this.update({ phase: "blocked", reason: "unknown" });
    } finally {
      if (!this.closed) this.update({ busy: false });
    }
    return this.state;
  }

  close() { this.closed = true; }
}

module.exports = { DatabaseRecoveryFlow };
