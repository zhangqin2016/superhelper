import { resolveOrgForConsumption } from "./wallet.js";

export async function resolveOrgContextForRequest(request, reply, token) {
  const organizationId = String(request.headers["x-lily-organization-id"] || "").trim().slice(0, 120);
  if (!organizationId) return "";
  const decision = await resolveOrgForConsumption({ userId: token.userId, organizationId, units: 1 });
  if (!decision.ok) {
    reply.code(403).send({ error: { type: "org_forbidden", message: decision.code } });
    return null;
  }
  return organizationId;
}
