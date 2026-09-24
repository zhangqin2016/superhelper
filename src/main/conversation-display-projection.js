"use strict";

/**
 * What a committed message looks like on its way to the renderer.
 *
 * Measured on a real 365-message session: a page of 50 messages was 13.6 MB
 * of JSON, 66% of it `record.processEvents` — the raw stdout/effect payloads
 * of every command the turn ran, kept at up to 100 events per turn. The
 * process panel renders a summary line and a handful of truncated effects
 * per event; the live turn already gets exactly that compact form from
 * persisted runtime events. So the archived record is compacted the same
 * way (see turn-archive), and records archived before that are compacted
 * here, on read, so a page carries what the screen shows.
 */

const { compactProcessEvent } = require("./store/runtime-event-persistence");
const { dehydrateMessage } = require("../shared/timeline-tool-refs.mjs");

function compactProcessEvents(events) {
  if (!Array.isArray(events) || !events.length) return events;
  return events.map((event) => (event && typeof event === "object" && !event.compact
    ? { ...compactProcessEvent(event.payload || event), compact: true }
    : event));
}

/** A copy of `message` with a display-sized record; the stored object is never mutated. */
// Timeline tool entries travel as references too; the renderer restores them
// where it turns a record into a timeline (turn-record-timeline).
function projectMessageForDisplay(message) {
  const sent = dehydrateMessage(message);
  const record = sent?.record;
  if (!record || !Array.isArray(record.processEvents) || !record.processEvents.length) return sent;
  if (record.processEvents.every((event) => event?.compact)) return sent;
  return { ...sent, record: { ...record, processEvents: compactProcessEvents(record.processEvents) } };
}

function projectConversationForDisplay(conversation) {
  return Array.isArray(conversation) ? conversation.map(projectMessageForDisplay) : conversation;
}

module.exports = { compactProcessEvents, projectConversationForDisplay, projectMessageForDisplay };
