// pdf.js v6 calls Math.sumPrecise during glyph/layout math. Some Electron
// builds ship a V8 that predates it, so the worker throws "Math.sumPrecise is
// not a function" and text renders garbled. Polyfill it in the worker context
// (the main thread can't reach worker globals) before loading the real worker.
if (typeof Math.sumPrecise !== "function") {
  Math.sumPrecise = (values) => {
    let sum = 0;
    for (const value of values) sum += Number(value);
    return sum;
  };
}

import "../../../node_modules/pdfjs-dist/build/pdf.worker.mjs";
