# Media Provider Contract Design

## Context

Lily currently supports media generation through a mix of server env variables,
client settings, gateway routes, and provider-specific skill scripts:

- `server/src/services/client-config.js` decides which media providers and env
  values are delivered to clients.
- `src/main/media-provider-settings.js` stores image/video/speech selections and
  checks whether a provider appears usable.
- `server/src/services/media-gateway.js` proxies service-backed providers and
  injects server-side secrets.
- `resources/skills/lily-{image,video,speech}-generation/scripts/*` contain
  provider-specific request shapes, defaults, result extraction, and downloads.

This works for known providers but has the wrong ownership boundary. The agent
and client scripts are forced to know details such as Lily TTS voice names,
DashScope payload shape, polling behavior, and URL extraction. When a provider
changes or a customer adds a custom provider, the platform either becomes brittle
or needs one-off patches.

## Goal

Make Lily an intelligent platform by moving provider protocol knowledge into a
server-delivered, machine-readable contract. The agent should understand the
current selected provider and its usable parameters from that contract. Skill
scripts should execute the contract deterministically instead of guessing or
hard-coding each provider's request format.

## Non-Goals

- Do not add a new primary UI workflow. Natural language remains the main path.
- Do not remove the existing provider-specific scripts in one risky migration.
- Do not require old clients to understand the new contract before they keep
  working.
- Do not let the model invent request payloads when a deterministic contract can
  build them.

## Contract Shape

The server will expose a `media.contracts` block in the same effective config
path that already delivers media provider selections. The block is additive, so
old clients ignore it.

Each contract is keyed by modality and provider:

```json
{
  "schemaVersion": 1,
  "media": {
    "selected": {
      "image": "lily",
      "video": "lily",
      "speech": "lily"
    },
    "contracts": {
      "speech": {
        "lily": {
          "displayName": "Lily GPU Speech (Qwen3-TTS)",
          "endpointEnv": "LILY_MEDIA_SPEECH_ENDPOINT",
          "authEnv": "LILY_MEDIA_API_KEY",
          "request": {
            "method": "POST",
            "contentType": "application/json",
            "template": {
              "text": "{{text}}",
              "input": "{{text}}",
              "voice": "{{voice}}",
              "format": "{{format}}",
              "sample_rate": "{{sample_rate}}",
              "model": "{{model}}"
            }
          },
          "params": {
            "text": { "type": "string", "required": true },
            "voice": {
              "type": "string",
              "default": "aiden",
              "enum": ["aiden", "dylan", "eric", "ono_anna", "ryan", "serena", "sohee", "uncle_fu", "vivian"],
              "aliases": { "default": "aiden", "longanyang": "aiden" }
            },
            "format": { "type": "string", "default": "wav", "enum": ["wav", "mp3", "pcm"] },
            "sample_rate": { "type": "number", "default": 24000 },
            "model": { "type": "string", "default": "qwen3-tts" }
          },
          "response": {
            "mediaType": "speech",
            "extract": [
              "$.file",
              "$.output.audio.url",
              "$.audio_url",
              "$.audio_base64"
            ],
            "assetProxy": "lily"
          },
          "errors": {
            "unsupportedParam": "fail-before-request",
            "providerFailure": "report-no-fallback"
          }
        }
      }
    }
  }
}
```

The initial schema only needs the features used by image, video, speech, and
search. It should be versioned and small enough to render into AGENT.md.

## Data Flow

1. Admin/server config defines built-in provider contracts for Lily, DashScope,
   Volcengine, Kling, MiniMax, Zhipu, and search providers.
2. `client-config` filters contracts by available server keys, BYOK state, user
   settings, and region policy.
3. The desktop app persists only user selection and BYOK secrets. It does not
   persist generated copies of server contracts as authoritative state.
4. `media-provider-settings` exposes selected provider plus effective contract
   to spawn env and guide generation.
5. `skill-manager` renders a concise provider guide from the contract: current
   provider, supported params/enums, default values, output rules, and failure
   policy.
6. Media generation scripts call one shared contract executor:
   - validate input against `params`;
   - apply aliases and defaults;
   - materialize `request.template`;
   - call the endpoint with the configured auth;
   - extract result URLs/base64/files using `response.extract`;
   - download through the provider asset rules;
   - emit the existing `<generated_media>` contract.
7. `media-gateway` uses the same contract for server-side validation and
   normalization before forwarding to private GPU services.

## Agent Behavior

The agent should not guess provider internals. AGENT.md should say, for example:

- Current speech provider: `lily`.
- Supported voices: `aiden`, `dylan`, `eric`, `ono_anna`, `ryan`, `serena`,
  `sohee`, `uncle_fu`, `vivian`.
- Default voice: `aiden`.
- If the provider fails, report the error and ask whether to retry, switch
  provider, or configure/provide a key. Do not auto-switch.

For unconfigured modalities, AGENT.md should say there is no active provider and
list available choices if any. It should not pretend DashScope or Lily exists
when that provider is not available.

## Custom Providers

Customer-defined providers use the same contract shape. The admin UI can start
with a JSON editor plus validation instead of a large visual builder. A custom
provider must define:

- modality;
- endpoint or gateway base;
- auth scheme;
- request template;
- parameter schema/defaults/enums;
- response extraction rules;
- asset download/proxy policy.

Invalid custom contracts are disabled loudly and do not affect built-in
providers.

## Compatibility

This migration must be fail-open:

- If a client does not understand `media.contracts`, it keeps using current env
  variables and scripts.
- If the contract is missing for a provider, scripts fall back to the existing
  provider implementation for known built-ins.
- If a contract is malformed, the selection remains visible but execution fails
  with a clear configuration error and never invents a provider.
- The gateway keeps compatibility normalizers for known legacy inputs during the
  transition, including old Lily speech voices.

## Implementation Phases

### Phase 1: Contract Delivery

- Add built-in media/search contract definitions on the server.
- Include filtered contracts in effective client config.
- Add tests proving old config is unchanged when `media.contracts` is absent.
- Render contract summaries in AGENT.md for selected providers.

### Phase 2: Shared Contract Executor

- Add a shared Node executor under `resources/skills/_shared` or a bundled
  runtime helper.
- Migrate `lily-speech-generation` first because it exposed the voice bug.
- Keep provider-specific fallback code for the first release.
- Add tests for defaults, aliases, enum validation, result extraction, and asset
  download.

### Phase 3: Gateway Contract Validation

- Make `media-gateway` normalize and validate requests using the same built-in
  contract definitions.
- Return clear 400s for invalid inputs and preserve upstream error bodies for
  provider failures.
- Add tests that invalid input never reaches the GPU service.

### Phase 4: Image, Video, Search, and Custom Providers

- Migrate image and video scripts to the executor.
- Add web search contracts so search provider selection is governed by the same
  model.
- Add admin validation for custom provider contracts.
- Remove provider-specific script branches only after parity tests pass.

## Tests and Capability Gate

Required guard tests:

- `test-client-config-service.mjs`: contracts are additive; old clients still
  get current env values and defaults.
- `test-agent-guide-i18n.mjs`: AGENT.md reflects selected provider contracts and
  does not name unavailable providers.
- `test-media-provider-contracts.mjs`: contract schema validation, defaulting,
  aliases, enum failures, request materialization, response extraction.
- `test-media-gateway-providers.mjs`: gateway validates via contracts and does
  not forward invalid provider params.
- `test-media-generation-skills.mjs`: scripts generate image/video/speech using
  contract execution and still emit `<generated_media>`.

This change should add a new `CAPABILITY-GATE.md` row: provider protocol changes
must be contract-driven and must not require agent guesswork or per-provider
prompt patches.

## Self-Review

- No placeholder fields remain; the schema and phases are concrete enough to
  plan.
- The design preserves current behavior for old clients and malformed/missing
  contracts.
- The first implementation target is intentionally narrow: speech contract
  execution, then gateway validation, then broader media/search migration.
- The agent remains intelligent about user intent, while request construction is
  deterministic and testable.
