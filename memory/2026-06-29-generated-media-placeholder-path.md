# Generated Media Placeholder Path

## Debug Report

- Symptom: the answer content renders correctly, but the final generated-file
  area can show a broken image card such as `/absolute/path/to/generated-assets/name.svg`.
  Clicking reveal then reports that the file does not exist.
- Root cause: the renderer's generated-media path extraction trusted both
  `<generated_media>` markers and marker-less `generated-assets/...` text without
  filtering obvious placeholder paths. Example or instruction text containing
  `/absolute/path/to/generated-assets/name.svg` was therefore promoted into a real
  media card even though no file existed.
- Fix:
  - Filter placeholder/generated example paths in `parseGeneratedMedia`.
  - Apply the same filter to marker-less `generated-assets` fallback scanning and
    generated-file JSON output detection.
  - Hide invalid raw `<generated_media>` markers instead of rendering broken
    media or leaking XML in the tool/result area.
- Evidence:
  - `node scripts/test-tool-payload-renderer.mjs`
  - `npx electron scripts/test-renderer-import.cjs`
  - `node scripts/test-turn-view-renderer.mjs`

Important: do not require filesystem existence checks in the renderer. The main
artifact pipeline already stats real artifacts; the renderer should only reject
syntactic placeholders while preserving legitimate absolute, Windows, and
explicit relative generated-media paths.
