const WINDOWS_PRODUCT_NAME = "LilyWorkbench";

export function releaseArtifactName(platform, productName, version, extension) {
  const arch = platform.endsWith("-arm64") ? "arm64" : "x64";
  const releaseName = platform === "win32-x64" ? WINDOWS_PRODUCT_NAME : productName;
  return `${releaseName}-${version}-${arch}.${extension}`;
}

export { WINDOWS_PRODUCT_NAME };
