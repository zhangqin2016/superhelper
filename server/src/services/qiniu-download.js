import crypto from "node:crypto";

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Create a short-lived Qiniu private-download URL for an already configured
 * artifact URL. Public buckets continue to work with the same URL; Qiniu
 * simply ignores the optional download token there.
 */
export function qiniuPrivateDownloadUrlForUrl({ url, qiniuConfig, expiresInSeconds = 3600, nowMs = Date.now() }) {
  const original = String(url || "").trim();
  const config = qiniuConfig || {};
  if (!original || !config.accessKey || !config.secretKey || !config.publicBaseUrl) return original;

  let candidate;
  let configuredBase;
  try {
    candidate = new URL(original);
    configuredBase = new URL(String(config.publicBaseUrl).trim());
  } catch {
    return original;
  }
  if (candidate.protocol !== "https:" || candidate.origin !== configuredBase.origin) return original;

  const configuredPath = configuredBase.pathname.replace(/\/+$/, "");
  if (configuredPath && !candidate.pathname.startsWith(`${configuredPath}/`) && candidate.pathname !== configuredPath) {
    return original;
  }

  const expires = Math.max(60, Math.min(24 * 60 * 60, Math.round(Number(expiresInSeconds) || 3600)));
  const deadline = Math.floor(Number(nowMs) / 1000) + expires;
  candidate.searchParams.delete("token");
  candidate.searchParams.set("e", String(deadline));
  const unsignedUrl = candidate.toString();
  const signature = base64Url(crypto.createHmac("sha1", config.secretKey).update(unsignedUrl).digest());
  return `${unsignedUrl}&token=${config.accessKey}:${signature}`;
}
