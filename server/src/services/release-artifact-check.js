/**
 * A release row is a promise that a file exists.
 *
 * The admin validated that the url looked like a url and that the hash was long
 * enough, and stopped there — so a release could be published against an object
 * that was never uploaded. Production carried exactly that on 2026-09-22: a
 * Windows build listed at a URL that answers 404, which a client discovers only
 * when a customer clicks download.
 *
 * The check is a HEAD request: cheap, read-only, and bounded. It is advisory by
 * construction — a reachable artifact is required, but an artifact host that
 * cannot answer (network blip, HEAD unsupported) must not block a release, so
 * only a definite "not there" refuses. Never dumber than before: the old
 * behaviour was to accept everything.
 */

const TIMEOUT_MS = 8000;

export const ARTIFACT_MISSING = "RELEASE_ARTIFACT_NOT_FOUND";

/**
 * @param {string} url
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [deps]
 * @returns {Promise<{ok: true, status?: number, size?: number|null, checked: boolean}
 *   | {ok: false, code: string, status: number, url: string}>}
 */
export async function checkReleaseArtifact(url, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : TIMEOUT_MS;
  if (typeof fetchImpl !== "function") return { ok: true, checked: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    const status = Number(response?.status || 0);
    // A definite "this object is not there" is the only refusal. 401/403 mean a
    // host that guards HEAD, 405 means it does not implement it, 5xx means the
    // host is having a bad minute — none of those prove the file is missing.
    if (status === 404 || status === 410) {
      return { ok: false, code: ARTIFACT_MISSING, status, url };
    }
    const size = Number(response?.headers?.get?.("content-length"));
    return { ok: true, checked: true, status, size: Number.isFinite(size) && size > 0 ? size : null };
  } catch {
    return { ok: true, checked: false };
  } finally {
    clearTimeout(timer);
  }
}

/** The 400 body for a release whose artifact is definitely not there. */
export function artifactErrorResponse(result) {
  return {
    ok: false,
    code: result.code,
    message: `The download URL answers ${result.status}: ${result.url}. Publishing it would offer clients a file that does not exist, so it is refused. Upload the artifact first, or fix the URL.`,
  };
}
