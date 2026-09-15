"use strict";

// Message metadata can carry a terminal API error even without session.error.
function reduceMessageUpdate(ev, state, { emptyResult, withProcessEvent, runtimeDraft, errorMessage }) {
  const p = ev.properties || {};
  const info = p.info || {};
  if (info.role === "assistant" && info.summary !== true && !["compaction", "title"].includes(info.agent)
    && require("../upstream-model-auth").UPSTREAM_AUTH_RE.test(errorMessage(info.error) || "")) {
    return withProcessEvent(ev, {
      drafts: [], effects: [{ kind: "error", message: errorMessage(info.error), cause: info.error }],
      progress: false, terminal: true,
    });
  }
  if (info.id && info.role && state.roles) state.roles.set(info.id, info.role);
  if (info.id && (info.summary === true || info.agent === "compaction")) {
    state.summaryMessages?.add(info.id);
    // Track the compaction WINDOW: it generates inside the turn's own liveness
    // window but produces no turn output, so the first-response watchdog must be
    // able to tell "engine busy summarizing" from "model returned nothing"
    // (2026-09-15 field case: it killed turn and compaction together at 90s).
    if (info.time?.completed || info.error) state.activeCompactions?.delete(info.id);
    else if (!state.activeCompactions?.has(info.id)) state.activeCompactions?.set(info.id, Date.now());
    return emptyResult(ev);
  }
  if (info.id && info.role && state.pendingTextSnapshots?.size && !state.summaryMessages?.has(info.id)) {
    const drafts = [];
    const effects = [];
    for (const [partID, snapshot] of state.pendingTextSnapshots.entries()) {
      if (snapshot.messageID !== info.id) continue;
      state.pendingTextSnapshots.delete(partID);
      if (info.role === "user") {
        state.textParts?.set(partID, snapshot.text || "");
        continue;
      }
      if (info.role !== "assistant") continue;
      const text = snapshot.text || "";
      const previous = state.textParts?.get(partID) || "";
      let missing = "";
      if (text && text.startsWith(previous)) missing = text.slice(previous.length);
      else if (text && !previous) missing = text;
      if (!missing) continue;
      state.textParts?.set(partID, text);
      drafts.push(runtimeDraft("assistant.delta", { text: missing }));
      effects.push({ kind: "assistant_text", text: missing });
    }
    if (drafts.length) {
      return withProcessEvent(ev, {
        drafts,
        effects,
        progress: true,
        terminal: false,
      });
    }
  }
  return emptyResult(ev);
}

module.exports = { reduceMessageUpdate };
