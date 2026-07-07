export function syncNarrativeImages(root, inlineImages = [], imageKey = "") {
  if (root.dataset.imageKey === imageKey) return;
  root.dataset.imageKey = imageKey;
  root.querySelectorAll(".assistant-content-image").forEach((node) => node.remove());
  for (const image of inlineImages) {
    const img = document.createElement("img");
    img.className = "assistant-content-image";
    img.alt = image.alt || "Assistant image";
    img.src = image.src;
    root.appendChild(img);
  }
}
