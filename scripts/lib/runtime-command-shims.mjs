import fs from "node:fs";
import path from "node:path";

export function writeRuntimeCommandShims(runtimeRoot, platform) {
  const binDir = path.join(runtimeRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  if (platform === "win32-x64") {
    // The relocatable base Python and venv Scripts directories are added to PATH.
    // A batch file named *.exe is not executable on Windows, so remove artifacts
    // produced by older builds and let command lookup reach the real interpreter.
    for (const name of ["python.exe", "python3.exe"]) {
      fs.rmSync(path.join(binDir, name), { force: true });
    }
    return;
  }

  const content = [
    "#!/bin/sh",
    'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'exec "$DIR/../venv/bin/python3" "$@"',
    "",
  ].join("\n");
  for (const name of ["python", "python3"]) {
    const shimPath = path.join(binDir, name);
    fs.writeFileSync(shimPath, content);
    fs.chmodSync(shimPath, 0o755);
  }
}
