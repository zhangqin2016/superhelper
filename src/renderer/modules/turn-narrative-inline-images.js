function inlineImageSrc(block = {}) {
  const data = String(block.data || "");
  if (/^(app-blob:|data:|https?:|file:|blob:)/i.test(data)) return data;
  return `data:${block.mediaType || block.mimeType || "image/png"};base64,${data}`;
}

export function inlineImageKeyForContentBlocks(contentBlocks = []) {
  return contentBlocks
    .filter((block) => block?.blockType === "image" && block.data)
    .map((block) => `${block.mediaType || "image/png"}:${String(block.data || "").length}`)
    .join("|");
}

export function inlineImagesForNarrative(contentBlocks = []) {
  return contentBlocks
    .filter((block) => block?.blockType === "image" && block.data)
    .map((block) => ({
      src: inlineImageSrc(block),
      alt: block.alt || "",
    }));
}
