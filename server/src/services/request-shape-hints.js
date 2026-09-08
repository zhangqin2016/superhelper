// Request-shape hints delivered to desktop clients through the signed client
// config: rules for provider quirks no shipped client rule knows yet, so a new
// quirk is a server setting (MODEL_REQUEST_SHAPE_HINTS_JSON or a config profile's
// models.requestShapeHints), not a desktop release. Shape of one hint:
//   { id, when: { status?, param?, message? (regex source) },
//         then: { omit?, rename?, api?, toolChoice?, stripSchemaKeywords?, outputLimitField? } }
// Malformed input yields no hints — never a throw on the config path.
export function parseRequestShapeHints(raw) {
  try {
    const parsed = JSON.parse(String(raw || "").trim() || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((h) => h && typeof h === "object" && h.when && typeof h.when === "object" && h.then && typeof h.then === "object")
      .map((h) => ({ id: String(h.id || "").slice(0, 40), when: h.when, then: h.then })).slice(0, 32);
  } catch {
    return [];
  }
}

