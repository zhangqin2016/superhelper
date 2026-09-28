#!/usr/bin/env node
/**
 * Upload one file to a Qiniu bucket and prove it arrived intact. No
 * dependencies (the backup host has no qshell).
 *
 *   QINIU_ACCESS_KEY=… QINIU_SECRET_KEY=… node qiniu-put.mjs \
 *     --bucket B --key K --file F [--upload-url URL] [--delete-after-days N]
 *
 * The upload token is scoped to exactly this key and insert-only, so a backup
 * can never overwrite an earlier one; `deleteAfterDays` lets Qiniu expire it.
 * Success means Qiniu's returned hash equals the file's etag computed here.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLOCK = 4 * 1024 * 1024;

export function urlsafeBase64(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Qiniu's etag: sha1 per 4 MB block, prefixed 0x16 for one block, else 0x96 over the block digests. */
export function qiniuEtag(buffer) {
  const blocks = [];
  for (let offset = 0; offset < buffer.length || blocks.length === 0; offset += BLOCK) {
    blocks.push(crypto.createHash("sha1").update(buffer.subarray(offset, offset + BLOCK)).digest());
    if (buffer.length === 0) break;
  }
  if (blocks.length === 1) return urlsafeBase64(Buffer.concat([Buffer.from([0x16]), blocks[0]]));
  const digest = crypto.createHash("sha1").update(Buffer.concat(blocks)).digest();
  return urlsafeBase64(Buffer.concat([Buffer.from([0x96]), digest]));
}

export function uploadToken({ accessKey, secretKey, bucket, key, deleteAfterDays = 0, now = Date.now() }) {
  const policy = { scope: `${bucket}:${key}`, deadline: Math.floor(now / 1000) + 3600, insertOnly: 1 };
  if (deleteAfterDays > 0) policy.deleteAfterDays = deleteAfterDays;
  const encodedPolicy = urlsafeBase64(JSON.stringify(policy));
  const sign = urlsafeBase64(crypto.createHmac("sha1", secretKey).update(encodedPolicy).digest());
  return `${accessKey}:${sign}:${encodedPolicy}`;
}

export async function putFile({ accessKey, secretKey, bucket, key, file, uploadUrl = "https://up-z0.qiniup.com", deleteAfterDays = 0, fetchImpl = fetch }) {
  const bytes = fs.readFileSync(file);
  const etag = qiniuEtag(bytes);
  const form = new FormData();
  form.append("token", uploadToken({ accessKey, secretKey, bucket, key, deleteAfterDays }));
  form.append("key", key);
  form.append("file", new Blob([bytes]), path.basename(file));
  const response = await fetchImpl(uploadUrl, { method: "POST", body: form });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`upload ${key}: HTTP ${response.status} ${body.error || ""}`.trim());
  if (body.hash !== etag) throw new Error(`upload ${key}: Qiniu hash ${body.hash} does not match local etag ${etag}`);
  return { key: body.key || key, etag, bytes: bytes.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (name, fallback = "") => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
  const accessKey = process.env.QINIU_ACCESS_KEY || "";
  const secretKey = process.env.QINIU_SECRET_KEY || "";
  const options = { accessKey, secretKey, bucket: arg("--bucket"), key: arg("--key"), file: arg("--file"),
    uploadUrl: arg("--upload-url", "https://up-z0.qiniup.com"), deleteAfterDays: Number(arg("--delete-after-days", "0")) || 0 };
  if (!accessKey || !secretKey || !options.bucket || !options.key || !options.file) {
    console.error("usage: QINIU_ACCESS_KEY=… QINIU_SECRET_KEY=… node qiniu-put.mjs --bucket B --key K --file F [--upload-url U] [--delete-after-days N]");
    process.exit(2);
  }
  putFile(options).then((result) => console.log(JSON.stringify(result)), (error) => { console.error(String(error?.message || error)); process.exit(1); });
}
