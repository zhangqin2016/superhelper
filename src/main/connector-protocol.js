"use strict";

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const ACTION_RE = /^[a-z][a-z0-9-]{1,31}\.[a-z][a-z0-9_.-]{1,95}$/;
const CONNECTOR_KINDS = new Set(["mail", "web", "file", "ticket", "crm", "custom"]);
const AUTH_TYPES = new Set(["none", "oauth2", "api-key", "password", "browser-session", "local-profile"]);
const RISK_LEVELS = new Set(["read", "prepare", "submit", "destructive"]);
const CONFIRMATION_LEVELS = new Set(["none", "review", "explicit"]);
const SECRET_KEY_RE = /(secret|token|password|api[_-]?key|refresh[_-]?token|access[_-]?token|authorization|cookie)/i;

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function normalizeId(value, field = "id") {
  const id = String(value || "").trim().toLowerCase();
  if (!ID_RE.test(id)) {
    throw new Error(`${field} must start with a lowercase letter and contain only lowercase letters, digits, or hyphens`);
  }
  return id;
}

function normalizeString(value, field, { required = true, max = 300 } = {}) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (required && !text) throw new Error(`${field} is required`);
  if (text.length > max) return text.slice(0, max);
  return text;
}

function normalizeArray(value, field, { required = true } = {}) {
  if (!Array.isArray(value)) {
    if (required) throw new Error(`${field} must be an array`);
    return [];
  }
  const items = value.map((item) => String(item || "").trim()).filter(Boolean);
  if (required && items.length === 0) throw new Error(`${field} must be a non-empty array`);
  return [...new Set(items)];
}

function normalizeDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return raw.toLowerCase().split("/")[0].split(":")[0];
  }
}

function normalizeUrl(value, field = "baseUrl") {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) throw new Error(`${field} must start with http:// or https://`);
  return text.replace(/#.*$/, "");
}

function hostAllowed(host, allowedDomains) {
  return allowedDomains.includes(host) || allowedDomains.some((domain) => host.endsWith(`.${domain}`));
}

function normalizeAuth(auth = {}) {
  const source = requireObject(auth || {}, "auth");
  const type = String(source.type || "none").trim();
  if (!AUTH_TYPES.has(type)) throw new Error(`auth.type is invalid: ${type}`);
  return {
    type,
    secretRefs: normalizeArray(source.secretRefs || [], "auth.secretRefs", { required: false }),
    scopes: normalizeArray(source.scopes || [], "auth.scopes", { required: false }),
    notes: normalizeString(source.notes || "", "auth.notes", { required: false, max: 500 }),
  };
}

function normalizeConnectorManifest(input) {
  const source = requireObject(input, "connector");
  const kind = String(source.kind || "custom").trim();
  if (!CONNECTOR_KINDS.has(kind)) throw new Error(`kind is invalid: ${kind}`);
  const capabilities = normalizeArray(source.capabilities, "capabilities").map((capability) => {
    if (!ACTION_RE.test(capability)) throw new Error(`capability is invalid: ${capability}`);
    return capability;
  });
  return {
    schemaVersion: Number(source.schemaVersion || 1),
    id: normalizeId(source.id),
    name: normalizeString(source.name, "name"),
    kind,
    description: normalizeString(source.description || "", "description", { required: false, max: 800 }),
    capabilities,
    auth: normalizeAuth(source.auth),
    allowRemoteConfig: Boolean(source.allowRemoteConfig),
    metadata: requireObject(source.metadata || {}, "metadata"),
  };
}

function normalizeActionSpec(input) {
  const source = requireObject(input, "actionSpec");
  const action = String(source.action || "").trim();
  if (!ACTION_RE.test(action)) throw new Error(`action is invalid: ${action}`);
  const risk = String(source.risk || "read").trim();
  if (!RISK_LEVELS.has(risk)) throw new Error(`risk is invalid: ${risk}`);
  const confirmation = String(source.confirmation || (risk === "read" ? "none" : "review")).trim();
  if (!CONFIRMATION_LEVELS.has(confirmation)) throw new Error(`confirmation is invalid: ${confirmation}`);
  if (risk !== "read" && confirmation === "none") {
    throw new Error(`${action} requires review or explicit confirmation`);
  }
  if (risk === "destructive" && confirmation !== "explicit") {
    throw new Error(`${action} destructive actions require explicit confirmation`);
  }
  return {
    action,
    title: normalizeString(source.title, "title"),
    connectorKind: String(source.connectorKind || action.split(".")[0]).trim(),
    risk,
    confirmation,
    intentExamples: normalizeArray(source.intentExamples || [], "intentExamples", { required: false }),
    paramsSchema: requireObject(source.paramsSchema || {}, "paramsSchema"),
    resultSchema: requireObject(source.resultSchema || {}, "resultSchema"),
    steps: normalizeArray(source.steps || [], "steps", { required: false }),
    selectors: Array.isArray(source.selectors) ? source.selectors.filter(Boolean) : [],
  };
}

function normalizePlaybookSpec(input) {
  const source = requireObject(input, "playbook");
  const connector = normalizeConnectorManifest(source.connector);
  const baseUrl = normalizeUrl(source.baseUrl);
  const allowedDomains = normalizeArray(source.allowedDomains, "allowedDomains").map(normalizeDomain).filter(Boolean);
  const baseHost = normalizeDomain(baseUrl);
  if (!hostAllowed(baseHost, allowedDomains)) {
    throw new Error(`allowedDomains must include baseUrl host or parent domain: ${baseHost}`);
  }
  if (!Array.isArray(source.actions) || source.actions.length === 0) {
    throw new Error("actions must be a non-empty array");
  }
  const actions = source.actions.map((action) =>
    normalizeActionSpec({ ...action, connectorKind: action.connectorKind || connector.kind }),
  );
  return {
    schemaVersion: Number(source.schemaVersion || 1),
    id: normalizeId(source.id),
    name: normalizeString(source.name, "name"),
    description: normalizeString(source.description || "", "description", { required: false, max: 1200 }),
    baseUrl,
    allowedDomains,
    connector,
    actions,
    createdAt: source.createdAt || new Date().toISOString(),
  };
}

function redactConnectorSecrets(value) {
  if (Array.isArray(value)) return value.map((item) => redactConnectorSecrets(item));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redactConnectorSecrets(item);
  }
  return output;
}

module.exports = {
  normalizeActionSpec,
  normalizeConnectorManifest,
  normalizePlaybookSpec,
  redactConnectorSecrets,
};
