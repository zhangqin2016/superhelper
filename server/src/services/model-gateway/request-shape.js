// Server twin of src/main/openai-request-shape.js: which output-limit field an
// upstream accepts is learned from its 4xx, not assumed from a model id. The
// learned shape is remembered per provider+model for the life of the process.
const OUTPUT_LIMIT_FIELDS = ["max_tokens", "max_completion_tokens"];
const UNSUPPORTED_RE = /unsupported|not supported|unrecognized|unknown (?:parameter|argument|field)|invalid (?:parameter|argument)|not allowed|does not support|is not permitted|only the default/;

export function normalizeRequestShape(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    outputLimitField: OUTPUT_LIMIT_FIELDS.includes(source.outputLimitField) ? source.outputLimitField : "max_tokens",
    temperature: source.temperature === "omit" ? "omit" : "allowed",
  };
}

export function parseOpenAiError(status, json, text = "") {
  const err = json && typeof json === "object" ? (json.error ?? json) : null;
  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const message = pick(err?.message) || pick(typeof err === "string" ? err : "") || pick(json?.message) || pick(text).slice(0, 300);
  return { status: Number(status) || 0, code: pick(err?.code) || pick(err?.type), param: pick(err?.param), message: message.slice(0, 300) };
}

const mentions = (text, field) => new RegExp(`(^|[^a-z_])${field}([^a-z_]|$)`).test(text);

export function classifyShapeRejection({ status, error, shape, sentBody }) {
  const s = Number(status) || 0;
  if (s < 400 || s >= 500) return null;
  const current = normalizeRequestShape(shape);
  const info = error || {};
  const text = `${info.code} ${info.param} ${info.message}`.toLowerCase();
  const param = String(info.param || "").toLowerCase();
  const unsupported = UNSUPPORTED_RE.test(text) || /unsupported_(parameter|value)/.test(param);
  const sentLimit = OUTPUT_LIMIT_FIELDS.find((field) => sentBody && Object.prototype.hasOwnProperty.call(sentBody, field)) || current.outputLimitField;
  const refusedLimit = OUTPUT_LIMIT_FIELDS.includes(param) ? param : (mentions(text, sentLimit) && unsupported ? sentLimit : "");
  if (refusedLimit && (unsupported || mentions(text, "max_completion_tokens") || mentions(text, "max_tokens"))) {
    const next = refusedLimit === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    return { shape: { ...current, outputLimitField: next }, reason: `unsupported_parameter:${refusedLimit}` };
  }
  if (sentBody && sentBody.temperature !== undefined && current.temperature !== "omit" && (param === "temperature" || (mentions(text, "temperature") && unsupported))) {
    return { shape: { ...current, temperature: "omit" }, reason: "unsupported_value:temperature" };
  }
  return null;
}

export function applyRequestShape(body, shape) {
  const s = normalizeRequestShape(shape);
  const out = { ...(body || {}) };
  const limit = OUTPUT_LIMIT_FIELDS.map((field) => out[field]).find((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  for (const field of OUTPUT_LIMIT_FIELDS) delete out[field];
  if (limit !== undefined) out[s.outputLimitField] = Math.floor(Number(limit));
  if (s.temperature === "omit") delete out.temperature;
  return out;
}

const learned = new Map();
const key = (provider, model) => `${String(provider?.id || provider?.baseUrl || "")}|${String(model || "")}`;
export function recallShape(provider, model) { return learned.get(key(provider, model)) || normalizeRequestShape(null); }
export function rememberShape(provider, model, shape) { learned.set(key(provider, model), normalizeRequestShape(shape)); }
export function resetLearnedShapesForTests() { learned.clear(); }
