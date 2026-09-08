// Server twin of src/main/openai-request-shape.js: which output-limit field an
// upstream accepts is learned from its 4xx, not assumed from a model id. The
// learned shape is remembered per provider+model for the life of the process.
const OUTPUT_LIMIT_FIELDS = ["max_tokens", "max_completion_tokens"];
const UNSUPPORTED_RE = /unsupported|not supported|unrecognized|unknown (?:parameter|argument|field)|invalid (?:parameter|argument)|not allowed|does not support|is not permitted|only the default/;

const listOf = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter((x) => /^[A-Za-z_$][\w$.-]{0,63}$/.test(x)))].sort().slice(0, 8);
const ESSENTIAL = new Set(["model", "messages", "stream", "tools"]);
const SCHEMA_KEYWORDS = ["additionalProperties", "$schema", "format", "default", "minimum", "maximum", "minLength", "maxLength", "pattern", "examples", "title"];
const hasKeyDeep = (v, k) => Array.isArray(v) ? v.some((x) => hasKeyDeep(x, k)) : Boolean(v && typeof v === "object" && (Object.prototype.hasOwnProperty.call(v, k) || Object.values(v).some((x) => hasKeyDeep(x, k))));
const stripDeep = (v, ks) => Array.isArray(v) ? v.map((x) => stripDeep(x, ks)) : (v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !ks.includes(k)).map(([k, x]) => [k, stripDeep(x, ks)])) : v);
export function normalizeRequestShape(value) {
  const source = value && typeof value === "object" ? value : {};
  const rename = {};
  if (source.rename && typeof source.rename === "object") for (const [k, v] of Object.entries(source.rename).slice(0, 8)) if (/^[A-Za-z_]\w{0,63}$/.test(k) && /^[A-Za-z_]\w{0,63}$/.test(String(v || ""))) rename[k] = String(v);
  return {
    outputLimitField: OUTPUT_LIMIT_FIELDS.includes(source.outputLimitField) ? source.outputLimitField : "max_tokens",
    temperature: source.temperature === "omit" ? "omit" : "allowed",
    omit: listOf(source.omit),
    rename,
    stripSchemaKeywords: listOf(source.stripSchemaKeywords),
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
  const raw = String(info.message || ""); const sent = sentBody || {};
  const rn = /['"`]([A-Za-z_]\w{0,63})['"`][\s\S]{0,160}?\b(?:use|try)\s+['"`]([A-Za-z_]\w{0,63})['"`]\s+instead/i.exec(raw);
  if (rn && unsupported && Object.prototype.hasOwnProperty.call(sent, rn[1]) && !ESSENTIAL.has(rn[1]) && current.rename[rn[1]] !== rn[2]) return { shape: { ...current, rename: { ...current.rename, [rn[1]]: rn[2] } }, reason: `rename:${rn[1]}->${rn[2]}` };
  if (Array.isArray(sent.tools) && sent.tools.length) {
    const kw = SCHEMA_KEYWORDS.find((k) => raw.includes(k) && !current.stripSchemaKeywords.includes(k) && hasKeyDeep(sent.tools, k));
    if (kw && (unsupported || /unknown name|cannot find field|not allowed|invalid/i.test(raw))) return { shape: { ...current, stripSchemaKeywords: [...current.stripSchemaKeywords, kw] }, reason: `strip_schema_keyword:${kw}` };
  }
  const named = param && Object.prototype.hasOwnProperty.call(sent, param) ? param : Object.keys(sent).find((k) => !ESSENTIAL.has(k) && mentions(text, k.toLowerCase()) && unsupported) || "";
  if (named && !ESSENTIAL.has(named) && !current.omit.includes(named) && unsupported) return { shape: { ...current, omit: [...current.omit, named] }, reason: `omit:${named}` };
  return null;
}

export function applyRequestShape(body, shape) {
  const s = normalizeRequestShape(shape);
  const out = { ...(body || {}) };
  const limit = OUTPUT_LIMIT_FIELDS.map((field) => out[field]).find((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  for (const field of OUTPUT_LIMIT_FIELDS) delete out[field];
  if (limit !== undefined) out[s.outputLimitField] = Math.floor(Number(limit));
  if (s.temperature === "omit") delete out.temperature;
  for (const [from, to] of Object.entries(s.rename)) if (Object.prototype.hasOwnProperty.call(out, from)) { out[to] = out[from]; delete out[from]; }
  for (const f of s.omit) delete out[f];
  if (s.stripSchemaKeywords.length && Array.isArray(out.tools)) out.tools = out.tools.map((t) => (t?.function?.parameters ? { ...t, function: { ...t.function, parameters: stripDeep(t.function.parameters, s.stripSchemaKeywords) } } : t));
  return out;
}

const learned = new Map();
const key = (provider, model) => `${String(provider?.id || provider?.baseUrl || "")}|${String(model || "")}`;
export function recallShape(provider, model) { return learned.get(key(provider, model)) || normalizeRequestShape(null); }
export function rememberShape(provider, model, shape) { learned.set(key(provider, model), normalizeRequestShape(shape)); }
export function resetLearnedShapesForTests() { learned.clear(); }
