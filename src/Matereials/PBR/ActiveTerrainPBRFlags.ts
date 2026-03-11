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
  // All surface features validated stable in phase-3-preview (2026-03-11).
  // No presets need gating anymore.
  return false;
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