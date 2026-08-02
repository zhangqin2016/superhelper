"use strict";

/**
 * Agent character draft broker tool (Character Worlds Phase 2C, Task P2C-1;
 * design spec §13.2 natural-language creation, §8 binding approval semantics,
 * §14.5 no extra model request).
 *
 * Invariants (phase plan "Task P2C-1" + invariants 1–3):
 * - The agent never binds, selects, or activates anything. This module has NO
 *   call path to session-binding mutation: it only ever calls the validated
 *   authoring service (P2B-3), which itself never writes bindings or turn
 *   metadata. Drafts are inert library data until a human approves through
 *   the existing UI flows (session select / library review / update-available
 *   apply). The tool description below is the model contract for that.
 * - Validation is EXACTLY the authoring service's: identical codes, identical
 *   limits, executable keys screened (create/revise delegate to
 *   CharacterAuthoringService with no re-validation of the canonical).
 * - Provenance decision: a dedicated source kind `agent_draft` (instead of
 *   kind "created"/"edited" + a `draftedBy` marker). source_kind is a real
 *   SQLite column, so provenance is SQL-queryable, the authoring history
 *   metadata surfaces it for free, and the library/history badge detection
 *   needs no source_json parsing. The source envelope validation
 *   (persistence-codec normalizeSource) accepts any non-empty kind string, so
 *   no schema change is required; nothing gates behavior on a fixed kind
 *   vocabulary. Both create and revise use it — the distinguishing fact is
 *   WHO authored the revision, not which repository method ran.
 * - Policy-gated fail closed: the tool is absent from the broker list when
 *   Character Worlds is disabled (remote policy or LILY_CHARACTER_WORLDS=0
 *   kill switch — the env kill switch is checked FIRST on every invocation,
 *   before any injected resolver), and the handler re-checks the policy on
 *   every invocation.
 * - Results are metadata-only ({ok, entityId, revisionId, revisionNumber} —
 *   never canonical echo, never other entities' data).
 *
 * Availability: drafting creates UNBOUND owner-scoped library entities — no
 * session authority is needed anywhere in this module (no binding mutation
 * path exists), so the tool is a PLATFORM tool: available in the platformOnly
 * production transport subject to the policy gate. Contexts that carry
 * neither a sessionId nor the platformOnly flag still fail closed
 * (SESSION_REQUIRED), matching the other platform tools.
 *
 * Execution wiring: the handler resolves the authoring service from injected
 * deps (call-time registryDeps first, then factory deps). In the stdio broker
 * subprocess, tool-broker-mcp supplies `resolveDraftAuthoring`
 * (createLazyDraftAuthoring below) which constructs the leanest correct
 * service on first use: CharacterAuthoringService directly over a repository
 * + MessageStore — NOT the full CharacterWorldsService, whose constructor
 * eagerly builds the import worker pool (service.js). MessageStore spawns
 * nothing; node:sqlite is built-in; WAL + busy_timeout (sqlite-db.js) make
 * the cross-process read/write safe by design and every write here is a
 * single short transaction. Owner scope resolves from config files only
 * (owner-scope.js → account-manager/service-client read userData files;
 * safeStorage is lazy and absent under ELECTRON_RUN_AS_NODE), and the policy
 * reads the same userData remote-config cache as the main process. Without
 * any service the handler fails closed with CHARACTER_WORLDS_UNAVAILABLE.
 */

const { z } = require("zod");
const { characterWorldsPolicy } = require("./constants");
const { resolveCharacterOwnerScope } = require("./owner-scope");
const { boundedPayload, validId } = require("../ipc-character-guards");

const AGENT_DRAFT_SOURCE_KIND = "agent_draft";
const AGENT_DRAFT_SOURCE = Object.freeze({
  kind: AGENT_DRAFT_SOURCE_KIND,
  format: "lily",
  container: "json",
});
// Whole-args cap, applied before any domain call. Aligned with the IPC
// authoring guard (ipc-character-authoring.js MAX_AUTHORING_PAYLOAD_BYTES =
// 1 MiB) so agent drafts stay human-editable through the same limits: an
// oversized payload is rejected HERE with INVALID_INPUT exactly like the IPC
// guard, so the tool and the library UI disagree about nothing. The smaller
// domain checks (executable keys, dangerous keys, malformed canonical) still
// surface the identical authoring codes on payloads inside the cap.
const MAX_DRAFT_PAYLOAD_BYTES = 1024 * 1024;

const UNAVAILABLE = "CHARACTER_WORLDS_UNAVAILABLE";
const INVALID_INPUT = "INVALID_INPUT";
const CODED_ERROR_SHAPE = /^[A-Z][A-Z0-9_]{1,71}$/;

const DESCRIPTION = [
  "Draft a new character, persona, or world book (action=create) or revise an existing one",
  "(action=revise with entityId + expectedBaseRevisionId from the library).",
  "For creation requests, infer and design the complete canonical from the user's",
  "natural-language intent; never ask the user to fill canonical fields or claim",
  "that a blank/manual form is a completed character.",
  "Include a coherent identity, goals, personality, values, background, voice,",
  "boundaries, opening message, example behavior, and uncertainty handling when",
  "the canonical format supports those fields.",
  "After saving, explain the result in ordinary language, show the user what was",
  "designed, invite a short trial conversation, and ask for confirmation before",
  "binding or activating it in a session. Never expose internal ids, canonical",
  "field names, or CLI/tool terminology unless the user explicitly asks.",
  "Do not claim that anything was created, saved, or activated unless this tool",
  "returns ok:true. If validation rejects the draft, repair the design and retry;",
  "if a required user decision is missing, ask one focused question instead of",
  "silently inventing a critical constraint.",
  "The draft is validated and stored as an inert library revision with",
  "agent_draft provenance: it never activates, selects, or binds anything by",
  "itself. After drafting, tell the user to review the card and select it in",
  "the character library — approval is human-only. On a REVISION_CONFLICT",
  "error, re-read the current revision before retrying. Results are ids and",
  "revision numbers only; do not claim the character is active.",
].join(" ");

/**
 * Strictly validate the broker-context `characterWorlds` block that the main
 * process injects (the main process CAN decrypt safeStorage; the stdio broker
 * subprocess cannot, so without this channel the cached remote policy always
 * reads disabled and logged-in accounts fall back to device scope on
 * mac/win). Returns:
 *   null                — block ABSENT; caller keeps the local derivation
 *                         (Linux-dev fallback, no context channel in tests).
 *   { enabled:false }   — block present but disabled, malformed, or
 *                         incomplete; FAIL CLOSED, never a permissive read.
 *   { enabled:true, ownerScope } — fully valid and authoritative.
 * A loosely-typed block can only ever turn the feature OFF, never on
 * (mirrors characterWorldsPolicy's strict-boolean rule in constants.js).
 */
function normalizeCharacterWorldsContext(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return { enabled: false };
  if (value.enabled !== true) return { enabled: false };
  const ownerScope = typeof value.ownerScope === "string" && value.ownerScope
    ? value.ownerScope
    : "";
  if (!ownerScope) return { enabled: false };
  return { enabled: true, ownerScope };
}

/**
 * Main-process assembly of the `characterWorlds` broker block: resolve the
 * signed remote policy and the real owner scope HERE (safeStorage works in
 * the full Electron main process) and hand the result down to the broker
 * subprocess over the context channel. Any resolution failure produces a
 * disabled block — the subprocess then keeps the tool hidden, never guessing.
 * Pure over injected deps so unit tests can exercise it without Electron.
 */
function assembleCharacterWorldsBrokerBlock(deps = {}) {
  try {
    const policy = typeof deps.characterWorldsPolicy === "function"
      ? deps.characterWorldsPolicy()
      : characterWorldsPolicy(
        {
          characterWorlds: typeof deps.getRemotePolicy === "function"
            ? deps.getRemotePolicy()
            : require("../remote-config").getRemoteCharacterWorldsPolicySync(),
        },
      );
    if (policy?.enabled !== true) return { enabled: false };
    const ownerScope = typeof deps.resolveOwnerScope === "function"
      ? deps.resolveOwnerScope()
      : resolveCharacterOwnerScope();
    if (typeof ownerScope !== "string" || !ownerScope) return { enabled: false };
    return { enabled: true, ownerScope };
  } catch {
    return { enabled: false };
  }
}

function metadata(entityId, revision, droppedExecutableKeys) {
  const result = {
    ok: true,
    entityId,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
  };
  if (Array.isArray(droppedExecutableKeys) && droppedExecutableKeys.length) {
    result.droppedExecutableKeys = droppedExecutableKeys;
  }
  return result;
}

// Allowlisted, bounded argument normalization. zod validates shape at the MCP
// boundary, but handlers can also be reached directly (tests, future
// in-process brokers), so the handler re-validates: enum action/kind, plain
// non-array canonical, IPC-guard id formats, whole-payload byte cap.
function normalizeArgs(args) {
  const payload = boundedPayload(args, MAX_DRAFT_PAYLOAD_BYTES);
  if (payload === null || !Object.keys(payload).length) return null;
  const action = payload.action;
  const kind = payload.kind;
  if (action !== "create" && action !== "revise") return null;
  if (kind !== "character" && kind !== "persona" && kind !== "worldBook") return null;
  const canonical = payload.canonical;
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) return null;
  if (action === "revise") {
    const targetReceiptId = validId(payload.targetReceiptId) ? payload.targetReceiptId : null;
    if (!targetReceiptId && (!validId(payload.entityId) || !validId(payload.expectedBaseRevisionId))) return null;
    return {
      action,
      kind,
      canonical,
      entityId: payload.entityId,
      expectedBaseRevisionId: payload.expectedBaseRevisionId,
      targetReceiptId,
    };
  }
  return { action, kind, canonical };
}

function buildCharacterDraftTool(deps = {}) {
  const log = typeof deps.log === "function" ? deps.log : () => {};

  // Fail closed on ANY resolution error: an unsigned/stale/disabled remote
  // policy or the kill switch hides the tool and blocks the handler. The env
  // kill switch is checked FIRST so not even an injected resolver can
  // override it. A valid context-channel block (injected by the main process,
  // which CAN decrypt safeStorage) is authoritative; an absent block falls
  // back to the local derivation (Linux-dev); a malformed/disabled block
  // fails closed.
  const policyEnabled = (context) => {
    try {
      if (process.env.LILY_CHARACTER_WORLDS === "0") return false;
      const injected = normalizeCharacterWorldsContext(context?.characterWorlds);
      if (injected) return injected.enabled === true;
      const policy = typeof deps.characterWorldsPolicy === "function"
        ? deps.characterWorldsPolicy()
        : characterWorldsPolicy(require("../remote-config").getRemoteEffectiveConfigSync());
      return policy?.enabled === true;
    } catch {
      return false;
    }
  };

  const authoringOf = (callDeps) => {
    const direct = callDeps?.characterWorldsService?.authoring
      || callDeps?.characterAuthoringService
      || deps.characterWorldsService?.authoring
      || deps.characterAuthoringService;
    if (direct) return direct;
    // Stdio broker path: a per-process lazy factory wired by tool-broker-mcp.
    const lazy = typeof callDeps?.resolveDraftAuthoring === "function"
      ? callDeps.resolveDraftAuthoring
      : typeof deps.resolveDraftAuthoring === "function" ? deps.resolveDraftAuthoring : null;
    if (!lazy) return null;
    try {
      return lazy() || null;
    } catch {
      return null; // a construction failure fails closed, never throws
    }
  };

  const ownerResolverOf = (callDeps, authoring) => {
    if (typeof callDeps?.resolveOwnerScope === "function") return callDeps.resolveOwnerScope;
    if (typeof deps.resolveOwnerScope === "function") return deps.resolveOwnerScope;
    if (typeof authoring?.resolveOwnerScope === "function") {
      return () => authoring.resolveOwnerScope();
    }
    return null;
  };

  async function handler(args = {}, context = {}, callDeps = {}) {
    if (!policyEnabled(context)) return { ok: false, error: UNAVAILABLE };
    const authoring = authoringOf(callDeps);
    const resolveOwner = ownerResolverOf(callDeps, authoring);
    if (!authoring || !resolveOwner) return { ok: false, error: UNAVAILABLE };
    let owner = null;
    // The main process resolved the REAL owner scope (it can decrypt the
    // account state); that injected value is authoritative over any local
    // derivation, which would fall back to device scope for logged-in users.
    const injected = normalizeCharacterWorldsContext(context?.characterWorlds);
    let previousOwnerResolver = null;
    if (injected?.enabled === true) {
      owner = injected.ownerScope;
      // The authoring service RE-RESOLVES the owner internally on every write
      // (authoring-service._owner, import-identical discipline). Under
      // ELECTRON_RUN_AS_NODE the subprocess can only derive device scope, so
      // the injected scope must also drive the service's own resolver. Calls
      // are serial over stdio and the resolver is rebound before every write;
      // the previous resolver is restored afterwards so a shared instance
      // never leaks an injected scope into later un-injected calls.
      if (typeof authoring.resolveOwnerScope === "function") {
        previousOwnerResolver = authoring.resolveOwnerScope;
        authoring.resolveOwnerScope = async () => injected.ownerScope;
      }
    } else {
      try {
        owner = await resolveOwner();
      } catch {
        owner = null;
      }
    }
    if (typeof owner !== "string" || !owner) {
      return { ok: false, error: "IMPORT_OWNER_UNAVAILABLE" };
    }
    const input = normalizeArgs(args);
    if (!input) return { ok: false, error: INVALID_INPUT };
    try {
      if (input.action === "revise" && input.targetReceiptId) {
        const receipt = authoring.repository?.db?.get?.(
          `SELECT kind, entity_id, revision_id FROM character_worlds_receipts
           WHERE id = ? AND owner_scope = ?`,
          input.targetReceiptId, owner,
        );
        if (!receipt || receipt.kind !== input.kind) return { ok: false, error: INVALID_INPUT };
        input.entityId = receipt.entity_id;
        input.expectedBaseRevisionId = receipt.revision_id;
      }
      if (input.action === "create") {
        const created = input.kind === "persona"
          ? await authoring.createPersona({
            ownerScope: owner, canonical: input.canonical, source: AGENT_DRAFT_SOURCE,
          })
          : input.kind === "worldBook"
            ? await authoring.createWorldBook({
              ownerScope: owner, canonical: input.canonical, source: AGENT_DRAFT_SOURCE,
            })
          : await authoring.createCharacter({
            ownerScope: owner, canonical: input.canonical, source: AGENT_DRAFT_SOURCE,
          });
        return metadata(created.entity.id, created.revision, created.droppedExecutableKeys);
      }
      const revised = input.kind === "persona"
        ? await authoring.editPersona({
          ownerScope: owner,
          entityId: input.entityId,
          expectedBaseRevisionId: input.expectedBaseRevisionId,
          canonical: input.canonical,
          source: AGENT_DRAFT_SOURCE,
        })
        : input.kind === "worldBook"
          ? await authoring.editWorldBook({
            ownerScope: owner,
            entityId: input.entityId,
            expectedBaseRevisionId: input.expectedBaseRevisionId,
            canonical: input.canonical,
            source: AGENT_DRAFT_SOURCE,
          })
        : await authoring.editCharacter({
          ownerScope: owner,
          entityId: input.entityId,
          expectedBaseRevisionId: input.expectedBaseRevisionId,
          canonical: input.canonical,
          source: AGENT_DRAFT_SOURCE,
        });
      const entityId = input.kind === "persona"
        ? revised.revision.personaId
        : input.kind === "worldBook"
          ? revised.revision.worldBookId
          : revised.revision.characterId;
      return metadata(entityId, revised.revision, revised.droppedExecutableKeys);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      if (CODED_ERROR_SHAPE.test(code)) {
        const failure = { ok: false, error: code };
        // CAS conflicts carry the current tip so the model can re-base.
        if (typeof error.currentRevisionId === "string" && error.currentRevisionId) {
          failure.currentRevisionId = error.currentRevisionId;
        }
        return failure;
      }
      log("[character-agent-draft] unexpected failure:", error?.message || error);
      return { ok: false, error: UNAVAILABLE };
    } finally {
      if (previousOwnerResolver) {
        authoring.resolveOwnerScope = previousOwnerResolver;
      }
    }
  }

  return {
    id: "lily_character_draft",
    name: "lily_character_draft",
    group: "character-worlds",
    requiredSkillIds: [],
    executionSurface: "tool_broker",
    mcpServerName: "lily_tool_broker",
    description: DESCRIPTION,
    inputSchema: {
      action: z.enum(["create", "revise"]).describe("create a new draft, or revise an existing entity"),
      kind: z.enum(["character", "persona", "worldBook"]).describe("the library entity kind to draft"),
      canonical: z.record(z.unknown()).describe(
        "the full canonical card/persona fields (name required); unknown inert fields are preserved, executable keys are dropped",
      ),
      entityId: z.string().min(1).max(128).optional()
        .describe("required for revise: the library entity id"),
      expectedBaseRevisionId: z.string().min(1).max(128).optional()
        .describe("required for revise: the revision id the draft is based on (CAS)"),
      targetReceiptId: z.string().min(1).max(128).optional()
        .describe("opaque trusted receipt target for a receipt-originated revise request"),
    },
    annotations: {},
    isAvailable: (context) => policyEnabled(context),
    handler,
  };
}

// Lazy per-process authoring factory for the stdio broker subprocess (wired
// by tool-broker-mcp when registryDeps carry no service). Constructs the
// LEANEST correct service on first call: CharacterAuthoringService directly
// over a repository + MessageStore against the config userData paths — the
// full CharacterWorldsService is deliberately avoided because its constructor
// eagerly builds the import worker pool, and drafting never imports, exports,
// or spawns workers. A construction failure returns null (fail closed) and is
// NOT cached, so a transient lock can succeed on a later call.
function createLazyDraftAuthoring() {
  let cached = null;
  return () => {
    if (cached) return cached;
    try {
      const { messageDbPath, blobStoreDir } = require("../config");
      const { MessageStore } = require("../store/message-store");
      const { CharacterWorldsRepository } = require("./repository");
      const { CharacterAuthoringService } = require("./authoring-service");
      const { resolveCharacterOwnerScope } = require("./owner-scope");
      const store = new MessageStore(messageDbPath(), blobStoreDir());
      cached = new CharacterAuthoringService({
        repository: new CharacterWorldsRepository(store),
        resolveOwnerScope: async () => resolveCharacterOwnerScope(),
      });
    } catch {
      cached = null;
    }
    return cached;
  };
}

module.exports = {
  AGENT_DRAFT_SOURCE_KIND,
  MAX_DRAFT_PAYLOAD_BYTES,
  assembleCharacterWorldsBrokerBlock,
  buildCharacterDraftTool,
  createLazyDraftAuthoring,
  normalizeCharacterWorldsContext,
};
