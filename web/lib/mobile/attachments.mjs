// Phone-side image preparation for a task.
//
// Downscale an image file to fit the relay frame (256KB). Draw to a canvas at a
// bounded size, then drop JPEG quality until the base64 is small enough. Returns
// { name, mimeType, dataBase64 } or null (non-image / failure → skip attachment).
export async function fileToDownscaledAttachment(file, { maxDim = 1280, maxBytes = 170 * 1024 } = {}) {
  if (!file || !String(file.type || "").startsWith("image/")) return null;
  const dataUrl = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => resolve("");
    fr.readAsDataURL(file);
  });
  if (!dataUrl) return null;
  const img = await new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = dataUrl;
  });
  if (!img) return null;
  const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
  const w = Math.max(1, Math.round((img.width || 1) * scale));
  const h = Math.max(1, Math.round((img.height || 1) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const cctx = canvas.getContext("2d");
  if (!cctx) return null;
  cctx.drawImage(img, 0, 0, w, h);
  let q = 0.72;
  let out = "";
  for (let i = 0; i < 5; i += 1) {
    out = canvas.toDataURL("image/jpeg", q);
    if (out.length * 0.75 <= maxBytes) break; // ~decoded size
    q -= 0.15;
    if (q < 0.3) break;
  }
  const b64 = out.replace(/^data:[^,]*,/, "");
  if (!b64) return null;
  return { name: (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg", mimeType: "image/jpeg", dataBase64: b64, preview: out };
}

