# Character AI-First Creation

## Product Rule

Users describe the result they want in ordinary language. Lily, through the
current OpenCode CLI agent session, designs, validates, saves, and helps test
the result. Users do not fill a character schema to create one.

## User Flow

1. The user chooses `Let Lily design` from the conversation character control
   or the character library.
2. Lily places a plain-language starter in the current conversation. The user
   adds any wishes in their own words and sends it normally.
3. The CLI agent understands the intent and asks only focused questions when a
   missing decision would materially change the result.
4. The agent designs a complete character: identity, goals, personality,
   values, background, voice, boundaries, opening behavior, examples, and
   uncertainty handling where the canonical format supports them.
5. The agent calls `lily_character_draft`. The tool validates and stores an
   inert `agent_draft` revision. The agent may not claim success before the
   tool returns `ok: true`.
6. Lily explains the result without internal IDs, schema names, or tool terms,
   then invites a short trial conversation.
7. Only after the user confirms does the existing session binding flow activate
   the selected revision. Existing conversation history remains pinned.

## Interaction Boundaries

- User-facing creation buttons never call `character:create` directly.
- The character library form is an edit and revision surface for existing
  entities, not a default creation path.
- Import remains an explicit alternative for an existing character card; it is
  not the AI creation path.
- The agent never silently binds or activates its own draft.
- A tool failure, validation failure, or missing dependency is not reported as
  success. The agent repairs, asks one focused question, or reports the real
  blocker.

## Quality Bar

A useful result must be coherent in three places: the character definition,
the first interaction, and behavior under ambiguity or conflict. The user
should be able to request changes such as “warmer”, “less verbose”, or “more
independent” in natural language; each change creates a new revision and does
not rewrite historical turns.

## Implementation Mapping

- Renderer entry: `startAiAuthoring` in
  `src/renderer/modules/character-library.js`.
- CLI tool contract: `lily_character_draft` in
  `src/main/character-worlds/agent-draft-tools.js`.
- Persistence and CAS revision semantics: the existing validated authoring
  service and session binding service.
- Verification: `test-character-library.cjs`,
  `test-character-session-control.cjs`, and `test-character-agent-draft.mjs`.
