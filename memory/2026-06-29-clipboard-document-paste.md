# Clipboard Document Paste

## Debug Report

- Symptom: users paste/copy a document through the clipboard and then ask about
  it, but the assistant may behave as if it did not read the document.
- Root cause:
  1. Renderer paste handling only trusted Web `ClipboardEvent` files. Native
     desktop file copies can live in Electron/system clipboard formats such as
     file URL, bookmark, `FileNameW`, or `NSFilenamesPboardType`, so no pending
     attachment was created.
  2. When a document attachment existed but extraction failed, `send-preflight`
     could continue with text plus the original file. On the OpenCode path large
     files may then be skipped by inline limits, producing a blind answer.
- Fix:
  - Add main-process clipboard file extraction and staging fallback.
  - Route prompt-input paste through that fallback before normal text insertion.
  - Make document extraction failures fail loud whenever document files are in
    the turn, matching the screenshot/vision fail-loud behavior.
  - Add i18n toast for files staged from clipboard.
- Regression tests:
  - `scripts/test-clipboard-file-paste.mjs`
  - `scripts/test-send-preflight.mjs`

Important: keep document extraction as the authoritative path for document
questions. If it cannot extract, do not let the model invent an answer from only
the user's prompt or a skipped large file.
