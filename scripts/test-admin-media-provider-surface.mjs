import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA_PROVIDER_CATALOG } from "../server/src/services/media-provider-catalog.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");

{
  // The bespoke self-hosted GPU rows were retired on 2026-09-23; what the admin
  // surfaces now is the catalog every provider shares.
  assert.deepEqual(
    MEDIA_PROVIDER_CATALOG.map((entry) => entry.credentialProviderId),
    ["vision", "volcengine-media", "kling-media", "minimax-media", "zhipu-media"],
    "the admin offers exactly the credential ids the media pickers wait for",
  );
}

{
  // The form was split on 2026-09-22: the provider list and what a draft means
  // as stored config live in the builder, the labels in the copy module.
  const formSource = readFileSync(join(repoRoot, "web/components/config-profile-form.js"), "utf8");
  const builderSource = readFileSync(join(repoRoot, "web/components/config-profile-config-builder.js"), "utf8");
  // The self-hosted GPU was retired (5a6415ca); the offered list equals the catalog — see media-provider-manageability.
  assert.doesNotMatch(builderSource, /id:\s*"lily"/, "the retired self-hosted GPU is not offered");
  assert.match(formSource, /\["speech",\s*copy\.mediaSpeech\]/, "config profiles should render speech generation controls");
  assert.match(builderSource, /draft\.speechProviders/, "config profiles should include speech selection in generated config.media");
}

console.log("admin media provider surface tests passed");
