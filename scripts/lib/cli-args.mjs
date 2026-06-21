// Thin wrapper over node:util parseArgs so scripts stop hand-rolling argv loops.
// Zero deps (built-in). Returns { values, positionals }; on a parse error it
// prints a one-line usage hint and exits non-zero (fail loud, not a stack trace).
//
// Usage:
//   const { values, positionals } = parseCliArgs({
//     options: { cwd: { type: "string" }, json: { type: "boolean" } },
//     usage: 'lily-headless [--cwd DIR] [--json] "prompt"',
//   });
import { parseArgs } from "node:util";

export function parseCliArgs({ options = {}, allowPositionals = true, usage = "", argv } = {}) {
  try {
    return parseArgs({
      args: argv ?? process.argv.slice(2),
      options,
      allowPositionals,
      strict: true,
    });
  } catch (error) {
    const hint = usage ? `\nusage: ${usage}` : "";
    process.stderr.write(`argument error: ${error.message}${hint}\n`);
    process.exit(2);
  }
}
