import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { resolveSystemOfficeDir } = require("../src/main/runtime-system-office");
const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" };
assert.equal(resolveSystemOfficeDir({ platform: "linux", env, exists: () => true }), null);
assert.equal(resolveSystemOfficeDir({ platform: "win32", env, exists: () => false }), null);
const program = "C:\\Program Files\\LibreOffice\\program";
assert.equal(resolveSystemOfficeDir({ platform: "win32", env, exists: value => value === `${program}\\soffice.exe` }), program);
if (process.platform === "win32") {
  const { getRuntimePathEntries, getRuntimeEnvExtras, resolveBundledRuntimeRoot, resolveRuntimePythonAtRoot } = require("../src/main/runtime-python");
  const office = getRuntimeEnvExtras().LILY_LIBREOFFICE_PROGRAM;
  if (office) {
    assert.equal(getRuntimeEnvExtras().SAL_DISABLE_PRINTERLIST, "1");
    assert.equal(getRuntimeEnvExtras().SAL_DISABLE_DEFAULTPRINTER, "1");
    const entries = getRuntimePathEntries();
    const root = resolveBundledRuntimeRoot();
    if (root) {
      const path = require("node:path");
      assert.ok(entries.indexOf(office) < entries.indexOf(path.join(root, "bin")), "office precedes stale bin shim");
      const python = resolveRuntimePythonAtRoot(root);
      if (python) assert.ok(entries.indexOf(path.dirname(python)) < entries.indexOf(office), "Office's private Python cannot shadow Lily Python");
    }
  }
}
console.log("system office: real executable discovery, PATH precedence and absence passed");
