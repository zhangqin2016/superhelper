#!/usr/bin/env node
/**
 * macOS-friendly app icon: remove black matte, add safe padding, dark app-tinted backdrop.
 * Run: node scripts/optimize-icon.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 1024;
/** How much of the canvas the trimmed artwork should fill (macOS squircle safe zone ~85–90%). */
const ARTWORK_FILL = 0.90;
const BLACK_THRESHOLD = 42;

const sources = [path.join(root, "resources", "icon-source.png")];
const input = sources.find((p) => fs.existsSync(p));
if (!input) {
  console.error("No icon source found in resources/");
  process.exit(1);
}

const outPng = path.join(root, "resources", "icon.png");
const outIcns = path.join(root, "resources", "icon.icns");

const { data, info } = await sharp(input)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

for (let i = 0; i < data.length; i += 4) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  if (r <= BLACK_THRESHOLD && g <= BLACK_THRESHOLD && b <= BLACK_THRESHOLD) {
    data[i + 3] = 0;
  }
}

const trimmed = await sharp(data, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .trim({ threshold: 10 })
  .toBuffer({ resolveWithObject: true });

const maxSide = Math.max(trimmed.info.width, trimmed.info.height);
const scale = (SIZE * ARTWORK_FILL) / maxSide;
const targetW = Math.round(trimmed.info.width * scale);
const targetH = Math.round(trimmed.info.height * scale);

const flower = await sharp(trimmed.data, {
  raw: { width: trimmed.info.width, height: trimmed.info.height, channels: 4 },
})
  .resize(targetW, targetH, {
    fit: "fill",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

// Subtle dark backdrop (matches app shell) — Dock still applies squircle mask.
const backdrop = await sharp({
  create: {
    width: SIZE,
    height: SIZE,
    channels: 4,
    background: { r: 22, g: 25, b: 36, alpha: 1 },
  },
})
  .png()
  .toBuffer();

await sharp(backdrop)
  .composite([{ input: flower, gravity: "center" }])
  .png()
  .toFile(outPng);

const iconset = path.join(root, "resources", "icon.iconset");
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });

const sizes = [16, 32, 128, 256, 512];
for (const size of sizes) {
  const base = path.join(iconset, `icon_${size}x${size}.png`);
  const retina = path.join(iconset, `icon_${size}x${size}@2x.png`);
  await sharp(outPng).resize(size, size).png().toFile(base);
  await sharp(outPng)
    .resize(size * 2, size * 2)
    .png()
    .toFile(retina);
}

const { execFileSync } = await import("node:child_process");
execFileSync("iconutil", ["-c", "icns", iconset, "-o", outIcns]);
fs.rmSync(iconset, { recursive: true, force: true });

const meta = await sharp(outPng).metadata();
console.log(`Wrote ${outPng} (${meta.width}x${meta.height}, alpha=${meta.hasAlpha})`);
console.log(`Wrote ${outIcns}`);
