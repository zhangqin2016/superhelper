#!/usr/bin/env node
/**
 * Generate app icon assets from the final 1024x1024 source artwork.
 *
 * Source:
 *   resources/icon-source.png
 *
 * Outputs:
 *   resources/icon.png
 *   resources/icon.icns
 *   resources/icon.ico
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 1024;
const CORNER_RADIUS = 190;

const input = path.join(root, "resources", "icon-source.png");
const outPng = path.join(root, "resources", "icon.png");
const outIcns = path.join(root, "resources", "icon.icns");
const outIco = path.join(root, "resources", "icon.ico");
const iconset = path.join(root, "resources", "icon.iconset");

if (!fs.existsSync(input)) {
  console.error("No icon source found in resources/icon-source.png");
  process.exit(1);
}

function writeUInt32BE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function writeUInt32LE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function writeUInt16LE(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function writeIcns(outputPath, pngs) {
  const entries = [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ].map(([type, size]) => {
    const png = pngs.get(size);
    if (!png) throw new Error(`Missing ${size}x${size} PNG for ICNS`);
    return Buffer.concat([Buffer.from(type), writeUInt32BE(png.length + 8), png]);
  });
  const body = Buffer.concat(entries);
  fs.writeFileSync(outputPath, Buffer.concat([Buffer.from("icns"), writeUInt32BE(body.length + 8), body]));
}

function writeIco(outputPath, images) {
  const headerLength = 6 + images.length * 16;
  let offset = headerLength;
  const dirEntries = [];
  const imageBuffers = [];

  for (const { size, png } of images) {
    imageBuffers.push(png);
    dirEntries.push(
      Buffer.concat([
        Buffer.from([size >= 256 ? 0 : size, size >= 256 ? 0 : size, 0, 0]),
        writeUInt16LE(1),
        writeUInt16LE(32),
        writeUInt32LE(png.length),
        writeUInt32LE(offset),
      ]),
    );
    offset += png.length;
  }

  fs.writeFileSync(
    outputPath,
    Buffer.concat([
      writeUInt16LE(0),
      writeUInt16LE(1),
      writeUInt16LE(images.length),
      ...dirEntries,
      ...imageBuffers,
    ]),
  );
}

async function appIconPng(size) {
  const normalized = await sharp(input)
    .resize(SIZE, SIZE, {
      fit: "cover",
      position: "center",
    })
    .png()
    .toBuffer();

  const masked = await sharp(normalized)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg"><rect width="${SIZE}" height="${SIZE}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="#fff"/></svg>`,
        ),
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();

  return sharp(masked).resize(size, size).png().toBuffer();
}

await sharp(await appIconPng(SIZE)).toFile(outPng);

fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });

const pngs = new Map();
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  pngs.set(size, await appIconPng(size));
}

for (const size of [16, 32, 128, 256, 512]) {
  fs.writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), pngs.get(size));
  fs.writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), pngs.get(size * 2));
}

writeIcns(outIcns, pngs);
writeIco(
  outIco,
  [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngs.get(size) })),
);
fs.rmSync(iconset, { recursive: true, force: true });

const meta = await sharp(outPng).metadata();
console.log(`Wrote ${outPng} (${meta.width}x${meta.height}, alpha=${meta.hasAlpha})`);
console.log(`Wrote ${outIcns}`);
console.log(`Wrote ${outIco}`);
