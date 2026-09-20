import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { resolveVenvPython, getBundledPythonEnv, getRuntimeEnvExtras } = require('../src/main/runtime-python.js');
const python = process.env.LILY_TEST_PYTHON || resolveVenvPython();
if (!python) {
  console.log('skip - native XLSX recalculation requires Python and LibreOffice');
} else {
  console.log(execFileSync(python, ['scripts/test-xlsx-recalc.py'], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...process.env, ...getBundledPythonEnv(), ...getRuntimeEnvExtras() },
  }));
}
