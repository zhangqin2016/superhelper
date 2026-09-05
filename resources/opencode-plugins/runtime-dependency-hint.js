// Advisory only: preserve the failed tool output and leave authorization to the broker.
const EXECUTABLE_PACKS = { ffmpeg: "ffmpeg", ffprobe: "ffmpeg", git: "git", pandoc: "pandoc", soffice: "libreoffice", libreoffice: "libreoffice" };
const MODULE_PACKS = {
  docling: "pro-pdf", fitz: "large-document", pikepdf: "large-document", python_calamine: "large-document",
  duckdb: "large-document", pyarrow: "large-document", polars: "large-document", ijson: "large-document",
  orjson: "large-document", zstandard: "large-document", PIL: "pillow", cv2: "opencv",
  rapidocr_onnxruntime: "rapidocr", rembg: "rembg",
};
function ownPack(mapping, name) { return Object.hasOwn(mapping, name) ? mapping[name] : null; }
function missingPack(text) {
  // Require diagnostics at line boundaries. Generic ImportError, missing inputs,
  // submodule/version incompatibilities and prose mentioning errors are not rescue signals.
  const module = text.match(/^ModuleNotFoundError: No module named ['"]([\w]+)['"]\s*$/m);
  if (module && /^Traceback \(most recent call last\):\s*$/m.test(text)) return ownPack(MODULE_PACKS, module[1]);
  const shell = text.match(/^(?:(?:\/[^\s:]+\/)?(?:ba|z|da)?sh: (?:(?:line )?\d+: )?)(?:command not found: )?([\w-]+)(?:: (?:command not found|not found))?\s*$/m);
  if (shell && /command not found|: not found/.test(shell[0])) return ownPack(EXECUTABLE_PACKS, shell[1]);
  // spawn ENOENT is ambiguous: a missing cwd produces the same error.
  const cmd = text.match(/^'([\w-]+)' is not recognized as an internal or external command,\s*operable program or batch file\.\s*$/m);
  if (cmd) return ownPack(EXECUTABLE_PACKS, cmd[1]);
  const powershell = text.match(/^([\w-]+)\s*:\s*The term '\1' is not recognized as (?:the|a) name of a cmdlet, function, script file, or\s+(?:operable|executable) program\.\s*$/m);
  if (powershell) return ownPack(EXECUTABLE_PACKS, powershell[1]);
  if (/^Error: Cannot find module ['"]playwright['"]\s*$/m.test(text)
      && /^\s*code: ['"]MODULE_NOT_FOUND['"],?\s*$/m.test(text)
      && /^Require stack:\s*$/m.test(text)) return "web-automation";
  return null;
}
export const RuntimeDependencyHint = async () => {
  const sessions = new Map();
  return {
    event: async ({ event } = {}) => {
      try { if (event?.type === "session.deleted") sessions.delete(event.properties?.info?.id); } catch {}
    },
    "tool.execute.after": async (input, output) => {
      try {
        if (process.env.LILY_RUNTIME_DEP_HINT === "0" || input?.tool !== "bash" || typeof output?.output !== "string") return;
        const exit = output.metadata?.exit;
        // OpenCode supplies exit metadata. Never turn successful printed examples
        // into dependency advice, or infer failure from untrusted text alone.
        if (!Number.isInteger(exit)) return;
        const session = typeof input.sessionID === "string" && input.sessionID ? input.sessionID : null;
        const command = typeof input.args?.command === "string" ? input.args.command : "";
        if (exit === 0) {
          const seen = session && sessions.get(session);
          if (command && seen) for (const [pack, failedCommand] of seen) {
            if (failedCommand && (failedCommand === command || command.endsWith(` ${failedCommand}`))) seen.delete(pack);
          }
          return;
        }
        if (/ModuleNotFoundError|MODULE_NOT_FOUND|Cannot find module|command not found|not recognized|spawn \w+ ENOENT/.test(command) || /^\s*(?:cat|head|tail|rg|grep|echo|printf)\s/.test(command)) return;
        if (output.output.length > 128 * 1024) return;
        const pack = missingPack(output.output);
        if (!pack) return;
        let seen = session && sessions.get(session);
        if (seen?.has(pack)) return;
        if (session) {
          if (!seen) seen = new Map();
          seen.set(pack, command);
          sessions.delete(session);
          sessions.set(session, seen);
          if (sessions.size > 256) sessions.delete(sessions.keys().next().value);
        }
        output.output += `\n\n[runtime-dependency] 检测到缺失依赖，请先检查托管运行包。Missing dependency may be supplied by Lily pack "${pack}". Call runtime_pack_list with packId="${pack}" to inspect installation progress/status; use verify=true for targeted health once installation is idle. If missing, start background runtime_pack_install respecting existing permissions. For an unhealthy installed pack, use repair=true only when repairSupported is true; if unsupported (such as a bundled read-only pack), report repairLimitation and retain the failed operation instead of repeating install. Observe runtime_pack_list until completion or a reported terminal error; continuing download/extraction/health progress is not a reason to abort. After successful health verification, use its resolved managed interpreter and environment (PATH/PYTHONPATH) explicitly in the current shell, then retry only the failed operation and verify its result. Do not replay the whole task, install automatically outside the broker, restart a busy shared server, or silently substitute a weaker workaround. If preparation fails, retain this error and explain the remaining limitation.\n`;
      } catch { /* fail open: original output remains useful */ }
    },
  };
};
