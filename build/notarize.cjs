"use strict";

// electron-builder afterSign hook: notarize the signed .app with Apple's
// notarytool. Gated on credentials — if the APPLE_* env vars are absent (e.g. a
// local unsigned build), it skips cleanly so the existing unsigned flow keeps
// working. Requires devDependency @electron/notarize and, for signing,
// CSC_LINK + CSC_KEY_PASSWORD (a Developer ID Application cert).
//
// Env to set for a real signed release:
//   CSC_LINK, CSC_KEY_PASSWORD            (Developer ID cert .p12, base64 or path)
//   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log(
      "[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set — skipping notarization (unsigned build).",
    );
    return;
  }

  let notarize;
  try {
    ({ notarize } = require("@electron/notarize"));
  } catch (err) {
    console.warn("[notarize] @electron/notarize not installed — run npm install. Skipping.", err?.message || err);
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`[notarize] submitting ${appPath} to Apple notarytool...`);
  await notarize({
    appBundleId: context.packager.appInfo.id,
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
  console.log("[notarize] notarized + stapled.");
};
