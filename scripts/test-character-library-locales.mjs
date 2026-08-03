import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const required = [
  "character.library.sourceFilter",
  "character.library.sourceAll",
  "character.library.sourceOfficial",
  "character.library.sourceLocal",
  "character.library.detailPersona",
  "character.library.detailWorldBook",
  "character.library.detailScope",
  "character.library.detailHealth",
  "character.library.detailMergeStrategy",
  "character.library.statusActive",
  "character.library.statusUpdate",
  "character.library.statusReady",
  "character.library.statusIncomplete",
];

for (const locale of ["zh-CN", "en", "ar"]) {
  const data = JSON.parse(await readFile(`src/renderer/i18n/locales/${locale}.json`, "utf8"));
  for (const key of required) {
    assert.equal(typeof data[key], "string", `${locale} is missing ${key}`);
    assert.ok(data[key].trim(), `${locale} has empty ${key}`);
  }
}

console.log("PASS: test-character-library-locales");
