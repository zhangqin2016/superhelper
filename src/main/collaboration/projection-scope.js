"use strict";

function projectedScopeId(value, fallback = "personal") {
  const scopeType = String(value?.scopeType ?? value?.scope_type ?? "");
  const organizationId = String(value?.organizationId ?? value?.organization_id ?? "").trim();
  if (scopeType === "organization" && organizationId) return `team:${organizationId}`;
  return String(value?.scopeId ?? value?.scope_id ?? fallback).trim() || fallback;
}

module.exports = { projectedScopeId };
