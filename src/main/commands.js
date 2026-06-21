"use strict";

/**
 * Slash commands — reusable prompt templates the user types as `/name args`.
 *
 * Format is OpenCode/Claude-compatible: a `.md` file whose body is the template
 * and whose optional frontmatter carries `description` / `argument-hint`. The
 * template supports `$ARGUMENTS` (everything after the command), `$@` (alias),
 * and `$1`…`$9` (positional). Expansion happens HERE (renderer asks via IPC) and
 * the expanded text flows through the normal send/turn pipeline — no engine
 * command endpoint, no flow change.
 *
 * Sources, lowest to highest precedence (later overrides on name collision):
 *   bundled  resources/commands/
 *   global   <userData>/commands/
 *   project  <workspace>/.opencode/command(s)/ and <workspace>/.claude/commands/
 * Each dir is scanned for .md files (one level of subfolders allowed, namespaced).
 */

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath, PROJECT_ROOT } = require("./config");

const NAME_RE = /^[a-zA-Z][\w-]*$/;

function bundledCommandsDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "resources", "commands"));
  candidates.push(path.join(PROJECT_ROOT, "resources", "commands"));
  return candidates.find((d) => safeIsDir(d)) || "";
}

function globalCommandsDir() {
  return userDataPath("commands");
}

function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Minimal `--- yaml ---` frontmatter split (description / argument-hint only). */
function parseTemplate(raw) {
  let body = String(raw || "");
  const meta = {};
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(body);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
    body = body.slice(m[0].length);
  }
  return { description: meta.description || "", argHint: meta["argument-hint"] || "", template: body.trim() };
}

/** Collect `*.md` under `dir/<sub>/` (one level of nesting allowed → namespaced). */
function scanDir(dir, into, source) {
  if (!safeIsDir(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      // one level: name becomes "<dir>:<file>" so subfolders don't collide
      const subDir = path.join(dir, ent.name);
      let subs;
      try { subs = fs.readdirSync(subDir, { withFileTypes: true }); } catch { continue; }
      for (const s of subs) {
        if (s.isFile() && s.name.endsWith(".md")) {
          addCommand(into, `${ent.name}:${s.name.slice(0, -3)}`, path.join(subDir, s.name), source);
        }
      }
      continue;
    }
    if (ent.isFile() && ent.name.endsWith(".md")) {
      addCommand(into, ent.name.slice(0, -3), path.join(dir, ent.name), source);
    }
  }
}

function addCommand(into, name, file, source) {
  if (!NAME_RE.test(name.replace(/:/g, ""))) return;
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return; }
  const parsed = parseTemplate(raw);
  if (!parsed.template) return;
  into.set(name.toLowerCase(), { name, source, ...parsed });
}

/** Load the full command set for a session's workspace (precedence applied). */
function loadCommands(workspacePath = "") {
  const map = new Map(); // lowercased name -> command (later sources overwrite)
  scanDir(bundledCommandsDir(), map, "bundled");
  scanDir(globalCommandsDir(), map, "global");
  const ws = String(workspacePath || "").trim();
  if (ws) {
    scanDir(path.join(ws, ".opencode", "command"), map, "project");
    scanDir(path.join(ws, ".opencode", "commands"), map, "project");
    scanDir(path.join(ws, ".claude", "commands"), map, "project");
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Split args respecting simple single/double quotes (for $1…$9). */
function tokenize(args) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(args))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Substitute $ARGUMENTS / $@ / $1…$9 in a template. */
function applyArgs(template, args) {
  const rest = String(args || "").trim();
  const tokens = tokenize(rest);
  return String(template)
    .replace(/\$ARGUMENTS\b/g, rest)
    .replace(/\$@/g, rest)
    .replace(/\$([1-9])/g, (_, d) => tokens[Number(d) - 1] ?? "");
}

/**
 * Expand a composer input. Returns { name, prompt } when the input is `/name …`
 * and `name` is a known command, else null (so normal text is sent unchanged).
 * @param {string} input
 * @param {Array<{name:string, template:string}>} commands
 */
function expandCommand(input, commands) {
  const text = String(input || "");
  const m = /^\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const key = m[1].toLowerCase();
  const cmd = (commands || []).find((c) => c.name.toLowerCase() === key);
  if (!cmd) return null;
  return { name: cmd.name, prompt: applyArgs(cmd.template, m[2] || "") };
}

module.exports = {
  loadCommands,
  expandCommand,
  parseTemplate,
  applyArgs,
  globalCommandsDir,
};
