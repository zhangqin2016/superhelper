# Live File Authority

## Failure

A user could modify a file after Lily created or attached it, then ask Lily to
continue. Removed content could return because three historical copies remained:

- OpenCode retained the old `write`/`edit` tool input in model history.
- Small attachments used an immutable staging copy even while `sourcePath`
  remained readable and newer.
- Workspace-index freshness checked only whether the source still existed, not
  whether its contents changed.

The filesystem must be the source of truth. History and indexes are provenance
and caches, never authoritative file bodies.

## Invariants

- A readable attachment `sourcePath` outranks its staged copy. The staged copy is
  used only when the original is unavailable.
- Document, vision, and model-message preflight resolve the same live path.
- Auto-index source stamps include mtime, size, and a content hash for bounded
  text files. A fingerprint mismatch drops and evicts old excerpts before they
  can enter model context.
- Historical mutation bodies are removed from model-bound history only when
  they conflict with a live file. Missing files keep history for recovery;
  byte-identical writes stay intact.
- Before modifying an existing stale/unobserved file, the OpenCode plugin
  requires a successful live read. Successful reads and writes record the
  current fingerprint; an external edit changes it and re-arms the gate.
- Every guard fails open on ambiguous filesystem errors. Kill switches preserve
  the old path for emergency diagnosis.

## Guards

- `scripts/test-live-file-history-guard.mjs`
- `scripts/test-opencode-message-parts.mjs`
- `scripts/test-document-translator.mjs`
- `scripts/test-workspace-index-freshness.mjs`
