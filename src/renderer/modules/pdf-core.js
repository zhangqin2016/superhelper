let pdfjsPromise = null;

export function fileUrlFromPath(filePath = "") {
  const value = String(filePath || "");
  if (/^(https?:|file:|blob:|data:)/i.test(value)) return value;
  if (/^[A-Za-z]:[\\/]/.test(value)) return `file:///${value.replace(/\\/g, "/")}`;
  if (value.startsWith("/")) return `file://${value}`;
  return value;
}

export function base64ToBytes(value = "") {
  const raw = atob(String(value || ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function ensureSumPrecisePolyfill() {
  if (typeof Math.sumPrecise !== "function") {
    Math.sumPrecise = (values) => {
      let sum = 0;
      for (const value of values) sum += Number(value);
      return sum;
    };
  }
}

export async function loadPdfjs() {
  ensureSumPrecisePolyfill(); // main thread
  if (!pdfjsPromise) {
    pdfjsPromise = import("../../../node_modules/pdfjs-dist/build/pdf.mjs").then((pdfjs) => {
      // Load the worker through a shim that polyfills Math.sumPrecise in the
      // worker context before pdf.worker.mjs runs.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdf-worker-shim.mjs", import.meta.url).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

// Without these, CJK text renders as garbage glyphs (no character maps) and
// scanned PDFs (JBIG2/JPEG2000) fail to decode. pdfjs-dist ships them and
// build.files packages them, so point getDocument at the bundled copies.
export function pdfResourceOptions() {
  const base = "../../../node_modules/pdfjs-dist/";
  return {
    cMapUrl: new URL(`${base}cmaps/`, import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL(`${base}standard_fonts/`, import.meta.url).href,
    wasmUrl: new URL(`${base}wasm/`, import.meta.url).href,
  };
}

export function pdfSourceFromBlock(block = {}) {
  if (block.data) return { data: base64ToBytes(block.data) };
  const url = fileUrlFromPath(block.path || block.url || "");
  return url ? { url } : null;
}
