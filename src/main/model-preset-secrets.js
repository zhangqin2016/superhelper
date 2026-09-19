"use strict";

/**
 * How a model API key is kept on disk. The OS secure storage (Electron
 * safeStorage) is the only real protection; Base64 is an encoding and is
 * written ONLY under an explicit operator opt-in. Extracted from
 * model-presets.js to keep that module inside its line ratchet.
 */
// The implementation moved to secret-storage.js — the one module allowed to
// touch safeStorage. Kept as a name so existing callers and ratchets stand.
module.exports = require("./secret-storage");
