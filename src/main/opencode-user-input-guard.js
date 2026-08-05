"use strict";

function hasPendingUserInput(session) {
  return Boolean(session?._pendingPermissions?.size || session?._pendingQuestions?.size);
}

function pauseForPendingUserInput(session, payload = {}) {
  if (
    payload?.interrupted
    || payload?.stalled
    || (payload?.code && payload.code !== 0)
    || !hasPendingUserInput(session)
  ) return false;
  session._pendingCompletePayload = null;
  session._clearIdleSettleTimer();
  session._clearIdleProbeTimer();
  session._clearResponseTimer();
  session._clearProgressNoticeTimer();
  session._clearTurnWatchdog();
  return true;
}

function resumeAfterUserInput(session) {
  session._sawActivity = true;
  session._armResponseTimer();
  session._armProgressNoticeTimer();
  session._armIdleProbe();
}

module.exports = { hasPendingUserInput, pauseForPendingUserInput, resumeAfterUserInput };
