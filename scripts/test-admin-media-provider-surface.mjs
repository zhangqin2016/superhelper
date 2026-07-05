import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listBuiltinMediaProviderRows } from "../server/src/services/model-gateway/builtin-media-providers.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");

{
  const rows = listBuiltinMediaProviderRows({
    lilyMediaApiKey: "upstream-key",
    lilyMediaImageEndpoint: "http://127.0.0.1:18012/generate",
    lilyMediaVideoEndpoint: "http://127.0.0.1:18010/generate",
    lilyMediaSpeechEndpoint: "http://127.0.0.1:18013/generate",
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["lily-media-image", "lily-media-video", "lily-media-speech"],
    "admin provider list should surface all built-in Lily media services",
  );
  for (const row of rows) {
    assert.equal(row.type, "media");
    assert.equal(row.readOnly, true);
    assert.equal(row.source, "builtin");
    assert.equal(row.hasApiKey, true);
    assert.equal(row.base_url.startsWith("/llm/media/lily/"), true);
  }
}

{
  const rows = listBuiltinMediaProviderRows({
    lilyMediaBaseUrl: "http://127.0.0.1:18080",
  });
  assert.deepEqual(
    rows.map((row) => row.metadata.modality),
    ["image", "video", "speech"],
    "a shared Lily media base URL should expose image, video, and speech",
  );
}

{
  const rows = listBuiltinMediaProviderRows({});
  assert.equal(rows.length, 0, "unconfigured Lily media should not create admin rows");
}

{
  const formSource = readFileSync(join(repoRoot, "web/components/config-profile-form.js"), "utf8");
  assert.match(formSource, /id:\s*"lily"/, "config profiles should offer Lily as a media provider");
  assert.match(formSource, /\["speech",\s*copy\.mediaSpeech\]/, "config profiles should render speech generation controls");
  assert.match(formSource, /draft\.speechProviders/, "config profiles should include speech selection in generated config.media");
}

console.log("admin media provider surface tests passed");
