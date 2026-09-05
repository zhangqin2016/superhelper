# Skill discovery and runtime dependencies (2026-09-05)

Implementation and verification: `docs/skill-dependency-implementation.md`.

- Keep the Lily per-session guide + Read path; the shared native skill registry remains unmounted.
- Only explicit `$skill-id` invocation or a selected available skill ID from the model-authored intent contract adds declared requirements to readiness. Mere mentions, globally enabled skills and catalog recommendations do not authorize new heavy downloads.
- Installed/supplied manifest + bundled registry declarations are fresh, validated and additive to the legacy skill map. Kill switch `LILY_SKILL_RUNTIME_DECLARATIONS=0` must bypass the whole new readiness promotion, including legacy selected IDs.
- Workspace skills are read-only, realpath-contained, content-fingerprinted and filtered by explicit conversation choice. Cache keys must include selected LOCAL IDs; resolveSessionSkillIds only contains installed IDs. Local index must reserve learned sections before appending.
- Actual messages.db stores gzip `envelope_blob`, with audit at decoded `record.meta.skillUsageAudit`; do not assume a JSON `record` column. Historical version-1 reads are attempts, not verified success. Snapshot: 306 audits / 134 candidate matches, all old outcomes unknown; no valid unread-rate baseline yet.
- Missing cwd also produces `spawn git ENOENT` even when Git exists. Only precise shell diagnostics/tracebacks with failed exit evidence get dependency hints. Node Playwright pack is not Python Playwright. Validate catalog lookups as own properties.
- runtime_pack_list exposes background progress and target health plus fresh safe execution environment. Retry the failed operation with those values; do not restart a busy shared serve. Bundled artifact repair is unsupported and must surface a limitation instead of an install loop.

- Turn terminal cleanup synthesizes done/failed states for unfinished tools. Read audit outcomes must check `completionObserved` from the actual tool.done route before accepting status; absent completion stays unknown even when the whole turn failed.
