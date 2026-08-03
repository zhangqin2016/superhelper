"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { checkpointHash } = require("./runtime-checkpoint");

function codedError(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function resolveOwnedPath(workspacePath, relativePath) {
  const root = path.resolve(String(workspacePath || ""));
  const target = path.resolve(root, String(relativePath || ""));
  if (!root || (target !== root && !target.startsWith(`${root}${path.sep}`))) {
    throw codedError("RUNTIME_CHECKPOINT_PATH_OUTSIDE_WORKSPACE");
  }
  return target;
}

function relativeOwnedPath(workspacePath, filePath) {
  const root = path.resolve(String(workspacePath || ""));
  const target = path.resolve(String(filePath || ""));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw codedError("RUNTIME_CHECKPOINT_PATH_OUTSIDE_WORKSPACE");
  }
  return relative.split(path.sep).join("/");
}

function captureFileComponents(workspacePath, filePaths = []) {
  const unique = [...new Set(filePaths.map((value) => relativeOwnedPath(workspacePath, value)))].sort();
  return unique.map((relativePath) => {
    const target = resolveOwnedPath(workspacePath, relativePath);
    const exists = fs.existsSync(target);
    const payload = {
      workspaceRelativePath: relativePath,
      exists,
      contentBase64: exists ? fs.readFileSync(target).toString("base64") : "",
    };
    return {
      type: "tracked_file",
      refId: relativePath,
      version: 1,
      hash: checkpointHash(payload),
      reversible: true,
      payload,
    };
  });
}

function restoreFileComponents(workspacePath, components = []) {
  const results = [];
  for (const component of components) {
    const payload = component.payload;
    if (!component.payloadAvailable || !payload || checkpointHash(payload) !== component.hash) {
      throw codedError("RUNTIME_CHECKPOINT_COMPONENT_HASH_MISMATCH", component.refId);
    }
    const target = resolveOwnedPath(workspacePath, payload.workspaceRelativePath);
    if (!payload.exists) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      results.push({ refId: component.refId, action: "removed" });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.lily-checkpoint-${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, Buffer.from(String(payload.contentBase64 || ""), "base64"));
      fs.renameSync(temporary, target);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    results.push({ refId: component.refId, action: "restored" });
  }
  return results;
}

class RuntimeCheckpointService {
  constructor(options = {}) {
    if (!options.store) throw codedError("RUNTIME_CHECKPOINT_STORE_REQUIRED");
    this.store = options.store;
    this.hooks = options.hooks || null;
    this.emit = options.emit || (() => {});
    this.revertEngine = options.revertEngine || null;
    this.unrevertEngine = options.unrevertEngine || null;
    this.rewindSession = options.rewindSession || null;
    this.createForkSession = options.createForkSession || null;
    this.captureComponent = options.captureComponent || null;
    this.restoreComponent = options.restoreComponent || null;
    this.now = options.now || (() => Date.now());
  }

  async _hook(event, payload) {
    if (!this.hooks || process.env.LILY_PUBLIC_HOOKS_V1 === "0") return;
    const decision = await this.hooks.run(event, payload);
    if (decision.allow === false) throw codedError("RUNTIME_CHECKPOINT_HOOK_DENIED", decision.reason);
  }

  async create(input = {}) {
    await this._hook("checkpoint.before", { sessionId: input.sessionId, turnId: input.turnId, kind: input.kind || "turn" });
    const components = [
      ...captureFileComponents(input.workspacePath, input.filePaths || []),
      ...(Array.isArray(input.extraComponents) ? input.extraComponents : []),
    ];
    const prepared = this.store.prepare({ ...input, components, createdAt: input.createdAt ?? this.now() });
    const checkpoint = this.store.commit(prepared.id, input.sessionId, prepared.integrityHash);
    this.emit("checkpoint.committed", { sessionId: input.sessionId, turnId: input.turnId, checkpointId: checkpoint.id, kind: checkpoint.kind });
    await this._hook("checkpoint.after", { sessionId: input.sessionId, turnId: input.turnId, checkpointId: checkpoint.id });
    return checkpoint;
  }

  async restore(input = {}) {
    const target = this.store.get(input.checkpointId, input.sessionId);
    const targetData = this.store.componentData(target.id, input.sessionId);
    for (const component of targetData.filter((item) => item.reversible)) {
      if (!component.payloadAvailable || (component.type !== "tracked_file" && !this.restoreComponent)) {
        throw codedError("RUNTIME_CHECKPOINT_ADAPTER_UNAVAILABLE", component.type);
      }
      resolveOwnedPath(input.workspacePath, component.payload.workspaceRelativePath);
    }
    await this._hook("checkpoint.restore", { sessionId: input.sessionId, checkpointId: target.id, phase: "before" });
    const safetyExtras = [];
    for (const component of targetData.filter((item) => item.type !== "tracked_file" && item.reversible)) {
      if (!this.captureComponent) throw codedError("RUNTIME_CHECKPOINT_ADAPTER_UNAVAILABLE", component.type);
      safetyExtras.push(await this.captureComponent(component, input));
    }
    const safety = await this.create({
      ...input,
      id: input.safetyCheckpointId,
      turnId: input.currentTurnId || target.turnId,
      kind: "pre_restore_safety",
      parentCheckpointId: target.id,
      filePaths: targetData.filter((item) => item.type === "tracked_file").map((item) => resolveOwnedPath(input.workspacePath, item.refId)),
      extraComponents: safetyExtras,
    });
    const started = this.store.beginRestore(target.id, input.sessionId, { safetyCheckpointId: safety.id, createdAt: this.now() });
    this.emit("checkpoint.restore.started", { sessionId: input.sessionId, checkpointId: target.id, restoreId: started.restore.id });
    let engineReverted = false;
    try {
      if (target.engineMessageId && this.revertEngine) {
        engineReverted = await this.revertEngine(input.sessionId, target.engineMessageId);
        if (!engineReverted) throw codedError("RUNTIME_CHECKPOINT_ENGINE_RESTORE_FAILED");
      }
      const files = restoreFileComponents(input.workspacePath, targetData.filter((item) => item.type === "tracked_file"));
      for (const component of targetData.filter((item) => item.type !== "tracked_file" && item.reversible)) {
        await this.restoreComponent(component, input);
      }
      if (this.rewindSession) await this.rewindSession(input.sessionId, target.turnId);
      const result = this.store.completeRestore(started.restore.id, input.sessionId, {
        unresolvedEffects: started.plan.unresolvedEffects,
        completedAt: this.now(),
      });
      this.emit("checkpoint.restore.completed", { sessionId: input.sessionId, checkpointId: target.id, restoreId: result.id, files, unresolvedEffects: result.unresolvedEffects });
      return { ...result, files, safetyCheckpointId: safety.id };
    } catch (err) {
      try {
        restoreFileComponents(input.workspacePath, this.store.componentData(safety.id, input.sessionId).filter((item) => item.type === "tracked_file"));
        if (this.restoreComponent) {
          for (const component of this.store.componentData(safety.id, input.sessionId).filter((item) => item.type !== "tracked_file" && item.reversible)) {
            await this.restoreComponent(component, input);
          }
        }
        if (engineReverted && this.unrevertEngine) await this.unrevertEngine(input.sessionId);
      } catch { /* preserve the original restore failure */ }
      this.store.failRestore(started.restore.id, input.sessionId, err?.message || err, this.now());
      this.emit("checkpoint.restore.failed", { sessionId: input.sessionId, checkpointId: target.id, restoreId: started.restore.id, error: String(err?.message || err) });
      throw err;
    }
  }

  async fork(input = {}) {
    if (!this.createForkSession) throw codedError("RUNTIME_CHECKPOINT_FORK_ADAPTER_UNAVAILABLE");
    const source = this.store.get(input.checkpointId, input.sessionId);
    const session = await this.createForkSession({ sourceSessionId: input.sessionId, checkpoint: source, title: input.title });
    const checkpoint = this.store.fork(source.id, input.sessionId, {
      sessionId: session.id,
      turnId: source.turnId,
      taskRunId: input.taskRunId || source.taskRunId,
      createdAt: this.now(),
    });
    this.emit("checkpoint.forked", { sessionId: input.sessionId, checkpointId: source.id, forkSessionId: session.id, forkCheckpointId: checkpoint.id });
    return { session, checkpoint };
  }
}

module.exports = {
  RuntimeCheckpointService,
  captureFileComponents,
  relativeOwnedPath,
  resolveOwnedPath,
  restoreFileComponents,
};
