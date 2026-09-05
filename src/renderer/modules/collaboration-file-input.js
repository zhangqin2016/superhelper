/** Own only file gestures in the IM surface. Ordinary text paste is untouched. */
export function initCollaborationFileInput({ dropTarget, pasteTarget, enabled = () => false, receive = () => {} } = {}) {
  let depth = 0;
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes("Files");
  const clear = () => { depth = 0; dropTarget?.classList.remove("is-file-dragging"); };
  const enter = event => { if (!hasFiles(event)) return; event.preventDefault(); event.stopPropagation(); if (enabled()) { depth++; dropTarget.classList.add("is-file-dragging"); } };
  const over = event => { if (!hasFiles(event)) return; event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = enabled() ? "copy" : "none"; };
  const leave = event => { if (!hasFiles(event)) return; event.stopPropagation(); if (--depth <= 0) clear(); };
  const drop = event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); event.stopPropagation(); clear();
    if (enabled()) void receive(Array.from(event.dataTransfer.files || []), "drop");
  };
  const paste = event => {
    const files = Array.from(event.clipboardData?.files || []).filter(file => /^image\/(png|jpeg|webp)$/.test(file.type));
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    if (enabled()) void receive(files, "paste");
  };
  for (const [name, handler] of [["dragenter",enter],["dragover",over],["dragleave",leave],["drop",drop]]) dropTarget?.addEventListener(name,handler,true);
  pasteTarget?.addEventListener("paste",paste,true);
  return { clear, destroy() { clear(); for (const [name, handler] of [["dragenter",enter],["dragover",over],["dragleave",leave],["drop",drop]]) dropTarget?.removeEventListener(name,handler,true); pasteTarget?.removeEventListener("paste",paste,true); } };
}
