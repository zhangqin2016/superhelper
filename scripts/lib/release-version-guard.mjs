function parseReleaseVersion(value) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`invalid release version: ${value || "<empty>"}`);
  }
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

export function compareReleaseVersions(left, right) {
  const leftParts = parseReleaseVersion(left);
  const rightParts = parseReleaseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

export function assertRemoteReleaseNotNewer(remoteVersion, targetVersion) {
  if (compareReleaseVersions(remoteVersion, targetVersion) > 0) {
    throw new Error(
      `refusing to replace newer remote release ${remoteVersion} with ${targetVersion}`,
    );
  }
}
