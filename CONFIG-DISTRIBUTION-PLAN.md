# Config distribution — clean redesign + image/video multi-select

Goal (from product owner): the 配置下发 page is messy. Make the **default distribution**
a clean "scope + multi-select + one default" screen, and bring **image/video generation
providers** under the SAME model as chat models — multi-select, a default, and
per-group / per-device override.

## What already exists (verified — do NOT rebuild)
- **Chat models**: multi-select + default already work via the profile "menu mode"
  (`config.models.presets` + `activePresetId`; the single-selected provider/model is the
  default). `config-profile-form.js` already uses `MultiSelectField`.
- **Scope**: global / device-group / license / device already exist on every profile.
- **Per-scope override**: profiles store a free-form `config` blob (`z.record(z.any())`)
  that is `deepMerge`d global→group→device by priority (`client-config.js deepMerge`).
  **Arrays REPLACE on merge** → a group/device sets its OWN full list (override). "追加"
  = include the base entries + extras in that scope's list (same as chat models today).

## The real gaps
1. **Page is confusing** — 5 tabs + a 657-line form bury the multi/default/scope controls.
2. **Image/video generation is NOT per-profile** — media is delivered as server-wide
   `runtime.env` (e.g. `DASHSCOPE_IMAGE_MODEL`) keyed on server keys, with no
   multi-select / default / per-scope selection like chat models have.

## Data model (the contract)
Add to a profile's `config` blob (deep-merged per scope, free override for group/device):
```
config.media = {
  image: { providers: ["dashscope", "volcengine"], default: "dashscope" },
  video: { providers: ["dashscope"],               default: "dashscope" },
}
```
- `providers`: which media-gen providers this scope may use (multi-select).
- `default`: the one selected by default on the client (must be in `providers`).
- Empty/absent ⇒ fall back to today's behavior (all key-backed providers, server default).

## Layers

### Layer 1 — Server resolution (`server/src/services/client-config.js`)
- `availableMediaProviders(serverConfig)` → the media-gen providers that actually have a
  key server-side (dashscope, volcengine, kling, minimax, zhipu — whichever are
  configured). This is the gate: never offer a provider with no key.
- In `buildEnvManagedClientConfig`, read the merged `config.media`, intersect each
  `providers` list with `availableMediaProviders`, validate `default ∈ providers`
  (else first), and emit a structured field:
  ```
  effectiveConfig.media = {
    image: { providers: [...], default },
    video: { providers: [...], default },
  }
  ```
  Keep the existing per-provider `runtime.env` (the actual model/endpoint/key plumbing)
  untouched — this only adds the SELECTION + DEFAULT, gated by availability.
- **Fail-open:** no `config.media`, or empty after gating → omit `media` ⇒ client keeps
  today's behavior (all available, local default). Worst case == today (Rule 13).
- Test: `server/scripts/` (or a node test) — given a merged config with `config.media`
  and a serverConfig with some keys, assert the emitted `media` is gated + default valid;
  given none, assert no `media` and no regression.

### Layer 2 — Client consumption (`src/main/ipc-models.js` + media settings)
- `media-providers:list` honors the server-delivered `effectiveConfig.media` (the
  allowed set + default), like chat presets honor `activePresetId`. Local selection is
  still allowed but constrained to the delivered set; default falls back to the delivered
  default, else local.
- **Fail-open:** if no delivered `media`, keep today's local list/default.
- Test: closed-loop on the resolver (delivered media → list/default), incl. the
  no-delivery fallback.

### Layer 3 — Admin form + page (`web/components/config-profile-form.js`, `config/page.js`)
- Clean layout: **scope** selector on top; then three clear blocks —
  **聊天模型** (existing menu, surfaced), **图片生成** (multi + default), **视频生成**
  (multi + default); advanced (skills/permissions/version) collapsed.
- The image/video blocks are `MultiSelectField` + a "default" radio, writing
  `config.media.image/video`. Provider options come from
  `/api/admin/model-providers` filtered to media-gen providers.
- Same form at scope=group/device ⇒ writes that scope's `config.media` (override).
- Reduce the 657-line form's visual clutter (group sections, collapse advanced).

## Capability gate (Rule 13)
- Each layer ships a fail-open path (no media selection ⇒ today's behavior) + a test.
- Register the vector in `CAPABILITY-GATE.md`: "media-gen distribution must degrade to
  the current all-available/local-default behavior, never to no-media".

## Build order
1. **Layer 1** (server resolution + test) — foundation, isolated, testable now.
2. **Layer 3** (admin form writes `config.media`) — visible "理清页面" value.
3. **Layer 2** (client honors delivered media) — closes the loop.
4. Live verify on a real build (admin sets media for a group → device receives it).

## Note
Recommend committing the pending session **data-loss fix** + steer/minimap first so this
multi-layer feature starts from a clean, safe base (the data-loss guard protects users
right now).
