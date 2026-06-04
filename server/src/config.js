import dotenv from "dotenv";

dotenv.config();

function pemEnv(name) {
  const b64 = process.env[`${name}_B64`];
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  return String(process.env[name] || "").replace(/\\n/g, "\n");
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || "",
  adminEmail: process.env.ADMIN_EMAIL || "admin@example.com",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminToken: process.env.ADMIN_TOKEN || "",
  sessionSecret: process.env.SESSION_SECRET || "development-session-secret-change-me",
  licensePrivateKey: pemEnv("LICENSE_PRIVATE_KEY"),
  licensePublicKey: pemEnv("LICENSE_PUBLIC_KEY"),
  allowUnsignedLicenses: process.env.ALLOW_UNSIGNED_LICENSES === "true",
  qiniuPublicBaseUrl: process.env.QINIU_PUBLIC_BASE_URL || "https://qny.lanrensoft.cn",
};

export function requireDatabaseUrl() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
}
