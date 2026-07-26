/**
 * Route dropped files without making ordinary attachments depend on package
 * inspection. A recognized Lily package is imported only after an explicit
 * choice; everything unrecognized keeps the existing attachment behavior.
 */
export async function routeDroppedFiles(files, deps) {
  const attachments = [];
  const imports = [];
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
  return { imports, attachedCount: Number(attachedCount || 0), canceledCount };
}
