"use strict";

const { openCollaborationStore } = require("./collaboration-store");
const { createCollaborationSyncEngine } = require("./sync-engine");
const { createCollaborationOutbox } = require("./outbox");
const { createCollaborationRealtimeClient } = require("./realtime-client");

/** Build collaboration outside the Electron startup critical path. */
function createCollaborationService({ openStore = openCollaborationStore, storeOptions, client, transport, realtimeOptions = {} } = {}) {
  const opened = openStore(storeOptions);
  if (!opened?.ok) return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
  try {
    const store = opened.store;
    const syncEngine = createCollaborationSyncEngine({ store });
    const outbox = transport ? createCollaborationOutbox({ store, transport }) : null;
    const realtime = client
      ? createCollaborationRealtimeClient({
        ...realtimeOptions,
        onReconnect: () => outbox?.drainQueued?.(),
        sync: () => {
          const current = store.getSyncState();
          return client.syncAndAcknowledge({ ...realtimeOptions.syncArgs, afterCursor: current.cursor, syncEngine });
        },
      })
      : null;
    return {
      ok: true, store, syncEngine, outbox, realtime,
      start() { void outbox?.drainQueued?.(); realtime?.start(); },
      stop() { realtime?.stop(); outbox?.stop?.(); store.close?.(); },
    };
  } catch {
    try { opened.store?.close?.(); } catch { /* isolation boundary */ }
    return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
  }
}

module.exports = { createCollaborationService };
