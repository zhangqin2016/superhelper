// Just enough ZIP to read Alipay's statement archive: walk the central
// directory, inflate each (stored or deflated) entry. No dependency.

import zlib from "node:zlib";

export function readZipEntries(buffer) {
  const buf = Buffer.from(buffer);
  // End of central directory record, scanning back over a possible comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error("ZIP_INVALID"), { code: "ZIP_INVALID" });
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLength);
    // Alipay names its files in GBK unless the UTF-8 flag (bit 11) is set.
    const utf8 = (buf.readUInt16LE(p + 8) & 0x0800) !== 0;
    const name = new TextDecoder(utf8 ? "utf-8" : "gbk").decode(nameBytes);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(start, start + compressedSize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (data) entries.push({ name, data });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
