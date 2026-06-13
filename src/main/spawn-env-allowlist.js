"use strict";

// Allowlist for host environment variables inherited by agent subprocesses.
// The agent gets explicit model/search/runtime variables from spawn-env; from
// the HOST environment it should only inherit platform basics. Everything
// else (cloud credentials, npm tokens, NODE_OPTIONS, loader hooks…) is
// withheld by default — the host shell's secrets are not the agent's input.

const INHERIT_KEYS = new Set([
  // POSIX basics
  "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TZ",
  // Network proxies — agent traffic should follow the user's proxy setup
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  // SSH agent socket (a path, not a command — GIT_SSH_COMMAND stays denied)
  "SSH_AUTH_SOCK",
  // Linux desktop
  "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS",
  // Windows basics
  "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT",
  "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS",
]);

const INHERIT_PREFIXES = ["LC_", "XDG_", "LILY_"];

function pickInheritedEnv(hostEnv = process.env) {
  const picked = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value == null) continue;
    if (INHERIT_KEYS.has(key) || INHERIT_PREFIXES.some((p) => key.startsWith(p))) {
      picked[key] = value;
    }
  }
  return picked;
}

module.exports = { pickInheritedEnv, INHERIT_KEYS, INHERIT_PREFIXES };
