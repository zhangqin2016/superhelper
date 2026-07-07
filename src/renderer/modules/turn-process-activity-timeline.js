import {
  activityFromProcessPayload,
  setActivityLabel,
} from "./turn-activity-policy.js";
import { hasRunningTool } from "./turn-tool-timeline.js";

export function applyProcessEventToTimeline(target, payload, ts = Date.now()) {
  const label = activityFromProcessPayload(payload);
  if (label && !hasRunningTool(target.tools)) setActivityLabel(target, label);
}
