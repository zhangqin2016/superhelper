# Universal Local Path Attachments

## Goal

Lily accepts any readable local regular file or directory from drag and drop,
clipboard paths, and the attachment picker. Known small files keep their current
fast path. Large files, directories, archives, and unknown formats remain local
path references and are analyzed through bounded local tools.

## Product Contract

- A regular file is never rejected only because its extension is unknown.
- A directory is a first-class attachment.
- Path-backed inputs are not copied when they are large, directories, archives,
  or unknown formats.
- Pathless clipboard buffers retain the existing allow-list and size cap because
  Lily has no stable local source path to fall back to.
- Raw unknown binaries, archives, Office files, PDFs, and directories are never
  uploaded as model file parts by default.
- The model receives the exact live source path and must try local inspection
  before asking the user to re-upload or install software.
- Missing paths, unreadable paths, unsupported special filesystem objects,
  encrypted archive entries, and unavailable bundled extractors fail explicitly.

## Architecture

### Attachment admission

`FileStagingManager.stageFromPath` classifies the filesystem object rather than
using an extension allow-list as an admission gate.

- Known files up to 20 MiB retain the existing staged-copy behavior.
- Known files above 20 MiB retain the existing in-place behavior.
- Unknown files and archives are always in-place path-only attachments.
- Directories are always in-place path-only attachments.
- Sockets, devices, and FIFOs remain rejected.

Metadata includes `kind`, `isDirectory`, `pathOnly`, `readable`, `extension`,
and the existing fields. The renderer preserves these fields when dispatching a
turn.

### Bounded directory analysis

Directory inspection and indexing are breadth-first and deterministic. Traversal
has independent bounds for files, visited entries, and depth; skips generated
dependency/build directories; does not follow symbolic-link directories; and
deduplicates real paths. A partial traversal reports sampled coverage instead of
claiming completeness.

### Archive intelligence

Archives are recognized by compound extension, including ZIP, 7z, RAR, TAR,
TGZ/TAR.GZ, GZ, BZ2, and XZ. Lily uses the packaged `7zip-bin` executable, so
normal archive analysis does not depend on a system installation.

Archive inspection lists entries without extracting them. It is bounded by
timeout, process output, entry count, and declared uncompressed size. Results
identify encrypted entries, unsafe absolute/parent paths, total packed and
unpacked sizes, and suspicious expansion ratios.

The Agent receives two local operations:

- `list_archive`: inspect a bounded manifest and safety summary.
- `read_archive_entry`: stream one exact, safe, non-directory entry to memory,
  with declared-size, output-size, timeout, and binary checks.

No operation writes archive contents to the workspace. Archive indexing stores
manifest evidence so the Agent can search filenames first and then read only
relevant entries.

### Agent message contract

The attachment index distinguishes `file` and `directory`, reports current
readability, and instructs the Agent to use `lily_file_intelligence`. Directory
and path-only attachments generate a local-analysis note and no raw model file
part. Existing document extraction and native image behavior are unchanged.

## Failure And Recovery

- Archive tool unavailable: return `ARCHIVE_TOOL_UNAVAILABLE` with the expected
  bundled dependency (`7zip-bin`); ordinary path attachment still succeeds.
- Corrupt/unsupported archive: return `ARCHIVE_LIST_FAILED` with bounded detail;
  the Agent may use other local tools.
- Encrypted entry: return `ARCHIVE_ENTRY_ENCRYPTED`; do not prompt for or guess a
  password automatically.
- Unsafe entry path: list it as unsafe but refuse to read it.
- Oversized entry/output: return a precise limit error without partial content.
- Any attachment-index formatting failure falls back to the existing source-path
  behavior.

## Verification

Automated coverage must prove:

1. Unknown files and directories stage as path-only references.
2. Known small/large files keep their existing copy/reference behavior.
3. Pathless unsupported buffers are still rejected.
4. Clipboard paths include files and directories.
5. ZIP manifests and text entries are inspected without extraction.
6. Unsafe, encrypted, binary, and oversized archive entries are rejected.
7. Directory traversal is bounded and symlink-safe.
8. Archive metadata is searchable through the local index.
9. Message parts expose exact paths but never upload directories/archives.
10. Existing workspace-package detection remains fail-open to ordinary attachment.
