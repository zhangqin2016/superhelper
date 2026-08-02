/**
 * Official character catalog adapter. It keeps catalog loading and first-use
 * installation out of the session binding controller; the controller only
 * receives ordinary characters with a resolvable revision id.
 */

export function createOfficialCharacterLoader({ getFacade, dispatch }) {
  return async function loadCharacters() {
    const api = getFacade();
    if (!api) return;
    try {
      const [local, official] = await Promise.all([
        api.listCharacters().catch(() => ({ ok: false })),
        typeof api.listOfficialCharacters === "function"
          ? api.listOfficialCharacters().catch(() => ({ ok: false }))
          : Promise.resolve({ ok: false }),
      ]);
      if (local?.ok || official?.ok) {
        const installedIds = new Set(
          (official?.characters || []).map((character) => character.installedCharacterId).filter(Boolean),
        );
        const officialRows = (official?.characters || []).map((character) => ({
          ...character,
          id: character.installedCharacterId || `official:${character.id}`,
          officialId: character.id,
        }));
        const localRows = (local?.characters || []).filter((character) => !installedIds.has(character.id));
        dispatch({ type: "characters.loaded", characters: [...officialRows, ...localRows] });
      }
    } catch {
      // Keep prior characters. Official catalog availability must not hide the
      // user's local characters or change native Lily fallback behavior.
    }
  };
}

export async function installOfficialCharacter(api, character) {
  if (!api || !character?.officialId || (character.currentRevisionId && !character.updateAvailable)) return character;
  const installed = await api.installOfficialCharacter(character.officialId);
  if (!installed?.ok || !installed.revisionId) return null;
  return {
    ...character,
    id: installed.characterId || character.id,
    currentRevisionId: installed.revisionId,
    displayName: installed.displayName || character.displayName,
    installedVersion: installed.version || character.version,
    updateAvailable: false,
  };
}

export function appendCharacterOptionCopy(row, character, name, el) {
  const copy = el("span", "character-option-copy");
  copy.appendChild(el("span", "character-option-name", { textContent: name, title: name }));
  if (character.tagline) {
    copy.appendChild(el("span", "character-option-tagline", {
      textContent: character.tagline,
      title: character.tagline,
    }));
  }
  row.appendChild(copy);
}
