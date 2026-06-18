"use strict";

/**
 * Serves content-addressed blobs to the renderer over a custom `app-blob://`
 * scheme. The renderer references a blob as `app-blob://<sha256>?t=<mime>`; the
 * bytes stream from disk and Chromium caches them (content-addressed → safe to
 * mark immutable). This is what lets externalized images load on demand without
 * ever materializing base64 in renderer memory.
 */

const { protocol, net } = require("electron");
const { pathToFileURL } = require("node:url");
const { BlobStore } = require("./store/blob-store");
const { blobStoreDir } = require("./config");

const SCHEME = "app-blob";

let store = null;
function blobs() {
  if (!store) store = new BlobStore(blobStoreDir());
  return store;
}

/** Must run before app `ready` — declares scheme privileges. */
function registerBlobScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true },
    },
  ]);
}

/** Must run after app `ready` — installs the request handler. */
function installBlobProtocol() {
  protocol.handle(SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      const hash = (url.hostname || "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(hash)) return new Response(null, { status: 400 });
      const filePath = blobs().pathFor(hash);
      if (!blobs().exists(hash)) return new Response(null, { status: 404 });
      const mime = url.searchParams.get("t") || "application/octet-stream";
      // Stream from disk via net.fetch(file://) so large blobs aren't buffered.
      return net.fetch(pathToFileURL(filePath).toString(), {
        headers: { Accept: mime },
      }).then(
        (res) =>
          new Response(res.body, {
            status: 200,
            headers: { "content-type": mime, "cache-control": "max-age=31536000, immutable" },
          }),
      );
    } catch {
      return new Response(null, { status: 500 });
    }
  });
}

module.exports = { registerBlobScheme, installBlobProtocol, SCHEME };
