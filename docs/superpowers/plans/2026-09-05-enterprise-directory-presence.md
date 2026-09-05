# Enterprise IM directory and presence

Approved scope: show enterprises and their members, direct chat without friendship, editable nicknames in the directory, and actual online members. Keep personal friends separate. Apply cautious-engineering: current account and membership authorize every directory read; offline data never becomes proof of online presence.

1. Add a signed, read-only enterprise directory endpoint deriving scope from the current active account. Use current memberships and display-name fallback; no phone/login fields.
2. Track realtime connection heartbeats with expiry, reconnect replacement and multi-device aggregation. Only active current sessions qualify; missing realtime service means unknown.
3. Refresh enterprise directory in the desktop while visible; preserve cached baseline on unavailable server, show unknown online state, and reject stale account responses.
4. Show enterprises and expandable member lists with nickname, role, online/unknown/offline label and direct-chat action; preserve existing channels and draft forms.
5. Ensure nickname creates missing public identity safely and keeps existing Lily IDs. Verify with isolated PostgreSQL, actual WebSockets, Electron DOM tests and regression checks.
6. Deploy server changes and verify production health and signed enterprise directory with dedicated acceptance accounts. Desktop packaging/release is separate unless a reliable existing release path is available; report exact acceptance scope.

## Follow-up fixes (2026-09-05, second session)

- `friend-lookup.js` `getDirectory()`: a service stop during the in-flight live read returns the stopped result (or the local directory) instead of rejecting — caught by `collaboration-conversations-http-integration.mjs`.
- The live directory carries the same identity facets as the bootstrap (`loginName`, server-masked `phoneMasked`; join probe-gated on migration 044) and the desktop merge keeps local facets when a live row lacks them. Product decision since item 1: nickname → enterprise login → masked phone; the raw phone is never sent or stored.
