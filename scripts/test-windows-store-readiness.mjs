import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerBytes = await readFile(path.join(root, "scripts", "smoke-windows-store-installer.ps1"));

assert.deepEqual([...runnerBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

const runner = runnerBytes.subarray(3).toString("utf8");

assert.match(runner, /Set-StrictMode -Version Latest/);
assert.match(runner, /\$Installer\b/);
assert.match(runner, /\$OutputDirectory\b/);
assert.match(runner, /\$ExpectedPublisher\b/);
assert.match(runner, /\$ExpectedVersion\b/);
assert.match(runner, /\$RequireSignature\b/);
assert.match(runner, /\$AllowUserDataRemnants\b/);
assert.match(runner, /\$InstallTimeoutSeconds\b/);
assert.match(runner, /\$LaunchTimeoutSeconds\b/);
assert.match(runner, /\$UninstallTimeoutSeconds\b/);
assert.match(runner, /\bpass\b/);
assert.match(runner, /\bwarning\b/);
assert.match(runner, /\bfail\b/);
assert.match(runner, /\bnot_applicable\b/);
const requireCheckMatch = runner.match(/function Require-Check \{([\s\S]*?)\n\}\n\nfunction Write-Reports/);
assert.ok(requireCheckMatch, "Require-Check must remain a standalone helper.");
const requireCheckSuccessBranch = requireCheckMatch[1].match(/if \(\$Condition\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
assert.match(requireCheckSuccessBranch, /Add-Check[^\r\n]*-Status "pass"/);
assert.match(requireCheckSuccessBranch, /\breturn\b/);
assert.match(runner, /readiness-report\.json/);
assert.match(runner, /readiness-summary\.md/);
assert.match(runner, /readiness-transcript\.log/);
assert.match(runner, /readiness-exit-code\.txt/);
assert.match(runner, /ConvertTo-Json -Depth 8/);
assert.match(runner, /exit \$exitCode\s*$/);

console.log("windows store readiness contracts ok");
