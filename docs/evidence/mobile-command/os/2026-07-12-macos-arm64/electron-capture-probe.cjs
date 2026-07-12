const { app, desktopCapturer, systemPreferences, screen } = require("electron");

async function main() {
  const result = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    apiTypes: {
      desktopCapturerGetSources: typeof desktopCapturer?.getSources,
      getMediaAccessStatus: typeof systemPreferences?.getMediaAccessStatus,
      isTrustedAccessibilityClient: typeof systemPreferences?.isTrustedAccessibilityClient,
      askForMediaAccess: typeof systemPreferences?.askForMediaAccess,
    },
    screenCapturePermission: systemPreferences.getMediaAccessStatus("screen"),
    accessibilityTrustedNoPrompt: systemPreferences.isTrustedAccessibilityClient(false),
    displays: screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
    })),
  };

  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 64, height: 64 },
      fetchWindowIcons: false,
    });
    result.capture = {
      ok: true,
      count: sources.length,
      idPrefixes: sources.map((source) => source.id.split(":")[0]),
      nonEmptyThumbnailCount: sources.filter((source) => !source.thumbnail.isEmpty()).length,
    };
  } catch (error) {
    result.capture = {
      ok: false,
      name: error.name,
      message: error.message,
      code: error.code ?? null,
    };
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

app.whenReady().then(main).then(() => app.quit(), (error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
