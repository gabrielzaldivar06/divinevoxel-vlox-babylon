type TerrainFlagSettings = Record<string, unknown> & {
    benchmarkPreset?: string;
    visualV2?: boolean;
    macroVariation?: boolean;
    materialTriplanar?: boolean;
    materialWetness?: boolean;
    surfaceMetadata?: boolean;
    surfaceHeightGradient?: boolean;
    surfaceOverlays?: boolean;
    nearCameraHighDetail?: boolean;
    microVariation?: boolean;
};
export declare function isUnstablePBRSurfaceContextPreset(benchmarkPreset?: string): boolean;
export declare function getEffectivePBRTerrainSettings<T extends TerrainFlagSettings>(terrain: T): T;
export declare function getEffectiveTerrainFlagNames(terrain: TerrainFlagSettings, rendererMode?: string): string[];
export {};
