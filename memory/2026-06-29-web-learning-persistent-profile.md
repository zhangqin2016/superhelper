# Web Learning Persistent Profile

Manual web-system login capture must use a persistent per-system Lily browser
profile under userData (`web-profiles/<system-id>`), not a temporary
Playwright `newContext()`.

The profile improves repeat manual capture for enterprise/SSO systems by keeping
local browser state across capture windows. The capture script must still export
a redacted, allowlist-filtered `storageState` to `web-sessions/<system-id>.json`
for scanner/discover/executor calls, so normal learned API execution stays fast
and browser-free.

Security boundary:

- profile and session files are local-only and never exported with workspace
  apps or learned skills;
- the agent never receives raw passwords, cookies, tokens, OAuth codes, or
  credential headers;
- stored website credentials, when used, are decrypted only by the main-process
  connector bridge, not by the skill or executor.
