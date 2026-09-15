# Database self-recovery

Startup DB failures previously interrupted registration of `app:get-version`,
making a new installer look like offline version 0.1.0. Main now registers version
before DB-dependent work and runs worker preflight plus a restricted independent
recovery window before migrations/session load. Late initialization failures only
offer diagnostics/restart, never replace a DB while live services may own handles.

Never silently reset an existing corrupt primary. Native hot rollback recovery
first retains original database+journals, including torn-header cases with a
genuine journal. Verified older snapshots require explicit confirmation. Retained
intent authorizes one immutable candidate; partial publication uses a fresh copy
on retry. Staged/evidence files must not share a live writable DB inode.

Only verified automatic backups count toward four retained slots, with six-hour
throttling across restarts. Legacy/precompact/readable copies disclose unknown
data cutoff instead of preparation time. Old restored admissions become
outcome-unknown and parent recoveries unavailable transactionally. The fence's
newly-applied result, not mere receipt presence, controls first-boot suppression
so failed receipt cleanup cannot disable new work indefinitely.

See `docs/database-self-recovery-verification.md`. Targeted/real Electron UI tests
pass; global registry currently has an unrelated auth anchor missing registration.
No Windows/customer-file/signed-installer acceptance or publication is claimed.
