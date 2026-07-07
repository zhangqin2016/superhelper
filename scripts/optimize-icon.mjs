#!/usr/bin/env node
/**
 * Brand app icon: remove black matte, add safe padding, colorize the lily mark,
 * and generate PNG/ICO/ICNS assets from one source.
 * Run: node scripts/optimize-icon.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 1024;
const ARTWORK_FILL = 0.9;
const CORNER_RADIUS = 190;
const BLACK_THRESHOLD = 42;

const input = path.join(root, "resources", "icon-source.png");
const outPng = path.join(root, "resources", "icon.png");
const outIcns = path.join(root, "resources", "icon.icns");
const outIco = path.join(root, "resources", "icon.ico");
const iconset = path.join(root, "resources", "icon.iconset");

if (!fs.existsSync(input)) {
  console.error("No icon source found in resources/");
  process.exit(1);
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function mixRgb(a, b, t) {
  return a.map((channel, index) => Math.round(channel + (b[index] - channel) * Math.max(0, Math.min(1, t))));
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
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

function removeBlackMatte(raw) {
  for (let i = 0; i < raw.length; i += 4) {
    const r = raw[i];
    const g = raw[i + 1];
    const b = raw[i + 2];
    if (r <= BLACK_THRESHOLD && g <= BLACK_THRESHOLD && b <= BLACK_THRESHOLD) {
      raw[i + 3] = 0;
    }
  }
}

function visibleBounds(raw, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = raw[(y * width + x) * 4 + 3];
      if (alpha <= 10) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) {
    throw new Error("Icon source has no visible artwork after background removal");
  }
  return { minX, minY, maxX, maxY };
}

function colorizeArtwork(raw, width, height) {
  const pixels = Buffer.from(raw);
  const warm = hexToRgb("#f5b451");
  const blush = hexToRgb("#ff7f86");
  const pearl = hexToRgb("#fff4d7");
  const mint = hexToRgb("#63d5bf");
  const teal = hexToRgb("#1d8a98");
  const violet = hexToRgb("#8d7cff");
  const ink = hexToRgb("#202a45");
  const leafInk = hexToRgb("#123f49");

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = pixels[offset + 3];
      if (alpha <= 10) continue;

      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const nx = width <= 1 ? 0.5 : x / (width - 1);
      const ny = height <= 1 ? 0.5 : y / (height - 1);
      const distanceFromCenter = Math.abs(nx - 0.5);
      const leafMix = Math.max(
        smoothstep(0.58, 0.78, ny),
        smoothstep(0.46, 0.72, ny) * smoothstep(0.2, 0.42, distanceFromCenter),
      );
      const side = (nx - 0.16) / 0.68;

      let petalBase = mixRgb(violet, warm, side);
      const centerGlow = smoothstep(0.32, 0.5, ny) * (1 - smoothstep(0.56, 0.66, ny));
      if (centerGlow > 0) {
        petalBase = mixRgb(petalBase, blush, centerGlow * 0.22);
      }
      if (distanceFromCenter < 0.14 && ny < 0.5) {
        petalBase = mixRgb(petalBase, warm, 0.28);
      }

      const leafBase = mixRgb(teal, mint, 0.28 + (1 - ny) * 0.2);
      const base = mixRgb(petalBase, leafBase, leafMix);
      const dark = mixRgb(ink, leafInk, leafMix);
      const high = mixRgb(pearl, hexToRgb("#d9fff2"), leafMix);
      const mid = mixRgb(dark, base, (luma - 0.12) / 0.58);
      const colored = luma > 0.68 ? mixRgb(mid, high, (luma - 0.68) / 0.32) : mid;

      pixels[offset] = colored[0];
      pixels[offset + 1] = colored[1];
      pixels[offset + 2] = colored[2];
    }
  }
  return pixels;
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

const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
removeBlackMatte(data);

const bounds = visibleBounds(data, info.width, info.height);
const trimmed = await sharp(data, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .extract({
    left: bounds.minX,
    top: bounds.minY,
    width: bounds.maxX - bounds.minX + 1,
    height: bounds.maxY - bounds.minY + 1,
  })
  .toBuffer({ resolveWithObject: true });

const maxSide = Math.max(trimmed.info.width, trimmed.info.height);
const scale = (SIZE * ARTWORK_FILL) / maxSide;
const targetW = Math.round(trimmed.info.width * scale);
const targetH = Math.round(trimmed.info.height * scale);
const coloredArtwork = colorizeArtwork(trimmed.data, trimmed.info.width, trimmed.info.height);

const flower = await sharp(coloredArtwork, {
  raw: { width: trimmed.info.width, height: trimmed.info.height, channels: 4 },
})
  .resize(targetW, targetH, {
    fit: "fill",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

const backdrop = await sharp(
  Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#172452"/>
          <stop offset="0.5" stop-color="#123f49"/>
          <stop offset="1" stop-color="#3b234e"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="35%" r="62%">
          <stop offset="0" stop-color="#2fd0c3" stop-opacity="0.32"/>
          <stop offset="0.45" stop-color="#8d7cff" stop-opacity="0.18"/>
          <stop offset="1" stop-color="#0b1026" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${SIZE}" height="${SIZE}" fill="url(#base)"/>
      <rect width="${SIZE}" height="${SIZE}" fill="url(#glow)"/>
    </svg>`,
  ),
)
  .png()
  .toBuffer();

const composed = await sharp(backdrop).composite([{ input: flower, gravity: "center" }]).png().toBuffer();

await sharp(composed)
  .composite([
    {
      input: Buffer.from(
        `<svg width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="#fff"/></svg>`,
      ),
      blend: "dest-in",
    },
  ])
  .png()
  .toFile(outPng);

fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });

const pngs = new Map();
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  pngs.set(size, await sharp(outPng).resize(size, size).png().toBuffer());
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
