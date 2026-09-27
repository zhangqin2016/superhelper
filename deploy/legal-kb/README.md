# Legal knowledge service (server-side)

The China legal corpus lives only on the corpus host (101.200.232.184,
`/opt/lily-legal-kb`). Clients never receive it; the official 中国企业法律顾问
agent reads it through two tools, `lily_legal_search` and `lily_legal_article`.

```
client tool ──signed──▶ Lily API /api/legal/{search,article}   (signature → pack entitlement → per-device quota → field whitelist, audit without question text)
                         └─▶ legal retrieval gateway 127.0.0.1:8791   (this directory; reads the managed runtime's active release)
                                ├─ V27/V28 pack: legal.sqlite + catalog.json (full article text)
                                └─▶ V2 service 127.0.0.1:8790   (lane votes for the governing law; a law's validity)
```

## Why the gateway, measured

`golden-questions.json` — 25 plain-language questions with the article that
answers each. Answering article in the top 5 (`eval-gateway.cjs`):

| retrieval | recall@5 | MRR |
|---|---|---|
| V2 lexical lane alone | 7/25 | 0.28 |
| V2 semantic lane alone | 8/25 | 0.22 |
| gateway, no law named | 21/25 | 0.68 |
| gateway, law named by the agent | 24/25 | 0.87 |

The V2 service's `hybrid` mode returns its lexical lane at once and leaves the
semantic half as a job to poll, so a caller that does not poll gets lexical
only. The gateway follows a lawyer's order instead: the governing law (named in
the question, named by the agent, or voted by V2's lanes with national law above
local regulation and repealed law excluded), then that law's current articles
ranked by BM25 over the law itself. The remaining misses are wording
(裁员 vs 裁减人员); the tool asks the agent to query in statutory terms.

A full-corpus FTS query is not an option on this host: the pack is 7.9 GB, the
machine has 7 GB, and one OR-of-bigrams query read gigabytes (25 questions ran
for over 12 minutes). Ranking within a law reads that law's rows by primary-key
prefix — tens of milliseconds.

## Install / update

```sh
# 1. data: build the managed runtime (V27 → reviewed delta), lowest priority
sh apply-delta.sh /opt/lily-legal-kb/patches/V27-Linux-UpdatePatch-20260926-r4 delta-20260926 \
  V27-update-20260926 V27-base 43b029bea0848bfe24feb74217a2f8548a3facbbfc3c3e5c95134ef1f15b0ef1
# 2. gateway (idempotent)
sh install-gateway.sh <dir with server.cjs, legal-retrieval.cjs, lily-legal-gateway.service>
# 3. gate: never below the previous release
node eval-gateway.cjs --url http://127.0.0.1:8791 --min-recall 0.8
```

Before a delta is applied, verify the bundle independently: every file's
sha256 against its `manifest.json`, and the canonical sha256 of `delta.json`
against the `--confirm` value (the bundle's own `patch-package.cjs verify`
predates data bundles and rejects them as `INVALID_MANIFEST`).

Rollback: `python3 <patch>/tools/v2/legal-pack-delta.py rollback --runtime /opt/lily-legal-kb/runtime --expected <active> --target <previous>` — the gateway serves the new pointer from the next request.

## Known limits

- Validity comes from the V2 service's records (V25 time point). Laws added
  after it report `unknown`, and the delta tooling does not judge repeal: 330
  FLK + 59 regulation entries that vanished from the official catalogues are
  still in the corpus as they were.
- The V2 semantic index is not rebuilt by a delta; it only votes for the
  governing law here, so an older index costs little.
- The V2 service runs as root from the vendor unit, with one hand edit in
  `lib/semantic/embed.cjs` (`DEFAULT_PYTHON` → `/opt/lily-legal-kb/venv/bin/python`;
  the shipped `--python` flag is not wired). Moving it to the `lilykb` user is
  the next hardening step.
