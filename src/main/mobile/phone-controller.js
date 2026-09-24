"use strict";

/**
 * One paired phone: what it is driving, and what its frames do.
 *
 * Each phone has its own target (workspace + session) — two phones never share
 * a selection, and "stop" stops the turn in the session THIS phone is looking
 * at. The phone's task enters Lily only through the orchestrator's admission
 * seam (via the desktop port); admission decides dedupe, ownership and mode.
 *
 * Depends on the desktop port, a snapshot builder and `send` — never on ctx,
 * sockets or the relay.
 */

const crypto = require("node:crypto");
const { FROM_PHONE, LIMITS, PHONE_PROTOCOL, toPhone } = require("./protocol");

function payloadHashFor(text, attachments) {
  const canonical = JSON.stringify({ text: String(text || ""), attachments: attachments || [] });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * @param {object} opts
 * @param {string} opts.grantId
 * @param {() => string} opts.getDesktopDeviceId
 * @param {object} opts.port        desktop port (see desktop-port.js)
 * @param {(sessionId: string) => Promise<object|null>} opts.snapshot  session.context frame
 * @param {(frame: object) => void} opts.send
 */
function createPhoneController({ grantId, getDesktopDeviceId, port, snapshot, send, log = { info() {}, warn() {} } }) {
  const target = { projectId: "", sessionId: "" };

  // The phone's workspace pick while it still exists, else the desktop's active one.
  function projectId() {
    if (target.projectId && port.findProject(target.projectId)) return target.projectId;
    target.projectId = "";
    return port.activeProjectId();
  }

  function sessionId() {
    const project = projectId();
    const picked = target.sessionId ? port.findSession(target.sessionId) : null;
    if (picked && (!project || picked.projectId === project)) return picked.id;
    target.sessionId = "";
    // Driving the desktop's active workspace: follow its active session.
    if (project === port.activeProjectId()) return port.activeSessionId();
    return port.listSessions(project)[0]?.id || "";
  }

  function sessionsList() {
    const project = projectId();
    return toPhone.sessionsList({
      projectId: project,
      activeSessionId: port.activeSessionId(),
      selectedSessionId: sessionId(),
      sessions: port.listSessions(project),
    });
  }

  function projectsList() {
    return toPhone.projectsList({
      activeProjectId: port.activeProjectId(),
      selectedProjectId: projectId(),
      projects: port.listProjects(),
    });
  }

  async function sendSnapshot() {
    const frame = await snapshot(sessionId());
    if (frame) send(frame);
  }

  async function onCommand(frame) {
    const commandId = String(frame.commandId || "");
    const correlationId = String(frame.correlationId || commandId || "");
    const reject = (code, detail) => send(toPhone.commandRejected({ commandId, correlationId, code, detail }));
    if (Number(frame.protocolVersion || PHONE_PROTOCOL) !== PHONE_PROTOCOL) return reject("CLIENT_UPGRADE_REQUIRED");
    const text = String(frame.text || "");
    const attachments = Array.isArray(frame.attachments) ? frame.attachments : [];
    if (text.length > LIMITS.COMMAND_TEXT) return reject("COMMAND_TEXT_TOO_LARGE");
    if (attachments.length > LIMITS.ATTACHMENTS) return reject("ATTACHMENT_COUNT_EXCEEDED");
    if (!commandId || (!text && !attachments.length)) return reject("COMMAND_INVALID");

    // The phone may name a session; honour it only inside the workspace this
    // phone drives, and remember it as the phone's pick.
    const requested = frame.lilySessionId ? port.findSession(String(frame.lilySessionId)) : null;
    const project = projectId();
    if (requested && (!project || requested.projectId === project)) target.sessionId = requested.id;
    const lilySessionId = sessionId();
    if (!lilySessionId) return reject("NO_TARGET_SESSION");

    // Fail-open: an attachment that cannot be written leaves a text-only task.
    let files = [];
    if (attachments.length) {
      try { files = (await port.materializeAttachments(attachments)) || []; } catch { files = []; }
    }
    const attachmentStatus = !attachments.length ? "none"
      : !files.length ? "dropped"
        : files.length >= attachments.length ? "attached" : "partial";

    let result;
    try {
      result = await port.admit({
        commandId,
        idempotencyKey: String(frame.idempotencyKey || commandId),
        correlationId,
        payloadHash: payloadHashFor(text, attachments),
        lilySessionId,
        desktopDeviceId: getDesktopDeviceId(),
        mobileDeviceId: String(frame.mobileDeviceId || ""),
        remoteSessionId: String(frame.remoteSessionId || ""),
        text,
        attachments,
        files,
        attachmentStatus,
        attachmentCount: attachments.length,
        materializedFileCount: files.length,
        mode: frame.mode === "steer" ? "steer" : "queue",
        sourceSequence: Number.isFinite(frame.sourceSequence) ? frame.sourceSequence : null,
      });
    } catch (err) {
      return reject("COMMAND_ADMISSION_ERROR", err?.message || err);
    }
    if (!result?.ok) return reject(result?.code || "COMMAND_REJECTED");
    log.info("mobile command admitted: grant=%s command=%s mode=%s", grantId, result.commandId, result.effectiveMode);
    return send(toPhone.commandAdmitted({
      commandId: result.commandId,
      correlationId: result.correlationId || correlationId,
      sessionId: lilySessionId,
      attachmentStatus,
      attachmentCount: attachments.length,
      materializedFileCount: files.length,
      state: result.state,
      requestedMode: result.requestedMode,
      effectiveMode: result.effectiveMode,
      downgradeReason: result.downgradeReason ?? null,
    }));
  }

  async function onInterrupt(frame) {
    const correlationId = String(frame.correlationId || "");
    const driving = sessionId();
    if (!driving) return send(toPhone.interruptAck({ ok: false, correlationId, code: "NO_TARGET_SESSION" }));
    try {
      const result = await port.interrupt(driving);
      return send(toPhone.interruptAck({ ok: result?.ok ?? true, correlationId, turnId: frame.turnId }));
    } catch (err) {
      log.warn("mobile interrupt failed: %s", err?.message || err);
      return send(toPhone.interruptAck({ ok: false, correlationId, code: "INTERRUPT_ERROR" }));
    }
  }

  const routes = {
    [FROM_PHONE.COMMAND]: onCommand,
    [FROM_PHONE.INTERRUPT]: onInterrupt,
    [FROM_PHONE.SESSION_REQUEST]: () => sendSnapshot(),
    [FROM_PHONE.SESSIONS_REQUEST]: () => send(sessionsList()),
    [FROM_PHONE.PROJECTS_REQUEST]: () => send(projectsList()),
    [FROM_PHONE.SESSION_SELECT]: async (frame) => {
      const id = String(frame.sessionId || "");
      const picked = port.findSession(id);
      const project = projectId();
      if (!picked || (project && picked.projectId !== project)) return send(toPhone.selectAck("session", { id, code: "SESSION_NOT_FOUND" }));
      target.sessionId = picked.id;
      return sendSnapshot();
    },
    [FROM_PHONE.PROJECT_SELECT]: async (frame) => {
      const id = String(frame.projectId || "");
      if (!port.findProject(id)) return send(toPhone.selectAck("project", { id, code: "PROJECT_NOT_FOUND" }));
      target.projectId = id;
      target.sessionId = ""; // a new workspace starts from its own default session
      send(sessionsList());
      return sendSnapshot();
    },
  };

  return {
    grantId,
    /** The session this phone is driving right now. */
    targetSessionId: sessionId,
    /** Handle one frame from this phone. Never throws. */
    async handle(frame) {
      const route = routes[frame?.type];
      if (!route) return;
      try {
        await route(frame);
      } catch (err) {
        log.warn("mobile frame %s failed: %s", frame.type, err?.message || err);
      }
    },
  };
}

module.exports = { createPhoneController, payloadHashFor };
