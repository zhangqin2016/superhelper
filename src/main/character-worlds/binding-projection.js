"use strict";

// Character Worlds Phase 2B (Task P2B-5): main-side projections over the
// durable binding events and the current session binding (design spec §8).
//
// - projectBindingSwitchNotices maps committed binding changes to
//   conversation-timeline notices ("switched to character X" / "returned to
//   native Lily"). Display names are resolved here, main-side, from the pinned
//   immutable revisions — never from renderer-supplied data — and the notice
//   payload is whitelisted to { bindingVersion, mode, characterName,
//   createdAt }: no canonical card data crosses the bridge.
// - resolveBindingUpdates reports whether the active character/persona has a
//   newer current revision than the binding's pin (the "update available"
//   affordance). It is a pure read: the pinned snapshot is never mutated.
//
// Both projections fail open (§16): corrupt events are skipped, unreadable
// revisions resolve to an empty name, and any resolution failure reads as "no
// update" rather than breaking the underlying IPC read.

function envelopeMode(envelope) {
  return envelope?.mode === "character" && envelope?.activeCharacterRevisionId
    ? "character"
    : "native";
}

/**
 * Map durable binding events to switch notices, binding-version ordered.
 * A notice fires only when the active identity changes (mode flip or a
 * different character); no-op re-commits and same-character revision bumps
 * (update-available applies) stay silent.
 *
 * @param {Array} events durable events from repository.getBindingEvents
 * @param {(revisionId: string) => object|null} resolveRevision main-side
 *   revision lookup (repository.getRevision shape: { characterId, displayName })
 */
function projectBindingSwitchNotices(events, resolveRevision) {
  if (!Array.isArray(events) || typeof resolveRevision !== "function") return [];
  const notices = [];
  for (const event of events) {
    const bindingVersion = Number(event?.bindingVersion);
    if (!Number.isInteger(bindingVersion) || bindingVersion <= 0) continue;
    const previous = event?.previousBinding || {};
    const next = event?.nextBinding || {};
    const prevMode = envelopeMode(previous);
    const nextMode = envelopeMode(next);
    const lookup = (revisionId) => {
      try {
        return resolveRevision(revisionId) || null;
      } catch {
        return null; // an unreadable revision degrades the name, not the read
      }
    };
    const prevRevision = prevMode === "character" ? lookup(previous.activeCharacterRevisionId) : null;
    const nextRevision = nextMode === "character" ? lookup(next.activeCharacterRevisionId) : null;
    // When the revision is unreadable fall back to the revision id itself so
    // identity comparison still detects a real switch.
    const identityOf = (mode, envelope, revision) => (
      mode === "character"
        ? revision?.characterId || `revision:${envelope.activeCharacterRevisionId}`
        : "native"
    );
    const prevIdentity = identityOf(prevMode, previous, prevRevision);
    const nextIdentity = identityOf(nextMode, next, nextRevision);
    if (prevIdentity === nextIdentity) continue;
    notices.push({
      bindingVersion,
      mode: nextMode,
      characterName: nextMode === "character" ? String(nextRevision?.displayName || "") : "",
      createdAt: typeof event?.createdAt === "string" ? event.createdAt : "",
    });
  }
  return notices;
}

/**
 * Compare the binding's pinned revisions with the entities' current revisions.
 * Returns null when there is nothing to apply (including native bindings and
 * any resolution failure); otherwise only the outdated slots are present:
 *   { character?: { currentRevisionId }, persona?: { currentRevisionId } }
 */
function resolveBindingUpdates(repo, ownerScope, binding) {
  try {
    if (binding?.mode !== "character" || !binding.characterRevisionId) return null;
    const updates = {};
    const revision = repo.getRevision(ownerScope, binding.characterRevisionId);
    const character = revision?.characterId
      ? repo.getCharacter(ownerScope, revision.characterId)
      : null;
    if (character?.currentRevisionId && character.currentRevisionId !== binding.characterRevisionId) {
      updates.character = { currentRevisionId: character.currentRevisionId };
    }
    if (binding.personaRevisionId) {
      const personaRevision = repo.getPersonaRevision(ownerScope, binding.personaRevisionId);
      const persona = personaRevision?.personaId
        ? repo.getPersona(ownerScope, personaRevision.personaId)
        : null;
      if (persona?.currentRevisionId && persona.currentRevisionId !== binding.personaRevisionId) {
        updates.persona = { currentRevisionId: persona.currentRevisionId };
      }
    }
    return Object.keys(updates).length ? updates : null;
  } catch {
    return null;
  }
}

module.exports = {
  projectBindingSwitchNotices,
  resolveBindingUpdates,
};
