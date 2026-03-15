import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";

export const TerrainMaterialFamily = {
  Default: "default",
  Soil: "soil",
  Rock: "rock",
  Flora: "flora",
  Liquid: "liquid",
  Wood: "wood",
  Cultivated: "cultivated",
  Exotic: "exotic",
} as const;

export type TerrainMaterialFamily =
  (typeof TerrainMaterialFamily)[keyof typeof TerrainMaterialFamily];

export type TerrainMaterialClassification = {
  id: string;
  family: TerrainMaterialFamily;
  isLiquid: boolean;
  isTransparent: boolean;
  isGlow: boolean;
  isFlora: boolean;
  isRock: boolean;
  isWood: boolean;
  isSoil: boolean;
  isCultivated: boolean;
  isExotic: boolean;
};

export type TerrainMaterialProfileLayer = {
  disableLighting?: boolean;
  alpha?: number;
  metallic?: number;
  roughnessAtLeast?: number;
  roughnessAtMost?: number;
  environmentIntensityAtLeast?: number;
  directIntensityAtLeast?: number;
  emissiveIntensityAtLeast?: number;
  albedoColor?: [number, number, number];
  reflectivityColor?: [number, number, number];
  reflectionColor?: [number, number, number];
  emissiveColor?: [number, number, number];
};

export type ActiveTerrainProfileSettings = {
  benchmarkPreset?: string;
  visualV2?: boolean;
  materialTriplanar?: boolean;
  materialWetness?: boolean;
};

/**
 * Ordered keyword registry: first match wins. Place more-specific or
 * higher-priority entries before general ones.
 * This eliminates ambiguity for names like "muddy_log" where both
 * "mud" (Soil) and "log" (Wood) would match — explicit ordering decides.
 */
const FAMILY_KEYWORD_REGISTRY: ReadonlyArray<[string, TerrainMaterialFamily]> = [
  // Liquids — highest priority
  ["liquid",   TerrainMaterialFamily.Liquid],
  ["foam",     TerrainMaterialFamily.Liquid],
  ["ether",    TerrainMaterialFamily.Liquid],
  // Cultivated
  ["farmland", TerrainMaterialFamily.Cultivated],
  // Exotic
  ["dream",    TerrainMaterialFamily.Exotic],
  ["dread",    TerrainMaterialFamily.Exotic],
  // Flora
  ["flora",    TerrainMaterialFamily.Flora],
  ["grass",    TerrainMaterialFamily.Flora],
  ["leaves",   TerrainMaterialFamily.Flora],
  ["vine",     TerrainMaterialFamily.Flora],
  ["wheat",    TerrainMaterialFamily.Flora],
  // Wood — before Soil so "muddy_log" → Wood
  ["log",      TerrainMaterialFamily.Wood],
  ["wood",     TerrainMaterialFamily.Wood],
  // Soil
  ["dirt",     TerrainMaterialFamily.Soil],
  ["mud",      TerrainMaterialFamily.Soil],
  ["sand",     TerrainMaterialFamily.Soil],
  // Rock
  ["rock",     TerrainMaterialFamily.Rock],
  ["stone",    TerrainMaterialFamily.Rock],
  ["gravel",   TerrainMaterialFamily.Rock],
  ["pillar",   TerrainMaterialFamily.Rock],
];

export function classifyTerrainMaterial(id: string): TerrainMaterialClassification {
  const lowerId = id.toLowerCase();

  let family: TerrainMaterialFamily = TerrainMaterialFamily.Default;
  for (const [keyword, fam] of FAMILY_KEYWORD_REGISTRY) {
    if (lowerId.includes(keyword)) {
      family = fam;
      break;
    }
  }

  return {
    id,
    family,
    isLiquid:     family === TerrainMaterialFamily.Liquid,
    isTransparent: lowerId.includes("transparent"),
    isGlow:        lowerId.includes("glow"),
    isFlora:      family === TerrainMaterialFamily.Flora,
    isRock:       family === TerrainMaterialFamily.Rock,
    isWood:       family === TerrainMaterialFamily.Wood,
    isSoil:       family === TerrainMaterialFamily.Soil,
    isCultivated: family === TerrainMaterialFamily.Cultivated,
    isExotic:     family === TerrainMaterialFamily.Exotic,
  };
}

export function applyTerrainMaterialProfileLayer(
  pbr: PBRMaterial,
  layer?: TerrainMaterialProfileLayer | null
) {
  if (!layer) return;

  if (layer.disableLighting !== undefined) {
    pbr.disableLighting = layer.disableLighting;
  }
  if (layer.alpha !== undefined) {
    pbr.alpha = layer.alpha;
  }
  if (layer.metallic !== undefined) {
    pbr.metallic = layer.metallic;
  }
  if (layer.roughnessAtLeast !== undefined) {
    pbr.roughness = Math.max(pbr.roughness ?? 0, layer.roughnessAtLeast);
  }
  if (layer.roughnessAtMost !== undefined) {
    pbr.roughness = Math.min(pbr.roughness ?? 1, layer.roughnessAtMost);
  }
  if (layer.environmentIntensityAtLeast !== undefined) {
    pbr.environmentIntensity = Math.max(
      pbr.environmentIntensity,
      layer.environmentIntensityAtLeast
    );
  }
  if (layer.directIntensityAtLeast !== undefined) {
    pbr.directIntensity = Math.max(
      pbr.directIntensity,
      layer.directIntensityAtLeast
    );
  }
  if (layer.emissiveIntensityAtLeast !== undefined) {
    pbr.emissiveIntensity = Math.max(
      pbr.emissiveIntensity ?? 0,
      layer.emissiveIntensityAtLeast
    );
  }
  if (layer.albedoColor) {
    pbr.albedoColor.set(...layer.albedoColor);
  }
  if (layer.reflectivityColor) {
    pbr.reflectivityColor.set(...layer.reflectivityColor);
  }
  if (layer.reflectionColor) {
    pbr.reflectionColor.set(...layer.reflectionColor);
  }
  if (layer.emissiveColor) {
    pbr.emissiveColor.set(...layer.emissiveColor);
  }
}

export function getMaterialImportProfile(
  material: TerrainMaterialClassification
): TerrainMaterialProfileLayer | null {
  if (material.isLiquid) {
    return {
      disableLighting: true,
      alpha: 1,
      roughnessAtMost: 0.18,
      metallic: 0,
      albedoColor: [0.2, 0.4, 0.58],
      environmentIntensityAtLeast: 0.6,
      directIntensityAtLeast: 0.4,
      reflectivityColor: [0.34, 0.42, 0.5],
      reflectionColor: [0.08, 0.14, 0.18],
      emissiveColor: [0.22, 0.36, 0.44],
    };
  }

  if (material.isTransparent) return null;

  return {
    environmentIntensityAtLeast: material.isRock ? 1.02 : 0.96,
    directIntensityAtLeast: 1.14,
    roughnessAtMost: material.isFlora ? 0.94 : 0.84,
    emissiveIntensityAtLeast: material.isGlow ? 1.1 : undefined,
  };
}

export function getVisualV2Profile(
  material: TerrainMaterialClassification
): TerrainMaterialProfileLayer {
  return {
    environmentIntensityAtLeast: material.isLiquid ? 1.1 : 0.72,
    directIntensityAtLeast: material.isLiquid ? 0.95 : 1.08,
    roughnessAtMost: material.isLiquid ? undefined : material.isFlora ? 0.96 : 0.88,
    emissiveIntensityAtLeast: material.isGlow ? 1.2 : undefined,
  };
}

export function getTriplanarProfile(
  material: TerrainMaterialClassification
): TerrainMaterialProfileLayer | null {
  if (material.isLiquid || material.isTransparent) return null;
  return {
    roughnessAtLeast: material.isFlora ? 0.96 : 0.9,
    environmentIntensityAtLeast: 0.82,
  };
}

export function getWetnessProfile(
  material: TerrainMaterialClassification
): TerrainMaterialProfileLayer | null {
  if (material.isLiquid) {
    return {
      roughnessAtMost: 0.02,
      alpha: 0.82,
      environmentIntensityAtLeast: 1.25,
      reflectivityColor: [0.95, 0.95, 0.95],
    };
  }

  if (material.isTransparent || material.isFlora) return null;

  return {
    roughnessAtMost: 0.72,
    metallic: 0.02,
    environmentIntensityAtLeast: 0.92,
  };
}

export function getOptimumInspiredProfile(
  material: TerrainMaterialClassification
): TerrainMaterialProfileLayer | null {
  if (material.isLiquid) {
    return {
      disableLighting: false,
      alpha: 0.88,
      roughnessAtMost: 0.12,
      environmentIntensityAtLeast: 1.02,
      directIntensityAtLeast: 0.86,
      reflectivityColor: [0.78, 0.84, 0.9],
    };
  }

  if (material.isTransparent) return null;

  return {
    directIntensityAtLeast: 1.08,
    environmentIntensityAtLeast: material.isFlora ? 0.82 : 0.92,
    roughnessAtMost: material.isFlora ? 0.95 : 0.82,
  };
}

export function getUniversalisInspiredProfile(
  material: TerrainMaterialClassification
): TerrainMaterialProfileLayer | null {
  if (material.isLiquid) {
    return {
      disableLighting: false,
      alpha: 0.78,
      roughnessAtMost: 0.04,
      metallic: 0,
      environmentIntensityAtLeast: 1.28,
      directIntensityAtLeast: 0.82,
      albedoColor: [0.16, 0.28, 0.38],
      reflectivityColor: [0.88, 0.92, 0.98],
      reflectionColor: [0.22, 0.3, 0.38],
      emissiveColor: [0.04, 0.08, 0.1],
    };
  }

  if (material.isTransparent) return null;

  return {
    directIntensityAtLeast: 1.04,
    environmentIntensityAtLeast: material.isFlora ? 0.86 : 0.96,
    roughnessAtMost: material.isFlora ? 0.96 : 0.8,
  };
}

export function getDefinitivoProfile(
  material: TerrainMaterialClassification
): TerrainMaterialProfileLayer | null {
  if (material.isLiquid) {
    return {
      disableLighting: false,
      alpha: 0.82,
      roughnessAtMost: 0.04,
      metallic: 0,
      environmentIntensityAtLeast: 1.26,
      directIntensityAtLeast: 0.84,
      albedoColor: [0.16, 0.28, 0.38],
      reflectivityColor: [0.88, 0.92, 0.98],
      reflectionColor: [0.22, 0.3, 0.38],
      emissiveColor: [0.04, 0.08, 0.1],
    };
  }

  if (material.isTransparent) return null;

  return {
    directIntensityAtLeast: 1.06,
    environmentIntensityAtLeast: material.isFlora ? 0.84 : 0.94,
    roughnessAtMost: material.isFlora ? 0.96 : 0.82,
  };
}

export function getPBRPremiumProfile(
  material: TerrainMaterialClassification
): TerrainMaterialProfileLayer | null {
  if (material.isLiquid) {
    return {
      roughnessAtMost: 0.12,
      alpha: 0.86,
      environmentIntensityAtLeast: 0.18,
      directIntensityAtLeast: 0.9,
      metallic: 0,
      reflectivityColor: [0.72, 0.82, 0.9],
    };
  }

  if (material.isTransparent) return null;

  if (material.isRock) {
    return {
      directIntensityAtLeast: 1.12,
      environmentIntensityAtLeast: 1.02,
      roughnessAtMost: 0.88,
      metallic: 0,
    };
  }

  if (material.isWood) {
    return {
      directIntensityAtLeast: 1.12,
      environmentIntensityAtLeast: 0.96,
      roughnessAtMost: 0.88,
    };
  }

  if (material.isFlora) {
    return {
      directIntensityAtLeast: 1.12,
      environmentIntensityAtLeast: 0.88,
      roughnessAtMost: 0.96,
    };
  }

  if (material.isExotic) {
    return {
      directIntensityAtLeast: 1.12,
      environmentIntensityAtLeast: 1.04,
      roughnessAtMost: 0.8,
      emissiveIntensityAtLeast: material.isGlow ? 1.42 : undefined,
    };
  }

  return {
    directIntensityAtLeast: 1.12,
    environmentIntensityAtLeast: 0.98,
    roughnessAtMost: 0.88,
  };
}

export function applyActiveTerrainMaterialProfiles(
  pbr: PBRMaterial,
  materialId: string,
  terrain: ActiveTerrainProfileSettings
) {
  const classification = classifyTerrainMaterial(materialId);
  const isMaterialImport = terrain.benchmarkPreset === "material-import";
  const isOptimumInspired = terrain.benchmarkPreset === "optimum-inspired";
  const isUniversalisInspired = terrain.benchmarkPreset === "universalis-inspired";
  const isPBRPremium = terrain.benchmarkPreset === "pbr-premium";
  const isPBRPremiumV2 = terrain.benchmarkPreset === "pbr-premium-v2";
  const isDefinitivo = terrain.benchmarkPreset === "definitivo";

  if (isMaterialImport) {
    applyTerrainMaterialProfileLayer(pbr, getMaterialImportProfile(classification));
  }

  if (terrain.visualV2) {
    applyTerrainMaterialProfileLayer(pbr, getVisualV2Profile(classification));
  }

  if (terrain.materialTriplanar) {
    applyTerrainMaterialProfileLayer(pbr, getTriplanarProfile(classification));
  }

  if (terrain.materialWetness) {
    applyTerrainMaterialProfileLayer(pbr, getWetnessProfile(classification));
  }

  if (isOptimumInspired) {
    applyTerrainMaterialProfileLayer(pbr, getOptimumInspiredProfile(classification));
  }

  if (isUniversalisInspired) {
    applyTerrainMaterialProfileLayer(pbr, getUniversalisInspiredProfile(classification));
  }

  if (isPBRPremium) {
    applyTerrainMaterialProfileLayer(pbr, getPBRPremiumProfile(classification));
  }

  if (isPBRPremiumV2) {
    applyTerrainMaterialProfileLayer(pbr, getUniversalisInspiredProfile(classification));
    applyTerrainMaterialProfileLayer(pbr, getPBRPremiumProfile(classification));
  }

  if (isDefinitivo) {
    applyTerrainMaterialProfileLayer(pbr, getMaterialImportProfile(classification));
    applyTerrainMaterialProfileLayer(pbr, getDefinitivoProfile(classification));
  }

  pbr.metadata = {
    ...(pbr.metadata || {}),
    terrainPhase1: {
      family: classification.family,
      visualV2: Boolean(terrain.visualV2),
      materialTriplanar: Boolean(terrain.materialTriplanar),
      materialWetness: Boolean(terrain.materialWetness),
      materialImport: isMaterialImport,
      optimumInspired: isOptimumInspired,
      universalisInspired: isUniversalisInspired,
      pbrPremium: isPBRPremium,
      pbrPremiumV2: isPBRPremiumV2,
      definitivo: isDefinitivo,
    },
  };

  return classification;
}