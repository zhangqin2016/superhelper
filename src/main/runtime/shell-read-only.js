"use strict";

/**
 * Is a shell command PROVABLY read-only? Plan mode lets a model investigate
 * (list, read, search, inspect history) without changing anything, as the
 * engine's own plan agent and Claude Code's plan mode do; it used to deny every
 * shell command, so planning could not even run `ls` or `git log`.
 *
 * This proves safety instead of enumerating danger: every segment must be a
 * program known to only read, with none of its writing or executing flags, and
 * the command may not redirect, substitute, background or set variables. Any
 * doubt answers false, and the caller ASKS the user — nothing unknown is ever
 * auto-allowed by this check.
 */

// Program → flags that make it write or execute something.
const READ_ONLY_PROGRAMS = new Map([
  ["ls", []], ["pwd", []], ["cat", []], ["head", []], ["tail", []], ["wc", []],
  ["grep", []], ["egrep", []], ["fgrep", []],
  ["rg", ["--pre", "--pre-glob"]],
  ["find", ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]],
  ["stat", []], ["du", []], ["df", []], ["which", []], ["echo", []], ["date", []],
  ["basename", []], ["dirname", []], ["realpath", []], ["readlink", []],
  ["sort", ["-o", "--output"]], ["cut", []], ["tr", []], ["diff", []], ["cmp", []],
  ["tree", ["-o"]], ["jq", []], ["file", ["-C", "--compile"]],
]);

const READ_ONLY_GIT = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep",
]);

// Redirection, substitution, backgrounding, here-docs, process substitution.
const UNSAFE_SYNTAX = /[<>`]|\$\(|\$\{|(^|[^&])&($|[^&])/;

function tokens(segment) {
  return String(segment || "").trim().split(/\s+/).filter(Boolean)
    .map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function hasFlag(args, flags) {
  return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)
    || (flag.length === 2 && flag.startsWith("-") && /^-[A-Za-z]+$/.test(arg) && arg.includes(flag[1]))));
}

function segmentIsReadOnly(segment) {
  const [head, ...args] = tokens(segment);
  if (!head) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return false;
  const program = head.split("/").pop();
  if (args.some((arg) => arg.startsWith("--output"))) return false;
  if (program === "git") {
    const sub = args.find((arg) => !arg.startsWith("-"));
    return Boolean(sub) && READ_ONLY_GIT.has(sub) && !args.some((arg) => arg.startsWith("-c") || arg === "--exec-path");
  }
  if (!READ_ONLY_PROGRAMS.has(program)) return false;
  return !hasFlag(args, READ_ONLY_PROGRAMS.get(program));
}

function isProvablyReadOnlyShell(command) {
  const source = String(command || "").trim();
  if (!source || source.length > 2_000 || UNSAFE_SYNTAX.test(source)) return false;
  const segments = source.split(/&&|\|\||;|\||\n/);
  return segments.every((segment) => segmentIsReadOnly(segment));
}

module.exports = { isProvablyReadOnlyShell };
