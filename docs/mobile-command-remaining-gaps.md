# Lily Mobile Command Pro Remaining Gaps

## 1. Status

The current document set is strong enough for architecture review and implementation planning. It is not yet a complete build-ready specification for a top-tier production release.

This file lists what is still missing or under-specified.

## 2. Remaining Critical Gaps

### 2.1 Concrete Repository Integration

Status: first-pass implementation map exists in [Mobile Command Repo Implementation Map](mobile-command-repo-implementation-map.md).

Still missing:

- Verification against actual exports and route registration patterns.
- Final decision whether mobile web lives under `web/mobile-command/` or separate `mobile/`.
- Exact migration timestamp/name at implementation time.
- Code-level dependency graph after reading existing modules.

Needed:

- Pre-implementation code audit.
- Final per-PR task breakdown.

### 2.2 Machine-Readable Schemas

Status: first-pass machine-readable drafts exist:

- [OpenAPI draft](schemas/mobile-command.openapi.yaml)
- [Events schema draft](schemas/mobile-command-events.schema.json)
- [Native bridge schema draft](schemas/mobile-command-native-bridge.schema.json)

Still missing:

- Shared generated TypeScript types.
- Validation against real server route implementation.
- Full upload/artifact/device route coverage in OpenAPI.

Needed:

- `src/shared/mobile-command/schemas/*`
- Schema validation tests using real schema files.

### 2.3 Real Account / License / Device Data Model

Current DB design uses generic `account_id`, `desktop_device_id`, and `mobile_device_id`.

Missing:

- How this maps to the existing license/account/device tables.
- Whether desktop device identity already exists in `server/src/routes/public/devices.js`.
- Unique indexes and application-level constraints.
- Data retention policy.

Needed:

- Migration-level schema with indexes.
- Compatibility analysis against existing device routes.
- Exact revocation cascade behavior.

### 2.4 Desktop OS Helper Design

Status: first-pass OS adapter contract exists in [Mobile Command Desktop OS Adapters](mobile-command-desktop-os-adapters.md).

Still missing:

- Final Windows input helper language/library.
- macOS accessibility permission flow and signing implications.
- Linux supported/unsupported matrix.
- Packaging, code signing, update, and crash handling for native helpers.
- Prototype validation on real OSes.

Needed:

- Helper command protocol.
- Threat model for local helper abuse.

### 2.5 Voice Input / ASR Contract

Status: voice contract exists in [Mobile Command Voice Input Contract](mobile-command-voice-input.md), and provider spike plan exists in [Mobile Command ASR Provider Spike](mobile-command-asr-provider-spike.md).

Still missing:

- Final ASR provider decision.
- Streaming ASR event protocol.
- Concrete service endpoint and provider credentials model.
- Cost/latency evaluation.

Needed:

- ASR provider spike execution.
- Privacy copy review.

### 2.6 Brand Asset Pipeline

Status: brand asset contract exists in [Mobile Command Brand Assets](mobile-command-brand-assets.md), and generation script spec exists in [Mobile Command Icon Generation Script](mobile-command-icon-generation-script.md).

Still missing:

- Actual `scripts/generate-mobile-icons.mjs` implementation.
- Actual generated assets.
- Visual QA screenshots.

Needed:

- `scripts/generate-mobile-icons.mjs`.

### 2.7 Mobile App Build And Packaging

Status: build/release contract exists in [Mobile Command Build And Release](mobile-command-build-release.md).

Still missing:

- Capacitor configuration.
- Actual CI jobs.
- Real signing secret setup.
- Store metadata review.

Needed:

- CI build matrix.
- Signing secret handling.

### 2.8 Service Deployment And TURN Operations

Status: ops contract exists in [Mobile Command Ops Runbook](mobile-command-ops-runbook.md).

Still missing:

- TURN provider/self-host choice.
- Actual coturn or provider config.
- Real dashboards and alerts.
- Cost model.

Needed:

- TURN credential issuer implementation contract.

### 2.9 UI Visual Design Tokens

UI behavior is specified, but final visual design is not.

Missing:

- Mobile design tokens mapped to existing Lily desktop brand.
- Exact spacing, typography, colors, motion, waveform style.
- High-fidelity mockups.
- Dark mode behavior.
- Safe-area handling.

Needed:

- Mobile visual spec or Figma.
- Screenshot-based QA cases.

### 2.10 Full Acceptance Test Cases

Test files and assertions are listed, but not Given/When/Then cases.

Missing:

- Fixture definitions.
- Mock server behavior.
- Exact expected outputs.
- Manual QA forms.
- Release sign-off checklist.

Needed:

- Expand `mobile-command-test-plan.md` with case IDs.
- Add QA checklist templates.

## 3. Medium Gaps

- Push notification provider integration details.
- Offline draft retention duration.
- Internationalized copy for every approval and error.
- Telemetry event names and payload schemas.
- User-facing privacy policy text.
- Admin/support tooling for revoking devices.
- Customer support diagnostics package format.
- Feature flag source and remote config merge behavior.
- Real Given/When/Then tests are now drafted in [Mobile Command Test Cases](mobile-command-test-cases.md), but test files are not implemented.

## 4. Current Readiness

| Area | Readiness |
|---|---|
| Product direction | High |
| Architecture | High |
| Security principles | High |
| Permission model | Medium-high |
| Protocol contracts | High draft / Medium implementation |
| File transfer | Medium-high |
| WebRTC behavior | Medium |
| Native shell | Medium |
| Voice UX | Medium-high draft / provider undecided |
| Repo implementation map | Medium |
| Build/release | Medium |
| Ops/TURN | Medium |
| Visual design | Low |
| Test cases | Medium-high draft / not implemented |

## 5. Recommended Next Documents

To get to AI-build-ready, create or implement these next:

1. Machine-readable schema files under `docs/schemas/` and `src/shared/mobile-command/`.
2. Shared runtime validators generated or wired from schemas.
3. `scripts/generate-mobile-icons.mjs`.
4. Concrete server migrations after inspecting existing device/account schema.
5. Desktop OS helper prototype execution from [Mobile Command OS Helper Spike](mobile-command-os-helper-spike.md).
6. ASR provider spike execution and latency/cost decision.
7. Implement Given/When/Then test cases from [Mobile Command Test Cases](mobile-command-test-cases.md).

## 6. Definition Of Complete

The spec is complete only when:

- all protocols are machine-readable schemas
- repo files to change are named
- migrations include indexes and compatibility notes
- native helpers have signed/packaged implementation contracts
- ASR flow is specified
- brand assets can be generated by script
- TURN ops and cost controls are specified
- every release gate has a test case ID
