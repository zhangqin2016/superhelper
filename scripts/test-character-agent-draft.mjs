// Character Worlds agent draft broker tool (Phase 2C, Task P2C-1; spec
// §13.2/§8/§14.5). The agent drafts characters/personas/world books through ONE narrow
// broker tool that validates through the exact P2B-3 authoring service —
// identical codes, identical limits, executable keys screened. Drafts are
// inert data with `agent_draft` provenance: the tool has NO call path to
// session-binding mutation, activation stays human-only, results are
// metadata-only, and the tool is policy-gated fail closed.
// Run: node scripts/test-character-agent-draft.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { MessageStore } = require("../src/main/store/message-store.js");
const {
  CharacterWorldsRepository,
} = require("../src/main/character-worlds/repository.js");
const {
  CharacterAuthoringService,
} = require("../src/main/character-worlds/authoring-service.js");
const {
  MAX_CHARACTER_TEXT_FIELD_BYTES,
} = require("../src/main/character-worlds/constants.js");
const {
  AGENT_DRAFT_SOURCE_KIND,
  MAX_DRAFT_PAYLOAD_BYTES,
  assembleCharacterWorldsBrokerBlock,
  buildCharacterDraftTool,
  normalizeCharacterWorldsContext,
} = require("../src/main/character-worlds/agent-draft-tools.js");
const {
  buildBrokerTools,
  findBrokerTool,
} = require("../src/main/mcp/tool-broker-registry.js");

const OWNER = "profile:local";
const SESSION = "session-agent-draft";
const CONTEXT = { sessionId: SESSION, activeSkillIds: [] };

let checks = 0;
async function check(name, fn) {
  const result = await fn();
  checks += 1;
  console.log(`ok - ${name}`);
  return result;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-agent-draft-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repository = new CharacterWorldsRepository(store);
let currentOwner = OWNER;
const authoring = new CharacterAuthoringService({
  repository,
  resolveOwnerScope: async () => currentOwner,
});

function makeDeps(overrides = {}) {
  return {
    characterWorldsService: { authoring },
    characterWorldsPolicy: () => ({ enabled: true, reason: "test" }),
    resolveOwnerScope: async () => currentOwner,
    log: () => {},
    ...overrides,
  };
}

const deps = makeDeps();
const tool = buildCharacterDraftTool(deps);
const call = (args) => tool.handler(args, CONTEXT, deps);

function toolNames(context, registryDeps) {
  return buildBrokerTools(context, registryDeps).map((entry) => entry.name).sort();
}

try {
  // --- tool definition shape (broker conventions) ----------------------------
  await check("tool definition matches broker shape and bounds its schema", async () => {
    assert.equal(tool.name, "lily_character_draft");
    assert.equal(tool.id, "lily_character_draft");
    assert.equal(tool.group, "character-worlds");
    assert.deepEqual(tool.requiredSkillIds, []);
    assert.equal(tool.executionSurface, "tool_broker");
    assert.equal(tool.mcpServerName, "lily_tool_broker");
    assert.equal(typeof tool.isAvailable, "function");
    assert.equal(typeof tool.handler, "function");
    assert.equal(tool.inputSchema.action.safeParse("create").success, true);
    assert.equal(tool.inputSchema.action.safeParse("revise").success, true);
    assert.equal(tool.inputSchema.action.safeParse("delete").success, false);
    assert.equal(tool.inputSchema.kind.safeParse("character").success, true);
    assert.equal(tool.inputSchema.kind.safeParse("persona").success, true);
    assert.equal(tool.inputSchema.kind.safeParse("worldBook").success, true);
    assert.equal(tool.inputSchema.entityId.safeParse("x".repeat(256)).success, false);
    // The description is the model contract: drafts never self-activate and
    // the human reviews/selects in the library (approval is human-only).
    const description = String(tool.description || "");
    assert.match(description, /review/i);
    assert.match(description, /library/i);
    assert.match(description, /never (activat|select|bind)/i);
  });

  await check("draft payload cap is aligned with the IPC authoring guard (1 MiB)", async () => {
    // P2C-1 review finding: the agent draft must stay human-editable through
    // the SAME limit as ipc-character-authoring.js MAX_AUTHORING_PAYLOAD_BYTES.
    assert.equal(MAX_DRAFT_PAYLOAD_BYTES, 1024 * 1024);
  });

  await check("normalizeCharacterWorldsContext is strict and assembleCharacterWorldsBrokerBlock fails closed", async () => {
    // Absent block → null (caller keeps the local Linux-dev derivation).
    assert.equal(normalizeCharacterWorldsContext(undefined), null);
    assert.equal(normalizeCharacterWorldsContext(null), null);
    // Fully valid block → authoritative owner scope.
    assert.deepEqual(
      normalizeCharacterWorldsContext({ enabled: true, ownerScope: "profile:account:x" }),
      { enabled: true, ownerScope: "profile:account:x" },
    );
    // Present-but-malformed / incomplete blocks FAIL CLOSED (enabled:false),
    // never a permissive read and never a fallback.
    assert.deepEqual(normalizeCharacterWorldsContext({ enabled: true }), { enabled: false });
    assert.deepEqual(normalizeCharacterWorldsContext({ enabled: true, ownerScope: "" }), { enabled: false });
    assert.deepEqual(normalizeCharacterWorldsContext({ enabled: "yes", ownerScope: "x" }), { enabled: false });
    assert.deepEqual(normalizeCharacterWorldsContext({ enabled: false, ownerScope: "x" }), { enabled: false });
    assert.deepEqual(normalizeCharacterWorldsContext("bad"), { enabled: false });
    assert.deepEqual(normalizeCharacterWorldsContext([{ enabled: true, ownerScope: "x" }]), { enabled: false });
    // Main-process assembly: only an enabled policy PLUS a resolvable owner
    // scope produces an enabled block; anything else is disabled.
    assert.deepEqual(
      assembleCharacterWorldsBrokerBlock({
        characterWorldsPolicy: () => ({ enabled: false }),
        resolveOwnerScope: () => "profile:account:x",
      }),
      { enabled: false },
    );
    assert.deepEqual(
      assembleCharacterWorldsBrokerBlock({
        characterWorldsPolicy: () => ({ enabled: true }),
        resolveOwnerScope: () => "profile:account:x",
      }),
      { enabled: true, ownerScope: "profile:account:x" },
    );
    assert.deepEqual(
      assembleCharacterWorldsBrokerBlock({
        // Production's getRemoteCharacterWorldsPolicySync returns the policy
        // block itself, not the full effective-config envelope.
        getRemotePolicy: () => ({
          enabled: true,
          compatibilityProfile: "lily-character-compat-1",
          minimumClientVersion: "0.0.0",
        }),
        resolveOwnerScope: () => "profile:account:x",
      }),
      { enabled: true, ownerScope: "profile:account:x" },
      "the main-process production policy shape must enable the injected broker block",
    );
    assert.deepEqual(
      assembleCharacterWorldsBrokerBlock({
        characterWorldsPolicy: () => ({ enabled: true }),
        resolveOwnerScope: () => "",
      }),
      { enabled: false },
    );
    assert.deepEqual(
      assembleCharacterWorldsBrokerBlock({
        characterWorldsPolicy: () => { throw new Error("boom"); },
        resolveOwnerScope: () => "profile:account:x",
      }),
      { enabled: false },
    );
  });

  // --- registry availability gate ---------------------------------------------
  await check("drafting needs no session: the tool is a policy-gated PLATFORM tool", async () => {
    assert.ok(
      toolNames(CONTEXT, deps).includes("lily_character_draft"),
      "session context + enabled policy lists the draft tool",
    );
    assert.ok(
      toolNames({ platformOnly: true, activeSkillIds: [] }, deps).includes("lily_character_draft"),
      "drafts create unbound owner-scoped library entities — the platformOnly " +
      "production transport lists the tool when the policy is enabled",
    );
    assert.equal(
      toolNames(CONTEXT, makeDeps({ characterWorldsPolicy: () => ({ enabled: false }) }))
        .includes("lily_character_draft"),
      false,
      "disabled policy hides the tool",
    );
    assert.equal(
      toolNames({ platformOnly: true, activeSkillIds: [] },
        makeDeps({ characterWorldsPolicy: () => ({ enabled: false }) }))
        .includes("lily_character_draft"),
      false,
      "disabled policy hides the tool from the platform transport too",
    );
    assert.equal(
      toolNames({ activeSkillIds: [] }, deps).includes("lily_character_draft"),
      false,
      "a context with neither sessionId nor platformOnly still fails closed",
    );
  });

  await check("kill switch hides the tool through the default policy resolver", async () => {
    process.env.LILY_CHARACTER_WORLDS = "0";
    try {
      // No injected policy: the tool resolves the real remote-config policy,
      // and the kill switch always wins.
      assert.equal(
        toolNames(CONTEXT, makeDeps({ characterWorldsPolicy: undefined }))
          .includes("lily_character_draft"),
        false,
      );
      // The env kill switch is checked BEFORE any injected resolver.
      assert.equal(
        toolNames(CONTEXT, deps).includes("lily_character_draft"),
        false,
        "even an injected enabled policy cannot override LILY_CHARACTER_WORLDS=0",
      );
      const blocked = await call({ action: "create", kind: "character", canonical: { name: "Nope" } });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.error, "CHARACTER_WORLDS_UNAVAILABLE");
    } finally {
      delete process.env.LILY_CHARACTER_WORLDS;
    }
  });

  await check("a valid injected characterWorlds block enables the tool; the env kill switch still wins", async () => {
    const injectedContext = {
      platformOnly: true,
      activeSkillIds: [],
      characterWorlds: { enabled: true, ownerScope: "profile:account:injected" },
    };
    // The injected block is authoritative over a locally-disabled derivation
    // (the subprocess cannot decrypt the cached policy — this is the fix).
    assert.ok(
      toolNames(injectedContext, makeDeps({ characterWorldsPolicy: () => ({ enabled: false }) }))
        .includes("lily_character_draft"),
      "an injected enabled block beats a locally-disabled policy derivation",
    );
    // LILY_CHARACTER_WORLDS=0 is checked FIRST and still wins over injection.
    process.env.LILY_CHARACTER_WORLDS = "0";
    try {
      assert.equal(
        toolNames(injectedContext, deps).includes("lily_character_draft"),
        false,
        "the env kill switch always beats an injected enabled block",
      );
      const blocked = await tool.handler(
        { action: "create", kind: "character", canonical: { name: "Nope" } },
        injectedContext,
        deps,
      );
      assert.equal(blocked.ok, false);
      assert.equal(blocked.error, "CHARACTER_WORLDS_UNAVAILABLE");
    } finally {
      delete process.env.LILY_CHARACTER_WORLDS;
    }
  });

  await check("malformed injected characterWorlds values fail closed, never enabling the tool", async () => {
    const malformed = [
      { enabled: "yes", ownerScope: "x" },
      { enabled: true },                       // ownerScope missing
      { enabled: true, ownerScope: "" },       // empty owner scope
      { enabled: false, ownerScope: "x" },     // disabled block
      { enabled: true, ownerScope: 42 },       // wrong owner type
      "not-an-object",
      [{ enabled: true, ownerScope: "x" }],
    ];
    for (const value of malformed) {
      const ctx = { platformOnly: true, activeSkillIds: [], characterWorlds: value };
      assert.equal(
        toolNames(ctx, deps).includes("lily_character_draft"),
        false,
        `a malformed injected block fails closed even with an enabled local policy: ${JSON.stringify(value)}`,
      );
    }
  });

  await check("an ABSENT characterWorlds block keeps the local Linux-dev derivation", async () => {
    // No context channel at all (dev/unit-test transports): the tool keeps
    // today's local behavior — a locally-enabled policy lists it and the
    // local owner scope drafts it.
    const ctx = { platformOnly: true, activeSkillIds: [] };
    assert.ok(
      toolNames(ctx, deps).includes("lily_character_draft"),
      "absent block falls back to the local policy derivation",
    );
    currentOwner = "profile:local:absent-fallback";
    try {
      const created = await tool.handler(
        { action: "create", kind: "character", canonical: { name: "Local Fallback" } },
        ctx,
        deps,
      );
      assert.equal(created.ok, true, JSON.stringify(created));
      assert.equal(
        repository.listCharacters("profile:local:absent-fallback").some((c) => c.id === created.entityId),
        true,
        "the local owner derivation receives the draft when no block is injected",
      );
    } finally {
      currentOwner = OWNER;
    }
  });

  await check("invocation while disabled fails closed with a coded error and writes nothing", async () => {
    const disabled = buildCharacterDraftTool(makeDeps({
      characterWorldsPolicy: () => ({ enabled: false, reason: "kill_switch" }),
    }));
    const result = await disabled.handler(
      { action: "create", kind: "character", canonical: { name: "Nope" } },
      CONTEXT,
      deps,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "CHARACTER_WORLDS_UNAVAILABLE");
    assert.equal(repository.listCharacters(OWNER).length, 0, "no durable write");
  });

  await check("missing authoring service dependency fails closed coded", async () => {
    const unwired = buildCharacterDraftTool(makeDeps({ characterWorldsService: null }));
    const result = await unwired.handler(
      { action: "create", kind: "character", canonical: { name: "Nope" } },
      CONTEXT,
      {},
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "CHARACTER_WORLDS_UNAVAILABLE");
    assert.equal(repository.listCharacters(OWNER).length, 0);
  });

  // --- create: validated through the authoring service -------------------------
  const luna = await check("create drafts a character with agent_draft provenance, metadata-only result", async () => {
    const result = await call({
      action: "create",
      kind: "character",
      canonical: { name: "Luna", description: "Navigator" },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      Object.keys(result).sort(),
      ["entityId", "ok", "revisionId", "revisionNumber"],
      "results are metadata-only — no canonical echo, no entity payload",
    );
    assert.equal(result.revisionNumber, 1);
    const revision = repository.getRevision(OWNER, result.revisionId);
    assert.equal(revision.characterId, result.entityId);
    assert.equal(revision.source.kind, AGENT_DRAFT_SOURCE_KIND);
    assert.equal(revision.source.kind, "agent_draft");
    assert.equal(revision.source.format, "lily");
    assert.equal(revision.source.container, "json");
    assert.equal(revision.canonical.name, "Luna");
    const history = await authoring.characterHistory({ ownerScope: OWNER, entityId: result.entityId });
    assert.equal(history.revisions[0].sourceKind, "agent_draft", "history surfaces the badge kind");
    assert.equal(
      JSON.stringify(result).includes("Navigator"),
      false,
      "the result never echoes canonical content back to the model",
    );
    return result;
  });

  await check("create drafts a world book into the library instead of a Markdown file", async () => {
    const result = await call({
      action: "create",
      kind: "worldBook",
      canonical: {
        name: "霓虹城",
        entries: [{ id: "district", keys: ["旧城区"], content: "雨夜中的旧城区。" }],
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const revision = repository.getWorldBookRevision(OWNER, result.revisionId);
    assert.equal(revision.worldBookId, result.entityId);
    assert.equal(revision.source.kind, "agent_draft");
    assert.equal(revision.canonical.name, "霓虹城");
  });

  await check("hostile create input fails with the identical authoring codes", async () => {
    // Aligned with the IPC guard (MAX_AUTHORING_PAYLOAD_BYTES = 1 MiB): a
    // payload whose serialized size exceeds the cap is rejected at the
    // boundary with INVALID_INPUT — the same code the library UI gets, so the
    // tool never admits an edit the UI could not.
    const oversized = await call({
      action: "create",
      kind: "character",
      canonical: { name: "x".repeat(MAX_CHARACTER_TEXT_FIELD_BYTES + 1) },
    });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error, "INVALID_INPUT");

    const dangerous = await call({
      action: "create",
      kind: "character",
      canonical: JSON.parse('{"__proto__":{"polluted":true},"name":"x"}'),
    });
    assert.equal(dangerous.ok, false);
    assert.equal(dangerous.error, "CARD_DANGEROUS_KEY");

    const blank = await call({ action: "create", kind: "character", canonical: { name: "   " } });
    assert.equal(blank.ok, false);
    assert.equal(blank.error, "CARD_ROOT_INVALID");

    const wrongType = await call({ action: "create", kind: "character", canonical: { name: 42 } });
    assert.equal(wrongType.ok, false);
    assert.equal(wrongType.error, "CARD_JSON_INVALID");

    const personaAuthz = await call({
      action: "create",
      kind: "persona",
      canonical: { name: "Bad", role: "admin" },
    });
    assert.equal(personaAuthz.ok, false);
    assert.equal(personaAuthz.error, "PERSONA_DATA_INVALID");
    assert.equal(repository.listCharacters(OWNER).length, 1, "rejections write nothing");
  });

  await check("executable keys are screened with authoring parity and reported", async () => {
    const result = await call({
      action: "create",
      kind: "character",
      canonical: { name: "Scripted", script: "run()", plugins: ["evil"], lore: "inert" },
    });
    assert.equal(result.ok, true);
    assert.deepEqual([...result.droppedExecutableKeys].sort(), ["plugins", "script"]);
    const revision = repository.getRevision(OWNER, result.revisionId);
    assert.equal(Object.hasOwn(revision.canonical, "script"), false);
    assert.equal(revision.canonical.lore, "inert");
    assert.equal(revision.source.kind, "agent_draft");
  });

  // --- revise: explicit entity + CAS -------------------------------------------
  await check("revise requires entityId and expectedBaseRevisionId (coded INVALID_INPUT)", async () => {
    const missingEntity = await call({
      action: "revise", kind: "character", canonical: { name: "x" },
    });
    assert.equal(missingEntity.ok, false);
    assert.equal(missingEntity.error, "INVALID_INPUT");
    const missingBase = await call({
      action: "revise", kind: "character", entityId: luna.entityId, canonical: { name: "x" },
    });
    assert.equal(missingBase.ok, false);
    assert.equal(missingBase.error, "INVALID_INPUT");
    const badIdFormat = await call({
      action: "revise",
      kind: "character",
      entityId: "../escape",
      expectedBaseRevisionId: luna.revisionId,
      canonical: { name: "x" },
    });
    assert.equal(badIdFormat.ok, false);
    assert.equal(badIdFormat.error, "INVALID_INPUT");
  });

  const lunaRevise = await check("revise creates a new agent_draft revision pinned to its parent", async () => {
    const result = await call({
      action: "revise",
      kind: "character",
      entityId: luna.entityId,
      expectedBaseRevisionId: luna.revisionId,
      canonical: { name: "Luna", description: "Storm navigator" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.entityId, luna.entityId);
    assert.equal(result.revisionNumber, 2);
    const revision = repository.getRevision(OWNER, result.revisionId);
    assert.equal(revision.parentRevisionId, luna.revisionId);
    assert.equal(revision.source.kind, "agent_draft");
    return result;
  });

  await check("stale base returns the coded conflict with currentRevisionId", async () => {
    const conflict = await call({
      action: "revise",
      kind: "character",
      entityId: luna.entityId,
      expectedBaseRevisionId: luna.revisionId, // stale: tip is revision 2
      canonical: { name: "Luna", description: "Conflicting" },
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "CHARACTER_REVISION_CONFLICT");
    assert.equal(conflict.currentRevisionId, lunaRevise.revisionId);

    const persona = await call({
      action: "create", kind: "persona", canonical: { name: "Aurelia" },
    });
    assert.equal(persona.ok, true);
    const personaConflict = await call({
      action: "revise",
      kind: "persona",
      entityId: persona.entityId,
      expectedBaseRevisionId: "not-the-tip",
      canonical: { name: "Aurelia" },
    });
    assert.equal(personaConflict.ok, false);
    assert.equal(personaConflict.error, "PERSONA_REVISION_CONFLICT");
    assert.equal(personaConflict.currentRevisionId, persona.revisionId);
  });

  // --- no activation: structural + behavioral proof ------------------------------
  await check("the tool module has no call path to binding mutation (source inspection)", async () => {
    const source = fs.readFileSync(
      path.join(HERE, "../src/main/character-worlds/agent-draft-tools.js"),
      "utf8",
    );
    for (const forbidden of ["setBinding", "writeBinding", "updateBinding", "applyUpdate", "bindingVersion"]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `agent-draft-tools.js must not reference ${forbidden}`,
      );
    }
  });

  await check("drafting the ACTIVE character creates only a revision; the binding is untouched", async () => {
    const human = await authoring.createCharacter({
      ownerScope: OWNER,
      canonical: { name: "Bound Hero" },
    });
    repository.setBinding({
      sessionId: SESSION,
      ownerScope: OWNER,
      expectedBindingVersion: 0,
      next: { mode: "character", characterRevisionId: human.revision.id },
    });
    const before = repository.getBinding(SESSION, OWNER);
    assert.equal(before.characterRevisionId, human.revision.id);

    const revised = await call({
      action: "revise",
      kind: "character",
      entityId: human.entity.id,
      expectedBaseRevisionId: human.revision.id,
      canonical: { ...human.revision.canonical, description: "Revised by the agent" },
    });
    assert.equal(revised.ok, true);
    assert.notEqual(revised.revisionId, human.revision.id);
    const after = repository.getBinding(SESSION, OWNER);
    assert.equal(
      after.characterRevisionId,
      human.revision.id,
      "§8: the binding stays pinned; update-available/apply is the human flow",
    );
    assert.equal(after.version, before.version, "no binding version bump");

    const created = await call({
      action: "create", kind: "character", canonical: { name: "Side Draft" },
    });
    assert.equal(created.ok, true);
    assert.equal(
      repository.getBinding(SESSION, OWNER).characterRevisionId,
      human.revision.id,
      "create never touches the session binding either",
    );
  });

  // --- bounded args --------------------------------------------------------------
  await check("args are bounded: payload cap, plain-object canonical, allowlisted fields", async () => {
    const oversized = await call({
      action: "create",
      kind: "character",
      canonical: { name: "ok", blob: "x".repeat(MAX_DRAFT_PAYLOAD_BYTES) },
    });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error, "INVALID_INPUT");

    for (const canonical of [null, "text", [1, 2], 42]) {
      const result = await call({ action: "create", kind: "character", canonical });
      assert.equal(result.ok, false);
      assert.equal(result.error, "INVALID_INPUT");
    }
    const badAction = await call({ action: "delete", kind: "character", canonical: { name: "x" } });
    assert.equal(badAction.ok, false);
    assert.equal(badAction.error, "INVALID_INPUT");
    // Unknown top-level args never reach the domain input.
    const smuggled = await call({
      action: "create",
      kind: "character",
      canonical: { name: "Allowlist" },
      entityId: "ignored-on-create",
      hack: "ignored",
    });
    assert.equal(smuggled.ok, true);
    const entity = repository.getCharacter(OWNER, smuggled.entityId);
    assert.notEqual(entity.id, "ignored-on-create");
  });

  // --- owner scope -----------------------------------------------------------------
  await check("the tool passes the resolved owner scope through the authoring check", async () => {
    currentOwner = "profile:local:other";
    try {
      const result = await call({
        action: "create", kind: "character", canonical: { name: "Wrong Owner" },
      });
      // resolveOwnerScope (dep) and the authoring service agree on the new
      // owner, so the draft lands in the other owner's namespace — never in
      // the original one.
      assert.equal(result.ok, true);
      assert.equal(
        repository.listCharacters("profile:local:other").some((c) => c.id === result.entityId),
        true,
      );
    } finally {
      currentOwner = OWNER;
    }
  });

  await check("an injected ownerScope is authoritative over the local derivation", async () => {
    // The subprocess cannot decrypt the account refreshToken, so its local
    // derivation would fall back to device scope for logged-in users. The
    // main process injects the real account scope and the tool MUST use it.
    const injectedContext = {
      ...CONTEXT,
      characterWorlds: { enabled: true, ownerScope: "profile:account:injected" },
    };
    currentOwner = "profile:local:other"; // a deliberately DIFFERENT local derivation
    try {
      const result = await tool.handler(
        { action: "create", kind: "character", canonical: { name: "Injected Owner" } },
        injectedContext,
        deps,
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(
        repository.listCharacters("profile:account:injected").some((c) => c.id === result.entityId),
        true,
        "the draft lands in the INJECTED owner scope",
      );
      assert.equal(
        repository.listCharacters("profile:local:other").some((c) => c.id === result.entityId),
        false,
        "the local device-scope derivation never receives the draft",
      );
    } finally {
      currentOwner = OWNER;
    }
  });

  // --- subprocess end-to-end (the production stdio transport) --------------------
  // Seeds a remote-config cache in the same file format the main process
  // writes (signature verification happens at refresh time; the cache itself
  // is trusted-local state, base64-plaintext when safeStorage is absent).
  function seedRemoteConfigCache(userDataDir, characterWorldsPolicyBlock) {
    const state = {
      schemaVersion: 1,
      configVersion: 1,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      effectiveConfig: { characterWorlds: characterWorldsPolicyBlock },
    };
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, "remote-config-cache.json"), JSON.stringify({
      config: {
        encrypted: false,
        data: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
      },
      updatedAt: new Date().toISOString(),
    }));
  }

  async function withStdioBroker(env, fn) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(HERE, "../src/main/mcp/tool-broker-stdio.js")],
      env,
    });
    const client = new Client({ name: "draft-e2e", version: "1.0.0" });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      // Clean, fast exit: the lazy authoring path spawns no worker pool or
      // broker helper, so closing the client must reap the subprocess promptly.
      await Promise.race([
        client.close(),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("broker subprocess did not exit promptly — unexpected lingering worker")),
          15000,
        )),
      ]);
    }
  }

  function brokerEnv(userDataDir, extra = {}) {
    const env = {
      ...process.env,
      LILY_USER_DATA_DIR: userDataDir,
      LILY_TOOL_BROKER_CONTEXT: JSON.stringify({ platformOnly: true, activeSkillIds: [] }),
    };
    delete env.LILY_CHARACTER_WORLDS;
    return { ...env, ...extra };
  }

  await check("stdio subprocess: platformOnly transport drafts end-to-end, WAL-visible cross-process", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-draft-userdata-"));
    try {
      seedRemoteConfigCache(userData, {
        enabled: true,
        compatibilityProfile: "lily-character-compat-1",
        minimumClientVersion: "0.0.0",
      });
      const drafted = await withStdioBroker(brokerEnv(userData), async (client) => {
        const { tools } = await client.listTools();
        assert.ok(
          tools.some((entry) => entry.name === "lily_character_draft"),
          "draft tool listed in the platformOnly production transport",
        );
        const created = JSON.parse((await client.callTool({
          name: "lily_character_draft",
          arguments: {
            action: "create",
            kind: "character",
            canonical: { name: "Subprocess Luna", description: "drafted over stdio" },
          },
        })).content[0].text);
        assert.equal(created.ok, true, `create through the subprocess: ${JSON.stringify(created)}`);
        assert.equal(created.revisionNumber, 1);
        const revised = JSON.parse((await client.callTool({
          name: "lily_character_draft",
          arguments: {
            action: "revise",
            kind: "character",
            entityId: created.entityId,
            expectedBaseRevisionId: created.revisionId,
            canonical: { name: "Subprocess Luna", description: "revised over stdio" },
          },
        })).content[0].text);
        assert.equal(revised.ok, true, `revise through the subprocess: ${JSON.stringify(revised)}`);
        assert.equal(revised.revisionNumber, 2);
        return revised;
      });
      // Cross-process visibility via WAL: a SECOND MessageStore handle in this
      // process reads what the broker subprocess committed (canonical_json is
      // gzip-packed on disk, so the read-back goes through the repository).
      const second = new MessageStore(
        path.join(userData, "messages.db"),
        path.join(userData, "blobs"),
      );
      const row = second.db.get(
        "SELECT owner_scope, source_kind FROM character_revisions WHERE id = ?",
        drafted.revisionId,
      );
      assert.ok(row, "the drafted revision persists in the shared store");
      assert.equal(row.source_kind, "agent_draft", "subprocess drafts carry agent provenance");
      const secondRepository = new CharacterWorldsRepository(second);
      const revision = secondRepository.getRevision(row.owner_scope, drafted.revisionId);
      assert.equal(revision.canonical.description, "revised over stdio");
      assert.equal(revision.source.kind, "agent_draft");
      assert.equal(revision.revisionNumber, 2);
      assert.equal(
        second.db.get("SELECT COUNT(*) AS n FROM character_session_bindings").n,
        0,
        "no session binding was written by the draft tool",
      );
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  await check("stdio subprocess: disabled policy (no cache) hides the tool", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-draft-userdata-"));
    try {
      await withStdioBroker(brokerEnv(userData), async (client) => {
        const { tools } = await client.listTools();
        assert.equal(
          tools.some((entry) => entry.name === "lily_character_draft"),
          false,
          "absent/stale remote policy disables the feature (fail closed)",
        );
        let protocolBlocked = false;
        try {
          const res = await client.callTool({ name: "lily_character_draft", arguments: {} });
          protocolBlocked = res.isError === true
            || JSON.parse(res.content[0].text).ok === false;
        } catch {
          protocolBlocked = true;
        }
        assert.equal(
          protocolBlocked,
          true,
          "an unregistered tool is not callable at the protocol level either",
        );
      });
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  await check("stdio subprocess: kill switch beats an enabled cached policy", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-draft-userdata-"));
    try {
      seedRemoteConfigCache(userData, {
        enabled: true,
        compatibilityProfile: "lily-character-compat-1",
        minimumClientVersion: "0.0.0",
      });
      await withStdioBroker(
        brokerEnv(userData, { LILY_CHARACTER_WORLDS: "0" }),
        async (client) => {
          const { tools } = await client.listTools();
          assert.equal(
            tools.some((entry) => entry.name === "lily_character_draft"),
            false,
            "LILY_CHARACTER_WORLDS=0 always wins",
          );
        },
      );
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  await check("stdio subprocess: an injected enabled block works with NO decryptable cache and pins the owner scope", async () => {
    // The production failure the fix targets: under ELECTRON_RUN_AS_NODE the
    // subprocess cannot decrypt the cached remote policy (so local derivation
    // reads disabled) NOR the account refreshToken (so local owner falls back
    // to device scope). The main process injects the block; the subprocess
    // must list the tool and draft into the INJECTED owner scope — here with
    // no remote-config cache at all.
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-draft-userdata-"));
    try {
      const injectedContext = {
        platformOnly: true,
        activeSkillIds: [],
        characterWorlds: { enabled: true, ownerScope: "profile:account:injected" },
      };
      await withStdioBroker(
        brokerEnv(userData, { LILY_TOOL_BROKER_CONTEXT: JSON.stringify(injectedContext) }),
        async (client) => {
          const { tools } = await client.listTools();
          assert.ok(
            tools.some((entry) => entry.name === "lily_character_draft"),
            "injected enabled block lists the tool without any decryptable cache",
          );
          const created = JSON.parse((await client.callTool({
            name: "lily_character_draft",
            arguments: { action: "create", kind: "character", canonical: { name: "Injected Scope" } },
          })).content[0].text);
          assert.equal(created.ok, true, JSON.stringify(created));
          const second = new MessageStore(path.join(userData, "messages.db"), path.join(userData, "blobs"));
          const row = second.db.get(
            "SELECT owner_scope FROM character_revisions WHERE id = ?",
            created.revisionId,
          );
          assert.equal(
            row.owner_scope,
            "profile:account:injected",
            "the draft lands in the injected account scope, never device scope",
          );
        },
      );
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  await check("stdio subprocess: an injected disabled block hides the tool even with an enabled cache", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-draft-userdata-"));
    try {
      seedRemoteConfigCache(userData, {
        enabled: true,
        compatibilityProfile: "lily-character-compat-1",
        minimumClientVersion: "0.0.0",
      });
      const injectedContext = {
        platformOnly: true,
        activeSkillIds: [],
        characterWorlds: { enabled: false },
      };
      await withStdioBroker(
        brokerEnv(userData, { LILY_TOOL_BROKER_CONTEXT: JSON.stringify(injectedContext) }),
        async (client) => {
          const { tools } = await client.listTools();
          assert.equal(
            tools.some((entry) => entry.name === "lily_character_draft"),
            false,
            "an injected disabled block is authoritative over an enabled cache",
          );
        },
      );
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  await check("stdio subprocess: the env kill switch beats an injected enabled block", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-draft-userdata-"));
    try {
      const injectedContext = {
        platformOnly: true,
        activeSkillIds: [],
        characterWorlds: { enabled: true, ownerScope: "profile:account:injected" },
      };
      await withStdioBroker(
        brokerEnv(userData, {
          LILY_CHARACTER_WORLDS: "0",
          LILY_TOOL_BROKER_CONTEXT: JSON.stringify(injectedContext),
        }),
        async (client) => {
          const { tools } = await client.listTools();
          assert.equal(
            tools.some((entry) => entry.name === "lily_character_draft"),
            false,
            "LILY_CHARACTER_WORLDS=0 still wins over an injected enabled block",
          );
        },
      );
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  console.log(`PASS: test-character-agent-draft (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
