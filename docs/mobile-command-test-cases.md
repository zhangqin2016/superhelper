# Lily Mobile Command Pro Stable Test Cases

## 1. Normative Case Shape

Every `MC-TC-*` row below is a stable Given/When/Then case. Read columns as: **Given** Preconditions + Fixture; **When** Exact input/event; **Then** Expected state/response/error + Forbidden side effects + Audit/telemetry; finally Cleanup and Platform. The fixture for case `MC-TC-DOMAIN-NNN` is exactly `FX-MC-TC-DOMAIN-NNN`; its final expanded SHA-256 and byte length are mandatory in §6 before execution. Thus every Exact input cell is read as `FX-<case-id>@<manifest SHA-256>` at the named HTTP/WS/DataChannel/native/policy boundary. An automated filename is planned ownership, not evidence that the test exists or passed. Secret/body telemetry is always prohibited even where the shorter cell says “redacted audit”.

Fixture IDs: `FX-ID-VALID` (bound user/license/desktop/mobile/key), `FX-SESSION-IDLE`, `FX-SESSION-BUSY`, `FX-REVOKE-RACE`, `FX-UPLOAD-3CHUNK`, `FX-LIVE-GRANT`, `FX-NATIVE-MOCK`, `FX-ASR-DRAFT`, `FX-OPS-CONFIG`, and `FX-VERSION-SKEW`.

Canonical boundary values used by negative fixtures are not prose placeholders: HTTP header nonce is 16–128 characters, signature is 64–512 characters, native request `id` is at most 128 characters, QR text is at most 8192 characters, upload `sizeBytes` max is 524288000, chunk bytes max is 26214400, chunk path index max is 99999, chunk count max is 100000, SHA-256 is exactly 64 lowercase hex characters, protocol/schema version is exactly `1`, and unsupported-major fixture uses `version:2`. The forged-signature fixture uses 64 ASCII `A` bytes over a body whose last byte changed; replay uses the identical 16-byte nonce `nonce_test_000001`; oversized variants use exactly 129-char native ID, 8193-byte ASCII QR text, `sizeBytes:524288001`, 26214401 binary zero bytes, `chunkIndex:100000`, `chunkCount:100001`, or a 63-character hash as applicable. Expected rejection is HTTP 400/401/413/422 with the row's exact `MC-ERR-*`, WS error projection with the same code, or native `{ok:false,error.code}`; none may reach an authority store, admission/idempotency store, orchestrator queue/runner, staging/artifact registry, OS adapter, or success audit.

## 2. Pairing And Command

| Case / planned file | Preconditions / fixture | Exact input or event | Expected state transition | Expected response/error | Forbidden side effects | Required audit/telemetry | Cleanup | Platform |
|---|---|---|---|---|---|---|---|---|
| MC-TC-PAIR-001 / `test-mobile-pairing.mjs` | active signed desktop; FX-ID-VALID | exact `POST pairing/start` | none → challenge_pending with bounded TTL | typed challenge | no grant/session | redacted pairing-start audit | expire challenge | server + desktop |
| MC-TC-PAIR-002 / `test-mobile-pairing.mjs` | same fixture | inspect persisted start result | one hashed challenge only | no standing credential | no plaintext token/key | hash/TTL metadata only | delete fixture row | server |
| MC-TC-PAIR-003 / `test-mobile-pairing-security.mjs` | FX-ID-VALID + one-time challenge | exact consume, then replay/forged tuple | challenge_pending → consumed once | first accepted; replay `MC-ERR-PAIRING-TOKEN-CONSUMED`, forged rejected | no second grant | tuple/result audit without secret | revoke grant | server |
| MC-TC-PAIR-004 / `test-mobile-pairing-approval.mjs` | pending desktop approval | approve versus reject/timeout race | first terminal decision wins | late decision rejected | no late grant | decision/CAS audit | clear approval | server + desktop |
| MC-TC-PAIR-005 / `test-mobile-device-list.mjs` | two accounts/devices | account A lists devices | state unchanged | only A redacted rows | no cross-account/key disclosure | list count only | delete fixtures | server |
| MC-TC-PAIR-006 / `test-mobile-revocation.mjs` | active grant/session; FX-REVOKE-RACE | duplicate revoke racing refresh | grant → revoked before refresh | revoke idempotent; refresh device-revoked | no later authority | ordered revoke/deny audit | end sessions | server + desktop |
| MC-TC-PAIR-007 / `test-mobile-session-auth.mjs` | FX-ID-VALID | create, refresh, end with stale token family | active → ended | stale/reused family rejected | no family resurrection | token-family hash/outcome | revoke fixture | server |
| MC-TC-PAIR-008 / `test-mobile-native-qr.mjs` | FX-NATIVE-MOCK | QR returns malformed/oversized/forged text | native state unchanged | untrusted text passed to Web validator/rejected | native must not consume/grant | size/result only | clear scanner temp | iOS + Android native |
| MC-TC-CMD-001 / `test-remote-session-isolation.mjs` | account, remote channel, Lily conversation IDs differ | remote-session create | channel active; conversation unchanged | bounded channel descriptor | no account/local-session substitution | IDs hashed and distinguished | end channel | server + desktop |
| MC-TC-CMD-002 / `test-remote-agent-bridge.mjs` | FX-SESSION-IDLE | exact command targets existing Lily session A | admitted → dispatched through orchestrator | accepted with admission key | no session B/direct engine call | admission/target/mode | remove test turn | desktop |
| MC-TC-CMD-003 / `test-mobile-command-idempotency.mjs` | prior durable admission | exact duplicate idempotency key then conflicting body | remains one admission | duplicate returns existing; conflict typed error | no second dispatch | key hash/outcome | clear admission | server + desktop |
| MC-TC-CMD-004 / `test-remote-agent-bridge.mjs` | FX-SESSION-BUSY | remote steer rejected by current runner | steer_pending → FIFO queued | visible requested/effective mode | no unbound runner | fallback reason/modes | drain queue | desktop |
| MC-TC-CMD-005 / `test-mobile-replay-snapshot.mjs` | durable epoch/sequence gap | reconnect with last acknowledged sequence | replay or atomic snapshot cut | ordered events/snapshot | no duplicate terminal or command dispatch | gap/cut/count | close socket | relay + desktop |
| MC-TC-CMD-006 / `test-mobile-replay-snapshot.mjs` | volatile cursor only + ambiguous dispatch | reconnect request | channel recovers without dispatch | snapshot or delivery-unknown | no cursor trust/re-dispatch | ambiguity audit | close socket | relay + desktop |
| MC-TC-CMD-007 / `test-remote-fail-open.mjs` | FX-SESSION-IDLE with local transcript hash | malformed, forged, oversized, then version-skew command | remote request rejected; local state byte-identical | protocol/auth/size/upgrade error | no admission/tool/session mutation | metadata/error only | discard payload | server + desktop |

## 3. Live And Permission

| Case / planned file | Preconditions / fixture | Exact input or event | Expected state transition | Expected response/error | Forbidden side effects | Required audit/telemetry | Cleanup | Platform |
|---|---|---|---|---|---|---|---|---|
| MC-TC-LIVE-001 / `test-remote-session-permissions.mjs` | Chat Only session | observe/control elevation | pending approval or denied | explicit policy result | no capture/input before grant | permission request/result | revoke grant | desktop all OS |
| MC-TC-LIVE-002 / `test-remote-signaling-contract.mjs` | FX-LIVE-GRANT | offer/answer with wrong session/source/generation | signaling unchanged | protocol/permission denied | no peer connection authority | binding mismatch only | close peer | desktop × mobile |
| MC-TC-LIVE-003 / `test-remote-signaling-contract.mjs` | signaling before deadline | malformed candidate and wrong discriminator | signaling remains pending | candidate rejected; deadline retained | no premature terminal failure | candidate class/result | close peer | WebRTC platforms |
| MC-TC-LIVE-004 / `test-mobile-turn-credentials.mjs` | active remote session | request then reuse expired/wrong-session TURN credential | credential expires; app state unchanged | expired/binding denied | no application authority | issuance/expiry/session hash | expire credential | regional relay pairs |
| MC-TC-LIVE-005 / `test-remote-input-protocol.mjs` | FX-LIVE-GRANT/source A | pointer burst plus ambiguous keyboard replay/source B input | pointer may coalesce; invalid input denied | typed denial for bounds/source | no keyboard replay/OS call on invalid | counts/reasons, no raw input | release keys/revoke | Windows/macOS/Linux evidence pairs |
| MC-TC-LIVE-006 / `test-remote-clipboard-policy.mjs` | live grant without clipboard approval | clipboard read, then scoped approval | denied → one approved read | approval-required then redacted success metadata | no content telemetry | action/outcome only | clear clipboard fixture | supported desktop pairs |
| MC-TC-LIVE-007 / `test-mobile-background-policy.mjs` | active control | `app.background`; clock +10 s/+60 s cumulative | pause immediate → control revoked → observe revoked | visible downgrade | no input after background | timers/transitions only | foreground Chat Only | iOS/Android/PWA |
| MC-TC-PERM-001 / `test-remote-approval-policy.mjs` | sensitive action | create approval with exact bindings | none → pending | bounded approval descriptor | no side effect | scope hashes/TTL/uses | expire | desktop |
| MC-TC-PERM-002 / `test-remote-approval-policy.mjs` | pending approval | simultaneous approve/deny plus late approve | first terminal result | late conflict | no late authority | CAS winner/time | delete fixture | desktop |
| MC-TC-PERM-003 / `test-remote-approval-consume.mjs` | approved one-use scope | consume exact then wrong resource/expired/reuse | approved → consumed once | latter denied | no extra sensitive side effect | consume outcome only | revoke | desktop |
| MC-TC-PERM-004 / `test-remote-approval-race.mjs` | FX-REVOKE-RACE + unused approval | revoke/session-end races consume | revoked before side effect | device/session revoked | no consume/action | ordered audit | end session | server + desktop |
| MC-TC-PERM-005 / `test-remote-permission-lifecycle.mjs` | L2+ grant | indicator missing then desktop restart | grant → disabled | policy denied/revalidation required | no invisible control | grant/indicator/restart state | revoke | desktop all OS |
| MC-TC-PERM-006 / `test-remote-input-protocol.mjs` | no exact live grant/source mismatch | DataChannel control event | unchanged/denied | permission denied | no OS adapter invocation | denial reason only | close channel | desktop all OS |
| MC-TC-PERM-007 / `test-remote-permission-fail-safe.mjs` | missing/stale policy or policy exception | sensitive action | control → Chat Only | policy failed/denied | no input/capture side effect | exception class, no payload | restore policy | desktop |
| MC-TC-PERM-008 / `test-remote-audit-fail-safe.mjs` | audit store forced failure | approval/control consume | sensitive state not entered | audit failed | no sensitive action; local chat remains usable | local health + audit failure | restore store | server + desktop |
| MC-TC-PERM-009 / `test-remote-device-revocation.mjs` | active command/upload/approval/session | revoke races every authority endpoint | all remote authority revoked | device revoked | no cancel/artifact/command/reconnect authority | cascade ordering | delete fixtures | server + desktop |

## 4. File, Voice, Native, Ops, Privacy, Release

| Case / planned file | Preconditions / fixture | Exact input or event | Expected state transition | Expected response/error | Forbidden side effects | Required audit/telemetry | Cleanup | Platform |
|---|---|---|---|---|---|---|---|---|
| MC-TC-FILE-001 / `test-remote-file-transfer.mjs` | FX-UPLOAD-3CHUNK | create valid then oversized manifest | none → created; oversized rejected | descriptor / `MC-ERR-UPLOAD-TOO-LARGE` | no object for rejected input | size/hash metadata | cancel upload | server |
| MC-TC-FILE-002 / `test-remote-upload-idempotency.mjs` | created upload | exact chunk, duplicate, forged hash/index | checkpoint advances once | existing status / hash error | no duplicate object | index/outcome, no bytes | delete temp | server/storage |
| MC-TC-FILE-003 / `test-remote-upload-hash.mjs` | all chunks or one missing/corrupt | complete request | verified only for full valid hash | missing/hash mismatch otherwise | no seal/stage on failure | hash result only | delete corrupt temp | server/storage |
| MC-TC-FILE-004 / `test-remote-upload-resume.mjs` | persisted resume checkpoint + relay loss | reconnect/status/resume | resumes exact checkpoint | recoverable status | no guessed/replayed chunk | checkpoint/retry count | complete/cancel | mobile + server |
| MC-TC-FILE-005 / `test-remote-upload-revocation.mjs` | created upload; FX-REVOKE-RACE | expire/cancel/revoke races complete | terminal blocked state | expired/cancelled/revoked | no staging/attachment | terminal cause | purge object | server + desktop |
| MC-TC-FILE-006 / `test-remote-file-transfer.mjs` | sealed object | desktop pull with wrong authority/full hash | pull fails before staging | auth/hash error | no staging ID | result/size only | delete temp | desktop |
| MC-TC-FILE-007 / `test-remote-agent-bridge.mjs` | staged opaque ID for session A | attach from session B/wrong admission key | command rejected | permission/idempotency error | no path/agent dispatch | IDs/outcome only | remove staging fixture | desktop |
| MC-TC-FILE-008 / `test-remote-artifact-download.mjs` | sealed local terminal artifact | project metadata | artifact available | redacted descriptor | no local path/body | type/size/correlation | expire descriptor | desktop + mobile |
| MC-TC-FILE-009 / `test-remote-artifact-download.mjs` | authorized artifact | download URL then expired/wrong-device reuse | turn remains terminal | bytes once / denied | no turn mutation/path leak | download outcome | expire URL | server + desktop |
| MC-TC-FILE-010 / `test-mobile-native-share.mjs` | FX-NATIVE-MOCK shared file | enumerate pending then explicit Web enqueue | temp → acknowledged/enqueued | opaque native handle | no auto-upload/path exposure | count/TTL only | TTL purge | iOS + Android |
| MC-TC-FILE-011 / `test-mobile-native-upload-contract.mjs` | verified Web upload absent | native transport completion | transport complete only | status reports transport | no verified/staged/attached business state | byte/progress only | foreground reconcile | iOS + Android/PWA downgrade |
| MC-TC-VOICE-001 / `test-mobile-voice-contract.mjs` | composer idle | capture patch without submit intent | draft patched only | local transcript | no hidden command | segment/revision only | clear draft | iOS/Android/PWA |
| MC-TC-VOICE-002 / `test-mobile-voice-fail-open.mjs` | FX-ASR-DRAFT typed text + partial | ASR error/relay loss | recording → text draft | recoverable ASR error | no draft loss/send/provider improvisation | provider/error/latency only | stop capture | configured voice platforms |
| MC-TC-VOICE-003 / `test-mobile-voice-merge.mjs` | user-edited transcript range | stale later ASR patch/direct-send sensitive text | user edit retained; review required | conflict ignored/approval required | no overwrite/hidden send | revision/conflict only | clear draft | configured voice platforms |
| MC-TC-VOICE-004 / `test-mobile-asr-routing.mjs` | provider/credential absent or unaccepted | start voice | remains text-only | provider unavailable | no unconfigured provider call | availability reason | none | all mobile clients |
| MC-TC-NATIVE-001 / `test-mobile-native-key-contract.mjs` | FX-NATIVE-MOCK | generate then sign canonical/altered digest | handle created; signature bound | public key/handle/signature only | no private key/authority | algorithm/key ID/outcome | destroy test key | iOS + Android |
| MC-TC-NATIVE-002 / `test-mobile-native-bridge-schema.mjs` | unsupported/unavailable/timed-out method | typed bridge request | capability downgrades | typed native error | no business success inferred | method/error/latency | cancel invocation | native + PWA fallback |
| MC-TC-NATIVE-003 / `test-mobile-native-authority.mjs` | FX-NATIVE-MOCK | caller injects URL/path/header/credential/method in native request | rejected unchanged | protocol invalid | no network/file/authority side effect | field class only | clear temp | iOS + Android |
| MC-TC-OPS-001 / `test-mobile-diagnostics-redaction.mjs` | explicit consent + seeded secrets/bodies | export diagnostics | package generated redacted | success metadata | no screen/input/clipboard/file/prompt bodies | consent/package hash | delete package | all platforms |
| MC-TC-OPS-002 / `test-mobile-push-contract.mjs` | paired but expired/revoked session | receive/open wake hint | app wakes, authority unchanged | reconnect auth required | no grant/message/file name | opaque correlation only | clear notification | iOS + Android |
| MC-TC-OPS-003 / `test-remote-kill-switch.mjs` | FX-OPS-CONFIG active control | staged kill switch then rollback | affected remote mode → Chat Only | feature disabled | no local Lily outage | config version/transitions | restore config | server + desktop + mobile |
| MC-TC-PRIV-001 / `test-mobile-retention-policy.mjs` | storage policy absent, then approved TTL fixture | create/purge temp object | absent policy blocks; TTL deletes | policy denied / deletion proof | no indefinite/backup residue | object class/region/deletion ID | verify purge | approved regions |
| MC-TC-PRIV-002 / `test-mobile-privacy-gates.mjs` | legal/cross-border/support approval absent | transfer/export/support access | denied unchanged | approval required | no data disclosure | gate/result only | close access | configured regions |
| MC-TC-PRIV-003 / `test-mobile-telemetry-prohibitions.mjs` | seeded clipboard/raw input | telemetry/audit/push serialization | event emitted redacted | schema valid | prohibited bodies absent | redaction counters | delete events | all platforms |
| MC-TC-PRIV-004 / `test-mobile-diagnostics-redaction.mjs` | no consent then consent | diagnostics collection | denied then redacted package | consent required / success | no allowlist bypass | consent/version | delete package | all platforms |
| MC-TC-PRIV-005 / `test-mobile-push-contract.mjs` | sensitive filename/message fixture | serialize push | wake hint only | opaque payload | no sensitive text | schema/result | clear push | iOS + Android |
| MC-TC-REL-001 / `test-mobile-protocol-version.mjs` | FX-VERSION-SKEW | unknown major/mandatory semantic | remote mutation disabled | `MC-ERR-PROTOCOL-CLIENT-UPGRADE-REQUIRED` | no mutation/local Lily change | versions/result | close channel | mixed versions |
| MC-TC-REL-002 / `test-mobile-release-compatibility.mjs` | unsigned artifact or incompatible window | release promotion | promotion blocked | release-gate error | no rollout | provenance/window/result | remove candidate | CI + stores |
| MC-TC-REL-003 / `test-mobile-upload-downgrade.mjs` | native upload interrupted | PWA/foreground resume | resumes canonical checkpoint | recoverable status | no checkpoint loss/duplicate verify | adapter/checkpoint | finish/cancel | native + PWA |
| MC-TC-REL-004 / `test-mobile-lifecycle-fail-safe.mjs` | lifecycle event source missing/restarted | next remote action | background/Chat Only | revalidation required | no control/local outage | source age/downgrade | restore source | all mobile clients |
| MC-TC-REL-005 / `test-mobile-release-metadata.mjs` | unverified platform pair | generate metadata/enable flag | capability absent/disabled | explicit unsupported | no false advertisement | pair/evidence ID/result | none | all advertised pairs |

## 5. Manual Case Registry

`MC-MAN-{PAIR,CMD,LIVE,PERM,FILE,NATIVE,VOICE,OPS,PRIV,REL}-NN` denotes execution of the mapped automated scenario on the exact platform pair and network/OS condition recorded in the trace row. Every manual record must capture desktop OS/build, mobile OS/device/browser or native build, server/schema versions, network path (direct/relay/loss/latency), evidence links, result, reviewer, date, cleanup confirmation, and any forbidden-side-effect observation. No manual ID is a pass until that record exists.
+


## 6. Executable Fixture Object Manifest

Canonical source: [`docs/fixtures/mobile-command-test-fixtures.json`](fixtures/mobile-command-test-fixtures.json). JSON Pointer uses the immutable array position in fixture version 1. Hash input is the recursively key-sorted, fully expanded **case object** serialized by `JSON.stringify` as UTF-8; it is not a descriptor wrapper.

| Case | JSON Pointer | Canonical UTF-8 bytes | Case-object SHA-256 |
|---|---|---:|---|
| MC-TC-PAIR-001 | `#/cases/0` | 1752 | `f73fd8e2adbce342093730f8befa71cb3f073fa6e5e2276bb5cd9d3a3c370f19` |
| MC-TC-PAIR-002 | `#/cases/1` | 1752 | `4561169b5cadd3954fe8955e66aac081122603f61bbb6eba1d15948d99f2c691` |
| MC-TC-PAIR-003 | `#/cases/2` | 3339 | `7c5fff5af6706e3de1ed444d4d40cdb8bfdeac84a55a6e6855da57e0124b85c0` |
| MC-TC-PAIR-004 | `#/cases/3` | 1805 | `0b37262381bb78fcfbb5bc919120c1ec6238d590207ace77fdbe2ed67d412978` |
| MC-TC-PAIR-005 | `#/cases/4` | 1752 | `3d9e0934c7f7076f46c7c3418d4eb097b02d81c97562df0939a90a807ac9fec4` |
| MC-TC-PAIR-006 | `#/cases/5` | 1805 | `b86ca1dea7a867b30c8899cc0c9562e15f3d452012a22b86372cac4a307eed0b` |
| MC-TC-PAIR-007 | `#/cases/6` | 1752 | `d9994a5646981c82bed78d78600dd01fa5f95afc95b90d4ef7a60272c3e350f1` |
| MC-TC-PAIR-008 | `#/cases/7` | 1318 | `3816dbe03c605f68d0efedd3c2bc65ef151f778292c4d5ccce2a6423aeb2f0df` |
| MC-TC-CMD-001 | `#/cases/8` | 1478 | `38e0e979951e11b2159197b3169dadbf8212bff05a758d5075df0969381837ed` |
| MC-TC-CMD-002 | `#/cases/9` | 1478 | `aaeed9edb8f611272bece9c4cf0233d55d2641f99fc58946caf1ab7df597bfe3` |
| MC-TC-CMD-003 | `#/cases/10` | 1478 | `0006de891df0463b95edc1467c5baf63c9bb7662697a792652644166125cbffa` |
| MC-TC-CMD-004 | `#/cases/11` | 1478 | `cfbe0ede9c320441c1c21eceb84162d469d2c9651e660054164a1370a2d6d128` |
| MC-TC-CMD-005 | `#/cases/12` | 1478 | `65ed3385adf458fed06855bdba7813ca1694349c6ff0fa8c386609a1d41eacfc` |
| MC-TC-CMD-006 | `#/cases/13` | 1478 | `5307a06d178c8020ba3a0636d3641c04dda049542232038703b350d94364aef5` |
| MC-TC-CMD-007 | `#/cases/14` | 2416 | `0a393119955694d328e06809d3b0eb9b7f8f46bd92126a7877f4b348f72407c7` |
| MC-TC-LIVE-001 | `#/cases/15` | 1469 | `46902f9922a0e30c12ad55513e582028ddbc2b588a80b9837c230a96e4e964ba` |
| MC-TC-LIVE-002 | `#/cases/16` | 1469 | `d6e37c0521e366f90f77f4cb35c711cfa9b79a6ad6f1a2d6d66bc6f7def3b704` |
| MC-TC-LIVE-003 | `#/cases/17` | 1469 | `3eaf4ecd23960a1dd730561fef70e4f0de3041bcefae59aabc957505cb590cbf` |
| MC-TC-LIVE-004 | `#/cases/18` | 1469 | `565faab8da3909327e3b0b87ac0c3b610208458cc756777cd5f64aa268f91771` |
| MC-TC-LIVE-005 | `#/cases/19` | 1469 | `fa7caa8ee64b3df23abce7f4b9ce0c750391e0c0ffeb2aa796e521bfac2bd412` |
| MC-TC-LIVE-006 | `#/cases/20` | 1469 | `94448b4c7b64b88dc92f289272459a339fa2dc278415f3913cbc8e2fc3bc87ce` |
| MC-TC-LIVE-007 | `#/cases/21` | 1469 | `a154b8628f525c46005da06fdc89296e2df0899626c55d186426efb36b97db93` |
| MC-TC-PERM-001 | `#/cases/22` | 1480 | `3cb729d4b73c5f66cd0f85a5803b8166566b604d3d1ee9ba5ccb8c13ed89bbd7` |
| MC-TC-PERM-002 | `#/cases/23` | 1533 | `e389e2966faaed0c9bfcc93d03c346a4465f7c3def37d1ebd24a3c17014a631a` |
| MC-TC-PERM-003 | `#/cases/24` | 1480 | `bd274a59162c578af810e9298bad6e4bc245af3cd06c506928a50e84476983db` |
| MC-TC-PERM-004 | `#/cases/25` | 1533 | `ead31d58a4ad74cd8bafb0de30db3d0593ed33b2b272bd835e2f7873538a41a9` |
| MC-TC-PERM-005 | `#/cases/26` | 1480 | `1d193b8164ab63360a7fcc09866140496faca6347f32b7650d288c4ce0ff0114` |
| MC-TC-PERM-006 | `#/cases/27` | 1480 | `4235298361519eb45957a8281e82daaa9d8c61a36525387cbcdc014db3281bbd` |
| MC-TC-PERM-007 | `#/cases/28` | 1480 | `f473bdb8e24aa5be3435d4ab08ddb65ea9ceecbc9b29e9134c584022344457a7` |
| MC-TC-PERM-008 | `#/cases/29` | 1480 | `61403b6f01ff86f736a315315852366af695d6a7a418299598075f85feed83a1` |
| MC-TC-PERM-009 | `#/cases/30` | 1533 | `75b79ea8b71b544d49596d0295ec5fda2722f7513fb8ceb1d15e5824f080ee58` |
| MC-TC-FILE-001 | `#/cases/31` | 1752 | `04271788001773593fa9e80c9a6d983db49eff5a27cbcc0a020b3fa8bfa3111e` |
| MC-TC-FILE-002 | `#/cases/32` | 1898 | `d16f06b5e2c2d10f8bb489c72978af027b0f82e63a5a794f17fb38bd8d20c409` |
| MC-TC-FILE-003 | `#/cases/33` | 1752 | `b85f8c341cb848347964158dfeecb5ad43cb6c6a676af8f8b00a293d96dbbe83` |
| MC-TC-FILE-004 | `#/cases/34` | 1752 | `ccf833468f1cd1c5b1fb61f7fc2a83adc4c1096d2013da47a7caf41da12290f4` |
| MC-TC-FILE-005 | `#/cases/35` | 1805 | `40b21713bb736c5241ae65af7be37dfb188f7e386aa0b0d77d89d37f8425cf69` |
| MC-TC-FILE-006 | `#/cases/36` | 1752 | `ea5e73dc57e639e1c6f6712d42683f056f6f824ecbd7ca45ec6fd90ca0da7cae` |
| MC-TC-FILE-007 | `#/cases/37` | 1752 | `c01a0664dcad84d03b45c56a7736a44d5ecf3898cf6e051d945849f94dcf9056` |
| MC-TC-FILE-008 | `#/cases/38` | 1752 | `ec818f6fd707c1c9d44c100440dc688dc1d8b39978c86cda08a03c43a408b2a7` |
| MC-TC-FILE-009 | `#/cases/39` | 1752 | `ec6cb12fa6d2dd8fea8082086c34f069672fc59f3bb20e19c195d3a88ebbdc6f` |
| MC-TC-FILE-010 | `#/cases/40` | 1333 | `feba64ab60a6c62f1d99e400b6fa30c378efa69ed5ce9a8c7a14f6dc743f0b40` |
| MC-TC-FILE-011 | `#/cases/41` | 1556 | `2855797f370ebeebfbcf72d10ae6a3ffb327c1e32ca6b3695c48f4bf2f413a47` |
| MC-TC-VOICE-001 | `#/cases/42` | 1498 | `aa245a29658fe0749788072e2f6b3ac0c7240568a829940ecda27a7d68e6f8f4` |
| MC-TC-VOICE-002 | `#/cases/43` | 1498 | `080a634dbf173c881b6044da1dcbdd5a4bf89acdf47128c25007af12fbb0b158` |
| MC-TC-VOICE-003 | `#/cases/44` | 1498 | `d3e1a9425165318c9b310c897e5fce70ec4914273bae5c5bdaf1f523ccf95d55` |
| MC-TC-VOICE-004 | `#/cases/45` | 1498 | `7c702a4c887f7035db9edd2bf0f0e269672d4ccad18098b0b58071696e467d05` |
| MC-TC-NATIVE-001 | `#/cases/46` | 1831 | `12ccc1207d0073afe8065d39d931e889f11cd80d465f7ee17f68ab685b17350f` |
| MC-TC-NATIVE-002 | `#/cases/47` | 1334 | `6564e9cb60445f749e859d5e7685c4654279cbeb043cb61fd2c8f31de0c8a134` |
| MC-TC-NATIVE-003 | `#/cases/48` | 1334 | `271796545f58bf30443efaf784f133ade87de8c367616ffff309a370c28c27ec` |
| MC-TC-OPS-001 | `#/cases/49` | 1746 | `cd594102f608827e1d22b60c0806b2d4282935bd8eb240f243ded12d8e7d147f` |
| MC-TC-OPS-002 | `#/cases/50` | 1746 | `50a4b632ad4723083c1cffbeb538875d4a356fdc50722e946916e0192184bec9` |
| MC-TC-OPS-003 | `#/cases/51` | 1746 | `bcccc4dc934df24c706780dcaadee388d42f6452a3cb67ad1b4f3831a5c0784e` |
| MC-TC-PRIV-001 | `#/cases/52` | 1752 | `5bc0d62ad67e1a50ce1190c079cda36ba21094563f5e2ee55238c1820062cec8` |
| MC-TC-PRIV-002 | `#/cases/53` | 1752 | `11622d10766b8fff7ae6c78fae5e02e0f667e101dbfb7ba3d333486732c0ab3b` |
| MC-TC-PRIV-003 | `#/cases/54` | 1752 | `033ba6d6ee2a2aa3ebcaf54149cfa99bc12c865817f15ec5f2088936f4abb480` |
| MC-TC-PRIV-004 | `#/cases/55` | 1752 | `8af1e84c3b48b5f60c3acf7cc7e30ceb00b816656f101f160c2a16b45a367234` |
| MC-TC-PRIV-005 | `#/cases/56` | 1752 | `df66ad3d76dbf4f3334208fe98919a21a7d094a1290f8f8249faad6b2cfb2d96` |
| MC-TC-REL-001 | `#/cases/57` | 1746 | `aeff75198a26af91728ddff712aabd4bdd5ec404b1d04cbd8d7044191b1327bd` |
| MC-TC-REL-002 | `#/cases/58` | 1746 | `ac0bdb8a53480c8abfaf33d17c30bb518fa8f4abe3068a631df729468282834b` |
| MC-TC-REL-003 | `#/cases/59` | 1746 | `2f2254d796e433129d4f1fb8f55cdf3d7af3bc6bf2eadabb528b9adc7af9d808` |
| MC-TC-REL-004 | `#/cases/60` | 1746 | `ca257421ed4b2e6ee2dadb5539b2b5f028da275dd0b3aba3eae8edd040ac8427` |
| MC-TC-REL-005 | `#/cases/61` | 1746 | `f443bb6df6a7d6393ab5399e01ddd1fdac17b12e32fdcac0b421034055679007` |
