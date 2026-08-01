/**
 * Route dropped files without making ordinary attachments depend on package
 * inspection. A recognized Lily package is imported only after an explicit
 * choice; everything unrecognized keeps the existing attachment behavior.
 */
export async function routeDroppedFiles(files, deps) {
  const attachments = [];
  const imports = [];
  const cardImports = [];
  let canceledCount = 0;

  for (const file of [...(files || [])].filter(Boolean)) {
    let filePath = "";
    let inspection = { ok: true, recognized: false, reason: "PATH_UNAVAILABLE" };
    try {
      filePath = await deps.resolvePath(file);
      if (filePath) inspection = await deps.inspectPath(filePath);
    } catch {
      inspection = { ok: true, recognized: false, reason: "INSPECTION_FAILED" };
    }
    // §13.2: a card candidate (JSON/PNG/APNG) is previewed through the
    // character import bridge first; if it opens the preview we are done with
    // this file, otherwise it falls through to the existing behavior.
    if (filePath && deps.previewCharacterSource && /\.(json|png|apng)$/i.test(filePath)) {
      try {
        const opened = await deps.previewCharacterSource(filePath);
        if (opened) {
          cardImports.push(filePath);
          continue;
        }
      } catch {
        /* fall through to ordinary handling */
      }
    }
    if (!inspection?.recognized) {
      attachments.push(file);
      continue;
    }

    const decision = await deps.reviewPackage(inspection);
    if (decision?.action === "attach") {
      attachments.push(file);
      continue;
    }
    if (decision?.action !== "import") {
      canceledCount += 1;
      continue;
    }
    const imported = await deps.importPackage({
      filePath,
      selectedAutomationIndexes: decision.selectedAutomationIndexes || [],
    });
    imports.push({ inspection, result: imported });
  }

  const attachedCount = attachments.length
    ? await deps.attachFiles(attachments)
    : 0;
  return { imports, cardImports, attachedCount: Number(attachedCount || 0), canceledCount };
}
