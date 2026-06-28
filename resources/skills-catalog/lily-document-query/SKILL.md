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

1. Run `node scripts/query_document_index.cjs list` to see the latest indexed documents and chunk ids.
2. Search with `node scripts/query_document_index.cjs search "<query>" --limit 8`.
3. For an exact citation, run `node scripts/query_document_index.cjs read <chunkId>`.
4. Answer from the returned excerpts. Cite the `documentId`, `documentLabel`, and `chunkId` you used.

## Boundaries

- This is a query layer over already extracted text. It must not claim to inspect formatting, hidden comments, images, scanned content, or tables that are not present in the excerpts.
- If the script returns `NO_INDEX`, ask the user to upload the document again.
- If the excerpt is insufficient, say what is missing and route to the appropriate PDF/Office extraction or verification skill.
