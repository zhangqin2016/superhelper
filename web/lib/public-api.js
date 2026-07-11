const API_BASE = process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "https://lilych.lilywb.cn";

export async function publicApiGet(path) {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      return { ok: false, status: response.status, code: data?.code || "CATALOG_UNAVAILABLE", data: null };
    }
    return { ok: true, status: response.status, code: "", data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      code: error?.name === "TimeoutError" ? "CATALOG_TIMEOUT" : "CATALOG_UNAVAILABLE",
      data: null,
    };
  }
}
