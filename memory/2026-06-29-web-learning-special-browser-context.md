# Web Learning Special Browser Context

Some web systems bind login/session state to the exact interactive browser,
SSO/device posture, TLS/client hints, QR login, or anti-automation controls.
Treat that as a product boundary, not as an invitation to keep generating
stealth/UA/webdriver/native-Chrome retry scripts.

The web-system-learning skill must:

- use the approved capture/scanner/executor scripts first;
- allow at most one capture attempt plus one bounded scan attempt for a replayed
  browser session;
- stop with `SPECIAL_BROWSER_CONTEXT_REQUIRED` when the session cannot be safely
  replayed;
- switch to same interactive browser/profile capture, accessibility-tree/MCP
  observation, or a partial draft with gaps recorded in `health.json`;
- never run ad-hoc `python3 -c`, here-doc, inline Playwright, stealth,
  webdriver-patching, user-agent spoofing, TLS/client-hint spoofing, or
  native-Chrome retry scripts as a substitute for the approved path.

This prevents long stuck turns on special enterprise systems without weakening
normal read-only scans, learned API execution, or developer Playwright tests.
