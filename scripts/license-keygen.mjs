#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2] || "release-keys";
fs.mkdirSync(outDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

fs.writeFileSync(path.join(outDir, "license-public-key.pem"), publicKey, "utf8");
fs.writeFileSync(path.join(outDir, "license-private-key.pem"), privateKey, {
  encoding: "utf8",
  mode: 0o600,
});

console.log(`wrote ${path.join(outDir, "license-public-key.pem")}`);
console.log(`wrote ${path.join(outDir, "license-private-key.pem")}`);
