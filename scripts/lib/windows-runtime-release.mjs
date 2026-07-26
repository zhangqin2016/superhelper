export function assertWindowsPackSmokeHost(platform = process.platform) {
  if (platform !== "win32") {
    throw new Error(
      `Windows package runtime verification must run on Windows; current host is ${platform}`,
    );
  }
}
