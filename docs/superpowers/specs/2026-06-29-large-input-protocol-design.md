# Large Input Protocol Design

## Goal

Lily should handle large files and large directories through a general protocol and tool layer, not PDF-specific hardcoded flows. The agent remains responsible for choosing the right analysis strategy. Lily provides reliable inspection, extraction, indexing, retrieval, progress, and evidence tools so OpenCode can make better decisions without stuffing huge inputs into model context.

Success means a user can ask Lily to analyze a large PDF, spreadsheet, log, document, image folder, or mixed workspace directory and get a grounded answer with clear source references. Failure must degrade to today's capabilities: the agent can still sample, ask for a narrower range, or use ordinary file tools. A failed new protocol must never make Lily less capable than the current OpenCode flow.

## Non-Goals

- Do not fork or replace OpenCode's agent loop, session model, permissions, MCP support, subagents, or compaction.
- Do not create a rigid "large PDF flow" or fixed chunk-size workflow that ignores user intent.
- Do not add a UI-heavy document management panel. Operations remain natural-language driven.
- Do not silently sample or truncate while claiming a full-file analysis.
- Do not install heavy runtime packs automatically.

## OpenCode Boundary

OpenCode remains the execution runtime:

- Lily continues to send turns through OpenCode `promptAsync`.
- OpenCode continues to own the agent loop, tool calls, subagents, permissions, session history, event stream, and native compaction.
- Lily adds capability through the existing OpenCode extension surfaces: MCP servers, plugin hooks, per-turn guidance, skill guidance, and local files/indexes.

The design adds one product-layer capability: a Lily File Intelligence MCP plus a short Large Input Protocol instruction set. This is not a second runtime. It is a better set of tools and rules for the existing OpenCode agent.

## Protocol

When the agent encounters a large file, large directory, unknown binary, scanned document, or input likely to exceed the model context, it must follow this protocol:

1. Inspect before reading.
2. Choose a strategy based on the user's goal.
3. Use range-based extraction, sampling, indexing, retrieval, or chunk summarization instead of direct full-context reads.
4. Persist intermediate artifacts when work is long-running or reusable.
5. Cite source locations for material claims.
6. State coverage honestly: full analysis, sampled analysis, indexed retrieval, or partial result.
7. Fail open: if the protocol tool is unavailable or a job fails, continue with today's ordinary tools and explain the limitation.

The protocol forbids only dangerous behavior: direct blind ingestion of large inputs, silent truncation, and unsupported claims of full coverage. It does not force a business workflow.

## Trigger Heuristics

Triggers are hints, not final decisions. Any matching condition should cause the agent to inspect first:

- File larger than 20 MB.
- PDF or presentation over 50 pages.
- CSV, TSV, JSONL, or log over 100,000 lines.
- Extracted text likely above 200,000 characters.
- Directory over 200 files or containing multiple large files.
- Office workbook with many sheets or very large sheets.
- PDF pages with little or no text layer.
- Image directory or image-heavy document.
- Repeated model connection/context failures on the same file task.

The agent may still choose a quick sample, full index, targeted extraction, or user clarification depending on the task.

## Lily File Intelligence MCP

Add a local MCP server exposed to OpenCode as `lily-file-intelligence`. Its tools are deterministic and return compact structured results.

### `inspect`

Input: path or directory path.

Output includes file kind, byte size, modified time, extension, MIME guess, page count, line count, sheet names, dimensions, encoding, text-layer signal, scanned-document signal, directory manifest summary, and recommended next actions. It must not read large full content into the response.

### `sample`

Input: path, strategy, and optional range.

Strategies include head, tail, middle, random pages, specified pages, specified rows, specified sheets, directory manifest, and representative files. Output includes sampled ranges and a warning that sample evidence is not full coverage.

### `extract`

Input: path plus explicit range.

Ranges are type-aware: pages for PDF/PPT, rows for CSV/logs, sheets and row windows for Excel, headings or character spans for text/Word, files for directories. Output includes source locations and extracted text or table previews.

### `index`

Input: path or directory and optional policy.

Creates a local reusable index under Lily-owned storage. The index records source files, ranges, chunks, summaries, extraction status, errors, and version fingerprints. Long jobs must be resumable.

### `query`

Input: index id and natural-language query.

Returns ranked evidence chunks with file path, page/row/sheet/heading/chunk id, excerpt, score, and extraction coverage. It does not invent answers.

### `summarize`

Input: index id and scope.

Creates hierarchical summaries: per chunk, per range, per file, and cross-file. Summaries must preserve source links and mark OCR/extraction uncertainty.

### `jobStatus` and `resume`

Expose progress, processed ranges, failed ranges, warnings, and continuation. A failed job must not discard completed work.

## Extractor Strategy

The MCP chooses deterministic libraries by file type while keeping orchestration generic:

- PDF: pdfplumber text layer, pypdfium2 rendering, RapidOCR for scanned pages, optional pro-pdf runtime pack when layout structure matters.
- Office: python-docx, openpyxl, python-pptx, LibreOffice-backed rendering only when visual verification or conversion is needed.
- Tables and logs: streaming reads, pandas where useful, bounded sampling, schema inference, row windows.
- Text and code: rg, line windows, heading/symbol-aware chunks when available.
- Images: OCR or vision summaries when appropriate; do not claim OCR certainty.
- Directories: manifests, file grouping, per-type routing, and cross-file summaries.

Heavy engines remain opt-in and must explain download size, local cost, and why the base path is insufficient.

## Agent Guidance

Inject concise guidance into Lily's existing OpenCode guidance path:

> For large files, large directories, unknown binaries, scanned documents, or inputs likely to exceed context, do not read or attach the entire input blindly. Use `lily-file-intelligence.inspect` first. Then choose sample, extract, index, query, or summarize based on the user's goal. Be explicit about coverage and cite source locations. If the Lily tool is unavailable, fall back to normal tools without blocking the task, and say what coverage was possible.

This guidance is deliberately policy-level. It does not say "always split PDFs into 10 pages" or "always index everything."

## Evidence Contract

Every result produced by the large-input tools should carry enough location metadata for later verification:

- `sourcePath`
- `sourceType`
- `rangeType`
- `rangeStart`
- `rangeEnd`
- `page`, `row`, `sheet`, `heading`, or `chunkId` where applicable
- `coverage`: full, sampled, partial, indexed, failed
- `confidence`: exact, OCR, inferred, uncertain
- `warnings`

The agent may summarize and reason, but factual claims must be traceable to evidence records when the task depends on file contents.

## UX Behavior

The default experience stays conversational. The user should see progress cards/notices for long jobs:

- detected large input
- inspecting
- indexing or extracting ranges
- processed count and failed count
- available partial result
- completed index id or summary

The UI should not require the user to manage indexes manually. Index ids are internal unless helpful for debugging.

## Failure Modes

The protocol must degrade safely:

- Tool missing: continue with ordinary OpenCode file tools and explain the fallback.
- Unsupported file: inspect returns unsupported with metadata and suggested manual routes.
- OCR failure: preserve successful pages and list failed pages.
- Timeout: keep partial index and expose resume.
- Context pressure: answer from summaries/evidence rather than pushing raw chunks.
- Ambiguous user goal: inspect first, then ask one focused question only if strategy materially depends on it.

The product must not get dumber: never block a task that today's OpenCode could attempt unless the attempted action would be misleading or unsafe.

## Phased Implementation

### Phase 1: Protocol and Minimal MCP

Implement `inspect`, `sample`, and range-based `extract` for text, CSV/log, PDF metadata/text pages, and Excel sheet metadata/sample windows. Add guidance and tests proving large files are not blindly inlined or silently represented as fully read.

### Phase 2: Index and Query

Add persistent indexes, chunk storage, `query`, and session-aware evidence references. Reuse or extend the existing document query index where possible instead of creating an unrelated store.

### Phase 3: Long Jobs and OCR

Add resumable jobs for scanned PDFs, image directories, and very large mixed directories. Preserve partial work and expose progress through existing runtime event notices.

### Phase 4: Hierarchical Summaries

Add `summarize` over indexes and cross-file summaries, with explicit coverage and citations.

## Tests

Required coverage:

- Large attachment remains skipped by OpenCode inline file protection.
- Guidance includes the inspect-first protocol.
- MCP `inspect` returns compact metadata for representative file types.
- `sample` marks coverage as sampled.
- `extract` requires explicit ranges for large inputs.
- Index writes reusable chunks without storing huge raw payloads in model context.
- Tool failure falls back without failing the turn.
- OCR/index partial failure preserves completed ranges and reports failed ranges.

## Design Review

This design avoids repeating OpenCode because it does not reimplement the runtime. It uses OpenCode MCP, plugin, guidance, permission, session, and compaction surfaces exactly as intended. It avoids making Lily dumber because the only hard rule is inspect-before-blind-ingestion; strategy remains with the agent, and every new capability fails open to today's behavior.
