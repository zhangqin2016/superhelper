// Shared assertions for scripts/test-*.mjs. Tests historically each hand-rolled
// an identical `assert` — new tests should import from here instead.
//
//   import { assert, assertEqual, finish } from "./lib/test-assert.mjs";
//   assert(cond, "message");
//   assertEqual(actual, expected, "label");
//   finish("test-my-module", 12);   // prints the PASS line the runner expects

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

export function finish(name, count) {
  console.log(count ? `PASS: ${name} (${count} tests)` : `PASS: ${name}`);
}
