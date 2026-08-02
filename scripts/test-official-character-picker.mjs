import assert from "node:assert/strict";

const { createOfficialCharacterLoader, installOfficialCharacter } = await import(
  "../src/renderer/modules/official-character-picker.js"
);

let action = null;
const load = createOfficialCharacterLoader({
  getFacade: () => ({
    listCharacters: async () => ({
      ok: true,
      characters: [
        { id: "installed-1", displayName: "duplicate local row", currentRevisionId: "rev-1" },
        { id: "local-2", displayName: "My Role", currentRevisionId: "rev-2" },
      ],
    }),
    listOfficialCharacters: async () => ({
      ok: true,
      characters: [{
        id: "lily-companion",
        displayName: "Lily Companion",
        installedCharacterId: "installed-1",
        currentRevisionId: "rev-1",
        official: true,
      }],
    }),
  }),
  dispatch: (next) => { action = next; },
});
await load();
assert.equal(action.type, "characters.loaded");
assert.deepEqual(action.characters.map((item) => item.id), ["installed-1", "local-2"]);

let installs = 0;
const unchanged = await installOfficialCharacter({
  installOfficialCharacter: async () => { installs += 1; },
}, { officialId: "lily-companion", currentRevisionId: "rev-1", updateAvailable: false });
assert.equal(unchanged.currentRevisionId, "rev-1");
assert.equal(installs, 0);

const updated = await installOfficialCharacter({
  installOfficialCharacter: async () => {
    installs += 1;
    return { ok: true, characterId: "installed-1", revisionId: "rev-new", version: 2 };
  },
}, { officialId: "lily-companion", currentRevisionId: "rev-1", updateAvailable: true, version: 2 });
assert.equal(updated.currentRevisionId, "rev-new");
assert.equal(updated.updateAvailable, false);
assert.equal(installs, 1);

console.log("PASS: test-official-character-picker");
