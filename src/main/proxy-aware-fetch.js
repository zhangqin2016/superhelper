"use strict";

// Main-process fetch that honors the OS system proxy.
//
// Node's global fetch (undici) ignores WinINET/macOS system proxy settings —
// on corporate and campus networks that REQUIRE a proxy, every activation /
// license-refresh / remote-config / update call fails while the user's
// browser works fine: the classic "activated but unusable" report. Electron's
// net.fetch goes through Chromium's network stack, which resolves the system
// proxy exactly like the browser does.
//
// Falls back to global fetch when Electron's net stack is unavailable (plain
// node tests/CLIs) or the app is not ready yet — identical to today's
// behavior in those contexts, so this can only ADD connectivity.
function proxyAwareFetch(...args) {
  try {
    const { app, net } = require("electron");
    if (typeof net?.fetch === "function" && app?.isReady?.()) {
      return net.fetch(...args);
    }
  } catch { /* plain node, or electron without net — fall through */ }
  return fetch(...args);
}

module.exports = proxyAwareFetch;
module.exports.proxyAwareFetch = proxyAwareFetch;
