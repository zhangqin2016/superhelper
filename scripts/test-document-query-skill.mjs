#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";

const require = module.createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "resources/skills-catalog/lily-document-query/scripts/query_document_index.cjs");
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-document-query-skill-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));

if (!fs.existsSync(SCRIPT)) {
  throw new Error("lily-document-query skill script must exist");
}

const { buildDocumentQueryIndex } = require(path.join(ROOT, "src/main/document-query-index.js"));
const { persistDocumentQueryIndex } = require(path.join(ROOT, "src/main/document-query-store.js"));
persistDocumentQueryIndex({
  sessionId: "s1",
  turnId: "t1",
  createdAt: "2026-06-28T00:00:00.000Z",
  extractedPaths: ["/tmp/brief.md"],
  index: buildDocumentQueryIndex([
    {
      label: "brief.md",
      path: "/tmp/brief.md",
      text: "# Scope\nThe launch plan covers onboarding and billing.\n\n# Risks\nThe main risk is delayed payment provider approval.",
    },
  ]),
});

function runJson(args) {
  const out = execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, LILY_USER_DATA_DIR: tempUserData },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

const listed = runJson(["list"]);
if (!listed.ok || listed.documents[0]?.label !== "brief.md" || listed.chunks.length !== 2) {
  throw new Error(`list should expose the latest indexed documents and chunks: ${JSON.stringify(listed)}`);
}

const search = runJson(["search", "billing onboarding", "--limit", "2"]);
if (!search.ok || search.matches[0]?.chunkId !== "doc1-chunk1") {
  throw new Error(`search should find the relevant indexed chunk: ${JSON.stringify(search)}`);
}
if (!search.matches[0].excerpt.includes("launch plan")) {
  throw new Error(`search results should include evidence excerpts: ${JSON.stringify(search.matches[0])}`);
}

const read = runJson(["read", "doc1-chunk2"]);
if (!read.ok || read.matches[0]?.heading !== "Risks") {
  throw new Error(`read should return an exact chunk by id: ${JSON.stringify(read)}`);
}

persistDocumentQueryIndex({
  sessionId: "s2",
  turnId: "t2",
  createdAt: "2026-06-28T00:01:00.000Z",
  extractedPaths: ["/tmp/other.md"],
  index: buildDocumentQueryIndex([
    {
      label: "other.md",
      path: "/tmp/other.md",
      text: "# Scope\nThis unrelated document covers support staffing.",
    },
  ]),
});

let ambiguous = null;
try {
  runJson(["search", "billing onboarding"]);
} catch (err) {
  ambiguous = JSON.parse(err.stdout);
}
if (ambiguous?.error !== "AMBIGUOUS_SESSION" || ambiguous.sessions.length !== 2) {
  throw new Error(`multi-session search must fail loud instead of using global latest: ${JSON.stringify(ambiguous)}`);
}

const scoped = runJson(["search", "billing onboarding", "--session", "s1"]);
if (!scoped.ok || scoped.matches[0]?.documentLabel !== "brief.md") {
  throw new Error(`--session should scope search to the requested Lily session: ${JSON.stringify(scoped)}`);
}

console.log("document-query-skill: ok");
