const ATTACHMENT_FIELDS = [
  "id", "name", "path", "sourcePath", "staged", "pathOnly", "readable",
  "kind", "isDirectory", "extension", "type", "size", "isImage", "dimensions",
];

export function attachmentSendPayload(file = {}) {
  const payload = {};
  for (const field of ATTACHMENT_FIELDS) {
    if (file[field] !== undefined) payload[field] = file[field];
  }
  return payload;
}

export function attachmentDisplayPayload(file = {}, pending = null) {
  const payload = attachmentSendPayload({ ...file, ...(pending || {}) });
  payload.thumbnail = payload.isImage ? pending?.thumbnail || null : null;
  return payload;
}
