import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as pluginExports from "../resources/opencode-plugins/windows-office-cli.js";
import officeCli from "../resources/opencode-plugins/lib/windows-office-cli.cjs";
const { officeInfoCommand } = officeCli;
const { WindowsOfficeCliPlugin } = pluginExports;
for (const factory of new Set(Object.values(pluginExports))) {
  const loaded = await factory({});
  assert.equal(typeof loaded?.["tool.execute.before"], "function");
}

const exe = "C:\\Program Files\\LibreOffice\\program\\soffice.exe";
const cli = exe.replace(/exe$/, "com");
const command = `& "${exe}" --version 2>&1 | Out-String`;
const options = { platform: "win32", exists: (p) => p === cli };
assert.equal(officeInfoCommand(command, options), command.replace("soffice.exe", "soffice.com"));
for (const suffix of ['; Write-Output "exit=$LASTEXITCODE"', '| Out-String', '2>&1', '&& echo done']) {
  const compact = `& "${exe}" --version${suffix}`;
  const expected = suffix.startsWith('2') ? compact : compact.replace('soffice.exe', 'soffice.com');
  assert.equal(officeInfoCommand(compact, options), expected);
}
assert.equal(officeInfoCommand(command, { ...options, platform: "darwin" }), command);
assert.equal(officeInfoCommand(command, { ...options, exists: () => false }), command);
assert.equal(officeInfoCommand(command, { ...options, exists: () => { throw new Error(); } }), command);
for (const untouched of [
  `& "${exe}" --headless --convert-to pdf file.docx`,
  `& "${exe}" --print-to-file file.docx`,
  `Write-Output '${exe} --version'`,
  '& $exe --version',
  'soffice.exe --version',
  `& "${exe}" --version-extra`,
  null,
]) assert.equal(officeInfoCommand(untouched, options), untouched);
const hooks = await WindowsOfficeCliPlugin();
const output = { args: { command } };
await hooks["tool.execute.before"]({ tool: "write" }, output);
assert.equal(output.args.command, command);
if (process.platform === "win32" && fs.existsSync(cli)) {
  await hooks["tool.execute.before"]({ tool: "bash" }, output);
  assert.equal(output.args.command, command.replace("soffice.exe", "soffice.com"));
  const version = execFileSync(cli, ["--version"], { windowsHide: true, encoding: "utf8", timeout: 15000 });
  assert.match(version, /LibreOffice\s+\d/);
  console.log("native LibreOffice CLI version probe passed without an interactive launcher");
} else console.log("SKIP native Windows LibreOffice probe");
console.log("windows-office-cli: passed");
