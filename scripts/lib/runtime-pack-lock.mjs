import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOCK_PATH = path.join(ROOT, "resources/runtime/runtime-pack-lock.json");

function orderedEntry(entry) {
  return {
    packId: entry.packId,
    platform: entry.platform,
    version: entry.version,
    url: entry.url,
    sha256: String(entry.sha256 || "").toLowerCase(),
    sizeBytes: Number(entry.sizeBytes),
    healthProbe: entry.healthProbe,
    enabled: true,
    ...(entry.components ? { components: entry.components } : {}),
    verifiedAt: entry.verifiedAt || new Date().toISOString(),
  };
}

export function updateRuntimePackLock(entry) {
  if (!/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ""))) throw new Error("INVALID_RUNTIME_PACK_LOCK_SHA256");
  if (!Number.isInteger(Number(entry.sizeBytes)) || Number(entry.sizeBytes) <= 0) throw new Error("INVALID_RUNTIME_PACK_LOCK_SIZE");
  if (!entry.healthProbe) throw new Error("MISSING_RUNTIME_PACK_HEALTH_PROBE");
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  const entries = (Array.isArray(lock.entries) ? lock.entries : [])
    .filter((item) => !(item.packId === entry.packId && item.platform === entry.platform));
  entries.push(orderedEntry(entry));
  entries.sort((a, b) => a.packId.localeCompare(b.packId) || a.platform.localeCompare(b.platform));
  fs.writeFileSync(LOCK_PATH, `${JSON.stringify({ ...lock, entries }, null, 2)}\n`, "utf8");
  return entries.find((item) => item.packId === entry.packId && item.platform === entry.platform);
}

export function healthProbeForSpec(spec = {}) {
  if (spec.probe) return spec.probe;
  if (spec.installKind === "node-browser-runtime") return "node:playwright+chromium";
  if (spec.health?.kind === "libreoffice") return "libreoffice:headless-init";
  const executables = Array.isArray(spec.health?.executables) ? spec.health.executables : [];
  if (executables.length) return executables.map((item) => `${item.name} ${(item.args || []).join(" ")}`.trim()).join(" && ");
  return "catalog-presence";
}
