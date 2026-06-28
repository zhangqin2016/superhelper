---
name: document-query
description: Use this skill when the user asks follow-up questions about documents already uploaded in the current Lily app. It queries Lily's lightweight index over text that was already extracted by the app; it does not parse Office or PDF files itself.
license: Proprietary
intent: Retrieve evidence snippets from the latest uploaded document index so answers can cite document and chunk ids.
type: tool
---

# Document Query

Use this after Lily has extracted an uploaded document and the user asks about a specific clause, section, term, risk, number, or comparison in that document.

## Workflow

1. Run `"{{NODE_BIN}}" "{{SKILL_DIR}}/scripts/query_document_index.cjs" list` to see the indexed documents and chunk ids.
2. Search with `"{{NODE_BIN}}" "{{SKILL_DIR}}/scripts/query_document_index.cjs" search "<query>" --limit 8`.
3. If the script returns `AMBIGUOUS_SESSION`, rerun with the relevant `--session <sessionId>` from the listed sessions instead of guessing.
4. For an exact citation, run `"{{NODE_BIN}}" "{{SKILL_DIR}}/scripts/query_document_index.cjs" read <chunkId>`.
5. Answer from the returned excerpts. Cite the `documentId`, `documentLabel`, and `chunkId` you used.

## Boundaries

- This is a query layer over already extracted text. It must not claim to inspect formatting, hidden comments, images, scanned content, or tables that are not present in the excerpts.
- If the script returns `NO_INDEX`, ask the user to upload the document again.
- If more than one session has indexed documents, do not use global latest silently; pick a session only when the script or current context makes it explicit.
- If the excerpt is insufficient, say what is missing and route to the appropriate PDF/Office extraction or verification skill.
