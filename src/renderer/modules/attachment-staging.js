/**
 * Attachment staging tracker.
 *
 * Dropping a file stages it asynchronously (full read + package inspection +
 * copy in main), but the send path snapshots `pendingFiles` synchronously at
 * click time. Dropping a Word file and pressing Enter straight away therefore
 * sent the message with NO attachment and no warning — the 2026-09-15 demo's
 * "Word 拖拽时好时坏". This module is the one place both sides agree on: the
 * file handler brackets every staging run, the composer waits for it.
 *
 * Kill switch: LILY_ATTACHMENT_STAGING_WAIT is not read here (renderer); the
 * wait is bounded by STAGING_WAIT_TIMEOUT_MS so a stuck stage can never block
 * sending forever.
 */

export const STAGING_WAIT_TIMEOUT_MS = 30_000;

let depth = 0;
let waiters = [];
let onChange = null;

function settle() {
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve();
}

/** Called by the renderer shell so the send button can disable while staging. */
export function setAttachmentStagingListener(listener) {
  onChange = typeof listener === "function" ? listener : null;
}

export function attachmentStagingInFlight() {
  return depth > 0;
}

/** Bracket one staging run. Always balances, even when the body throws. */
export async function trackAttachmentStaging(run) {
  depth += 1;
  if (depth === 1) { try { onChange?.(true); } catch { /* never block staging */ } }
  try {
    return await run();
  } finally {
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      settle();
      try { onChange?.(false); } catch { /* never block staging */ }
    }
  }
}

/**
 * Resolves once nothing is staging, or after STAGING_WAIT_TIMEOUT_MS so a stuck
 * stage degrades to today's behaviour (send without the attachment) instead of
 * freezing the composer.
 * @returns {Promise<boolean>} true when staging finished, false on timeout.
 */
export function whenAttachmentsSettled({ timeoutMs = STAGING_WAIT_TIMEOUT_MS, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (depth === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeoutImpl(() => { if (!done) { done = true; resolve(false); } }, Math.max(0, timeoutMs));
    waiters.push(() => {
      if (done) return;
      done = true;
      clearTimeoutImpl(timer);
      resolve(true);
    });
  });
}

/** Test hook. */
export function resetAttachmentStagingForTests() {
  depth = 0;
  waiters = [];
  onChange = null;
}
