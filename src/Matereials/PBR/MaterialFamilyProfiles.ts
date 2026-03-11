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

export function classifyTerrainMaterial(id: string): TerrainMaterialClassification {
  const lowerId = id.toLowerCase();
  const isLiquid =
    lowerId.includes("liquid") ||
    lowerId.includes("foam") ||
    lowerId.includes("ether");
  const isTransparent = lowerId.includes("transparent");
  const isGlow = lowerId.includes("glow");
  const isFlora =
    lowerId.includes("flora") ||
    lowerId.includes("grass") ||
    lowerId.includes("leaves") ||
    lowerId.includes("vine") ||
    lowerId.includes("wheat");
  const isCultivated = lowerId.includes("farmland");
  const isSoil =
    lowerId.includes("dirt") ||
    lowerId.includes("mud") ||
    lowerId.includes("sand");
  const isWood = lowerId.includes("log") || lowerId.includes("wood");
  const isExotic = lowerId.includes("dream") || lowerId.includes("dread");
  const isRock =
    lowerId.includes("rock") ||
    lowerId.includes("stone") ||
    lowerId.includes("gravel") ||
    lowerId.includes("pillar");

  let family: TerrainMaterialFamily = TerrainMaterialFamily.Default;
  if (isLiquid) family = TerrainMaterialFamily.Liquid;
  else if (isFlora) family = TerrainMaterialFamily.Flora;
  else if (isCultivated) family = TerrainMaterialFamily.Cultivated;
  else if (isSoil) family = TerrainMaterialFamily.Soil;
  else if (isWood) family = TerrainMaterialFamily.Wood;
  else if (isExotic) family = TerrainMaterialFamily.Exotic;
  else if (isRock) family = TerrainMaterialFamily.Rock;

  return {
    id,
    family,
    isLiquid,
    isTransparent,
    isGlow,
    isFlora,
    isRock,
    isWood,
    isSoil,
    isCultivated,
    isExotic,
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
    },
  };

  return classification;
}