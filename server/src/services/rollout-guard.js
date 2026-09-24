import { db } from "../db.js";
import { getAppSetting } from "./app-settings.js";
import { baselineFor, judgeHealth, versionHealth } from "./release-health.js";

/**
 * Watching rollouts in flight. A rolling version whose error rate is clearly
 * worse than the version before it is always flagged (dashboard, console);
 * with auto-pause on, it is also paused — widening stops, installed devices
 * are untouched, and an operator resumes or halts it. Off by default: the
 * thresholds are a console setting, not constants here.
 */
export const AUTO_PAUSE_SETTING = "release_auto_pause";
export const AUTO_PAUSE_DEFAULT = Object.freeze({ enabled: false, minDevices: 20, worseRatio: 1.5, windowHours: 24 });
const BOUNDS = { minDevices: [5, 10_000], worseRatio: [1.1, 10], windowHours: [1, 168] };

export function normalizeAutoPause(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const out = { enabled: value.enabled === true };
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const number = Number(value[key]);
    out[key] = Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : AUTO_PAUSE_DEFAULT[key];
  }
  return out;
}

/** Pure: for each rolling rollout, its health against the previous version and whether to pause it. */
export function guardDecisions({ rollouts = [], health, settings }) {
  const thresholds = { minDevices: settings.minDevices, worseRatio: settings.worseRatio, windowHours: settings.windowHours };
  return rollouts.filter((rollout) => rollout.state === "rolling").map((rollout) => {
    const candidate = health.get(`${rollout.platform}@${rollout.version}`) || null;
    const judgement = judgeHealth(candidate, baselineFor(health, rollout.platform, rollout.version), thresholds);
    return { rollout, judgement, pause: settings.enabled && judgement.verdict === "worse" };
  });
}

export async function loadAutoPause() {
  return normalizeAutoPause(await getAppSetting(AUTO_PAUSE_SETTING, null).catch(() => null));
}

export async function runRolloutGuard() {
  const settings = await loadAutoPause();
  const rollouts = await db.selectFrom("release_rollouts").selectAll().where("state", "=", "rolling").execute().catch(() => []);
  if (!rollouts.length) return { settings, decisions: [] };
  const health = await versionHealth({ windowHours: settings.windowHours });
  const decisions = guardDecisions({ rollouts, health, settings });
  for (const decision of decisions.filter((d) => d.pause)) {
    // Only if still rolling: an operator's move in the meantime wins.
    const result = await db.updateTable("release_rollouts").set({ state: "paused", updated_at: new Date() })
      .where("id", "=", decision.rollout.id).where("state", "=", "rolling").executeTakeFirst();
    if (!Number(result?.numUpdatedRows || 0)) continue;
    await db.insertInto("audit_logs").values({
      actor: "rollout-guard",
      action: "rollout.auto_pause",
      target_type: "release_rollout",
      target_id: decision.rollout.id,
      metadata: JSON.stringify({ version: decision.rollout.version, platform: decision.rollout.platform, percent: decision.rollout.percent, judgement: decision.judgement, settings }),
    }).execute().catch(() => {});
  }
  return { settings, decisions };
}
