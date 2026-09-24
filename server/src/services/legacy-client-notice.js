import { offerRelease } from "./release-offer.js";
import { compareVersions } from "./release-versions.js";

// Loaded on first use: the gateway imports this module, and must not gain a
// database dependency at import time (it did not have one).
const storage = () => Promise.all([import("../db.js"), import("./app-settings.js")]).then(([dbModule, settings]) => ({ db: dbModule.db, getAppSetting: settings.getAppSetting }));

/**
 * Telling a client too old to update itself that it must update — through the
 * one channel every version renders: a normal assistant reply.
 *
 * Old clients cannot be reached by the update mechanism (they never read the
 * mandate), and an HTTP error does not reach the user either: the client
 * classifies it ("API Error: 4xx" reads as "connection failed", and may be
 * retried). A reply is shown verbatim by every version and every engine. So a
 * chat request from a device below its platform's minimum supported version is
 * answered — without calling a provider, without billing — with how to update
 * and where to download.
 *
 * Off by default, and scoped: it can be tried on a list of licenses or devices
 * first. It never answers when no installable release reaches the floor: a
 * notice with nowhere to go would only stop the user working.
 */
export const LEGACY_NOTICE_SETTING = "legacy_client_notice";
export const LEGACY_NOTICE_DEFAULT = Object.freeze({ enabled: false, licenseIds: [], deviceIds: [] });

export function normalizeLegacyNotice(raw) {
  const list = (value) => [...new Set((Array.isArray(value) ? value : []).map((v) => String(v).trim()).filter(Boolean))].slice(0, 500);
  return { enabled: raw?.enabled === true, licenseIds: list(raw?.licenseIds), deviceIds: list(raw?.deviceIds) };
}

/** Pure: does this device get the notice, and what does it say. */
export function decideLegacyNotice({ settings, device, licenseId = "", minimum = "", offered = null }) {
  if (!settings.enabled || !device?.app_version || !minimum) return { notice: false, reason: "off_or_no_floor" };
  const scoped = settings.licenseIds.length || settings.deviceIds.length;
  if (scoped && !settings.licenseIds.includes(licenseId) && !settings.deviceIds.includes(device.id)) return { notice: false, reason: "outside_trial_scope" };
  if (compareVersions(device.app_version, minimum) >= 0) return { notice: false, reason: "supported" };
  if (!offered || compareVersions(offered.version, minimum) < 0) return { notice: false, reason: "no_release_at_floor" };
  const version = device.app_version;
  const text = [
    `当前 Lily 版本 ${version} 已停止支持，请更新到 ${offered.version}。`,
    `关闭并重新打开 Lily 即可自动完成更新；如果没有自动更新，请下载安装：${offered.url}`,
    "",
    `Lily ${version} is no longer supported. Please update to ${offered.version}: restart Lily to update automatically, or download it here: ${offered.url}`,
  ].join("\n");
  return { notice: true, text, version, target: offered.version };
}

// Counted since the server started, shown in the console.
const hits = { requests: 0, devices: new Set() };
export function legacyNoticeHits() {
  return { requests: hits.requests, devices: hits.devices.size };
}

const cache = new Map();
const CACHE_MS = 60_000;

async function decisionForToken(token) {
  const deviceId = String(token?.deviceId || "");
  if (!deviceId) return { notice: false, reason: "no_device" };
  const cached = cache.get(deviceId);
  if (cached && cached.at > Date.now() - CACHE_MS) return cached.decision;
  let decision = { notice: false, reason: "error" };
  try {
    const { db, getAppSetting } = await storage();
    const settings = normalizeLegacyNotice(await getAppSetting(LEGACY_NOTICE_SETTING, null));
    if (!settings.enabled) {
      decision = { notice: false, reason: "off_or_no_floor" };
    } else {
      const device = await db.selectFrom("devices").select(["id", "app_version", "platform", "arch"]).where("id", "=", deviceId).executeTakeFirst();
      const platform = device ? [device.platform, device.arch].filter(Boolean).join("-") : "";
      const [support, releases, rollouts] = await Promise.all([
        db.selectFrom("release_support").selectAll().where("channel", "=", "stable").where("platform", "=", platform).executeTakeFirst(),
        db.selectFrom("releases").selectAll().where("platform", "=", platform).where("enabled", "=", true).execute(),
        db.selectFrom("release_rollouts").selectAll().where("platform", "=", platform).execute(),
      ]);
      const offered = offerRelease({ releases, rollouts, support }).release;
      decision = decideLegacyNotice({ settings, device, licenseId: String(token.licenseId || ""), minimum: support?.min_supported_version || "", offered });
    }
  } catch {
    decision = { notice: false, reason: "error" }; // any doubt: let the request through
  }
  cache.set(deviceId, { at: Date.now(), decision });
  return decision;
}

function anthropicMessage(text, model) {
  return { id: `msg_notice_${Date.now()}`, type: "message", role: "assistant", model: model || "lily-notice", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
}

function anthropicStream(text, model) {
  const message = anthropicMessage("", model);
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    event("message_start", { message: { ...message, content: [] } }),
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } }),
    event("message_stop", {}),
  ].join("");
}

function openAiCompletion(text, model) {
  return { id: `chatcmpl-notice-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model || "lily-notice", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

function openAiStream(text, model) {
  const base = { id: `chatcmpl-notice-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "lily-notice" };
  const chunk = (choice) => `data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`;
  return [
    chunk({ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }),
    chunk({ index: 0, delta: {}, finish_reason: "stop" }),
    "data: [DONE]\n\n",
  ].join("");
}

/** Pure: the response body for a protocol × stream. */
export function noticeResponse({ protocol, stream, text, model }) {
  if (protocol === "openai") {
    return stream ? { contentType: "text/event-stream", body: openAiStream(text, model) } : { contentType: "application/json", body: JSON.stringify(openAiCompletion(text, model)) };
  }
  return stream ? { contentType: "text/event-stream", body: anthropicStream(text, model) } : { contentType: "application/json", body: JSON.stringify(anthropicMessage(text, model)) };
}

/** In the gateway, after the token is verified. True when the request was answered. */
export async function maybeSendLegacyNotice({ token, body, reply, protocol }) {
  const decision = await decisionForToken(token);
  if (!decision.notice) return false;
  hits.requests += 1;
  hits.devices.add(String(token.deviceId));
  const response = noticeResponse({ protocol, stream: Boolean(body?.stream), text: decision.text, model: body?.model });
  reply.code(200).header("content-type", response.contentType).send(response.body);
  return true;
}

export function clearLegacyNoticeCache() {
  cache.clear();
}
