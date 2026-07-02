# Document Attachment Model Interruption

## Symptom

Small `.docx` files pasted/copied into the chat could make the turn fail with:

`Connection to the model service was interrupted. Please check your network and API settings, then retry.`

After that, the same Lily conversation could keep failing on every follow-up, even if the user sent plain text.

## Root Cause

When document preflight could not provide extracted text first, the OpenCode prompt builder still inlined small Office/PDF files as raw `file` parts. Some model providers reject or disconnect on those binary document payloads. Because the rejected payload had already entered the engine session history, the engine session could be poisoned: later prompts in the same OpenCode session replayed the bad history and failed again.

There was a second issue in the recovery path: OpenCode `message.error` / `session.error` effects only carried a sanitized display message into `_failTurn`. The transient classifier then saw Lily's display wrapper (`Request failed: ...`) rather than the original model error, which could either fail too eagerly or defer the wrong errors.

## Fix

- Do not send Office/PDF/document attachments as raw OpenCode file parts. Keep them text/path backed so Lily's document extractor or local CLI tools handle them.
- Use a positive allowlist for raw model file parts: explicit image/text/JSON/XML-like MIME types are allowed; unknown binaries, archives, extensionless clipboard files, and unsafe URI attachments are path-first.
- Detect document attachments by temp path, original filename, and MIME/type so clipboard-staged files with extensionless temp paths are covered.
- Preserve the original OpenCode error object in reducer effects so transient classification uses the raw provider failure, not Lily's user-facing wording.
- When a document attachment triggers a recoverable model-connection error, abort/detach the poisoned engine session and replay once in a fresh OpenCode session using a text-only attachment manifest. The Lily app conversation remains continuous.

## Guard Tests

- `scripts/test-opencode-message-parts.mjs` covers raw document skip, source-path notes, clipboard-staged extensionless document detection, and unknown binary/archive/unsafe URI path-first behavior.
- `scripts/test-opencode-agent-session.mjs` covers model-level document attachment interruption, fresh engine-session isolation, and follow-up messages staying on the recovered session.
