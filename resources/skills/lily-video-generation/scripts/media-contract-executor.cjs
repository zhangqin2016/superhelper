"use strict";

function parseContracts(env) {
  const raw = String(env.LILY_MEDIA_CONTRACTS_JSON || "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid LILY_MEDIA_CONTRACTS_JSON: ${error.message}`);
  }
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.contracts !== "object") return null;
  return parsed;
}

function contractFor(env, modality, provider) {
  const parsed = parseContracts(env);
  if (!parsed) return null;
  return parsed.contracts?.[modality]?.[provider] || null;
}

function sourceValue(input, name) {
  if (name === "text") return input.text ?? input.input;
  return input[name];
}

function normalizeParamValue(name, spec, input) {
  const rawValue = sourceValue(input, name);
  const hasInputValue = rawValue !== undefined && rawValue !== null && String(rawValue) !== "";
  let value = hasInputValue ? rawValue : spec.default;
  if ((value === undefined || value === null || String(value) === "") && spec.required) {
    throw new Error(`Missing required media contract parameter: ${name}`);
  }
  if (value === undefined || value === null || String(value) === "") return undefined;
  value = String(value);
  if (spec.aliases && Object.prototype.hasOwnProperty.call(spec.aliases, value)) value = spec.aliases[value];
  if (spec.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Invalid number for media contract parameter ${name}: ${value}`);
    value = n;
  } else if (spec.type === "boolean") {
    value = value === true || value === "true";
  }
  if (Array.isArray(spec.enum) && spec.enum.length && !spec.enum.includes(value)) {
    throw new Error(`Unsupported value for media contract parameter ${name}: ${value}; supported: ${spec.enum.join(", ")}`);
  }
  return value;
}

function resolveParams(contract, input) {
  const out = { ...input };
  const params = contract?.params && typeof contract.params === "object" ? contract.params : {};
  for (const [name, spec] of Object.entries(params)) {
    if (!spec || typeof spec !== "object") continue;
    const value = normalizeParamValue(name, spec, input);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function renderTemplateValue(value, params) {
  if (Array.isArray(value)) return value.map((item) => renderTemplateValue(item, params));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const rendered = renderTemplateValue(child, params);
      if (rendered !== undefined) out[key] = rendered;
    }
    return out;
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^{{\s*([a-zA-Z0-9_]+)\s*}}$/);
  if (exact) return params[exact[1]];
  return value.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key) => String(params[key] ?? ""));
}

function buildMediaContractRequest({ env = process.env, modality, provider, input = {} }) {
  const contract = contractFor(env, modality, provider);
  if (!contract) return null;
  const endpointEnv = String(contract.endpointEnv || "").trim();
  const endpoint = endpointEnv ? String(env[endpointEnv] || "").trim() : "";
  if (!endpoint) throw new Error(`Missing ${endpointEnv || "media contract endpoint env"} for ${modality}/${provider}`);

  const request = contract.request && typeof contract.request === "object" ? contract.request : {};
  const params = resolveParams(contract, input);
  const body = renderTemplateValue(request.template || {}, params);
  const headers = {};
  const authEnv = String(contract.authEnv || "").trim();
  const authValue = authEnv ? String(env[authEnv] || "").trim() : "";
  if (authValue) headers.Authorization = `Bearer ${authValue}`;
  const contentType = request.contentType || "application/json";
  if (contentType) headers["Content-Type"] = contentType;
  return {
    url: endpoint,
    options: {
      method: request.method || "POST",
      headers,
      body: contentType === "application/json" ? JSON.stringify(body) : body,
    },
    contract,
    params,
  };
}

module.exports = {
  buildMediaContractRequest,
};
