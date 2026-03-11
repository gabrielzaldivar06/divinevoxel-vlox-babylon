type TerrainFlagSettings = Record<string, unknown> & {
  benchmarkPreset?: string;
  visualV2?: boolean;
  macroVariation?: boolean;
  materialTriplanar?: boolean;
  materialWetness?: boolean;
  surfaceMetadata?: boolean;
  surfaceOverlays?: boolean;
  nearCameraHighDetail?: boolean;
  microVariation?: boolean;
};

export function isUnstablePBRSurfaceContextPreset(benchmarkPreset?: string) {
  return (
    benchmarkPreset === "optimum-inspired" ||
    benchmarkPreset === "universalis-inspired" ||
    benchmarkPreset === "pbr-surface-lod"
  );
}

export function getEffectivePBRTerrainSettings<T extends TerrainFlagSettings>(terrain: T): T {
  if (!isUnstablePBRSurfaceContextPreset(terrain.benchmarkPreset)) {
    return terrain;
  }

  return {
    ...terrain,
    visualV2: false,
    materialTriplanar: false,
    surfaceMetadata: false,
    surfaceOverlays: false,
    nearCameraHighDetail: false,
    microVariation: false,
  };
}

export function getEffectiveTerrainFlagNames(
  terrain: TerrainFlagSettings,
  rendererMode?: string
) {
  const effectiveTerrain = rendererMode === "pbr" ? getEffectivePBRTerrainSettings(terrain) : terrain;
  return Object.entries(effectiveTerrain)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
}