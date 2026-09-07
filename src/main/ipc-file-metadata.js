"use strict";

function fileMetadataFromPayload(files = []) {
  return (files || []).filter(Boolean).map((f) => ({
    id: f.id,
    name: f.name,
    path: f.path,
    sourcePath: f.sourcePath,
    staged: f.staged,
    pathOnly: f.pathOnly,
    readable: f.readable,
    kind: f.kind,
    isDirectory: f.isDirectory,
    extension: f.extension,
    type: f.type,
    size: f.size,
    isImage: f.isImage,
    dimensions: f.dimensions,
    thumbnail: f.thumbnail || null,
  }));
}

function fileMetadataKeys(file) {
  if (!file || typeof file !== "object") return [];
  return [file.id, file.path, file.sourcePath, file.name].filter(Boolean);
}

function findSourceFileMetadata(byKey, display) {
  for (const key of fileMetadataKeys(display)) {
    if (byKey.has(key)) return byKey.get(key);
  }
  return null;
}

function mergeDisplayFileMetadata(sourceFiles = [], displayFiles = null) {
  const sourceMeta = fileMetadataFromPayload(sourceFiles);
  const byKey = new Map();
  for (const file of sourceMeta) {
    for (const key of fileMetadataKeys(file)) {
      byKey.set(key, file);
    }
  }
  if (!Array.isArray(displayFiles)) return sourceMeta;
  return displayFiles.filter(Boolean).map((display) => {
    const source = findSourceFileMetadata(byKey, display);
    return {
      ...(source || {}),
      ...display,
      path: display.path || source?.path,
      sourcePath: display.sourcePath || source?.sourcePath,
      staged: display.staged ?? source?.staged,
      pathOnly: display.pathOnly ?? source?.pathOnly,
      readable: display.readable ?? source?.readable,
      kind: display.kind || source?.kind,
      isDirectory: display.isDirectory ?? source?.isDirectory,
      extension: display.extension || source?.extension,
      type: display.type || source?.type,
      size: display.size ?? source?.size,
      isImage: display.isImage ?? source?.isImage,
      dimensions: display.dimensions || source?.dimensions,
      thumbnail: display.thumbnail || source?.thumbnail || null,
    };
  });
}

module.exports = { fileMetadataFromPayload, mergeDisplayFileMetadata };
