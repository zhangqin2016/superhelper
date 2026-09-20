const fs = require("node:fs");

function officeInfoCommand(command, { platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform !== "win32" || typeof command !== "string") return command;
  const match = /^(\s*(?:&\s*)?)(?:"([^"\r\n]*soffice\.exe)"|'([^'\r\n]*soffice\.exe)'|([^\s"';&|]*soffice\.exe))(?=\s+(?:--version|--help|-h)(?:\s|$|[;&|<>]))/i.exec(command);
  if (!match) return command;
  const exe = match[2] || match[3] || match[4];
  if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(exe)) return command;
  const cli = exe.replace(/\.exe$/i, ".com");
  try { if (!exists(cli)) return command; } catch { return command; }
  const quote = match[2] ? '"' : match[3] ? "'" : "";
  return match[1] + quote + cli + quote + command.slice(match[0].length);
}

module.exports = { officeInfoCommand };
