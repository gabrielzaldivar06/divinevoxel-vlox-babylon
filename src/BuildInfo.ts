export interface BuildInfo {
  packageName: string;
  packageVersion: string;
  generatedAt: string;
  gitCommit: string;
  buildId: string;
}

export const BUILD_INFO: BuildInfo = {
  packageName: "@divinevoxel/vlox-babylon",
  packageVersion: "0.0.59",
  generatedAt: "SOURCE_BUILD_PLACEHOLDER",
  gitCommit: "SOURCE_BUILD_PLACEHOLDER",
  buildId: "SOURCE_BUILD_PLACEHOLDER",
};

export function formatBuildInfo(info: BuildInfo = BUILD_INFO) {
  return `${info.packageName}@${info.packageVersion} (${info.buildId})`;
}
