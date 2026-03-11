import { DVEBRShaderStore } from "../../Shaders/DVEBRShaderStore";
import { VoxelBaseShader } from "../../Shaders/Code/VoxelBaseShader";
import { ItemShader } from "../../Shaders/Code/ItemShader";
import { VoxelParticleShader } from "../../Shaders/Code/VoxelParticleShader";
import { DVEBRClassicMaterial } from "../../Matereials/Classic/DVEBRClassicMaterial";
import { DVEBRDefaultMaterialBaseData } from "../../Matereials/Types/DVEBRDefaultMaterial.types";
import {
  CreateDefaultRenderer,
  CreateTextures,
} from "../Default/CreateDefaultRenderer";
import { WorkItemProgress } from "@divinevoxel/vlox/Util/WorkItemProgress";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";
import { SceneUBO } from "../../Scene/SceneUBO";
import { TextureManager } from "@divinevoxel/vlox/Textures/TextureManager";
export type DVEBRClassicData = DVEBRDefaultMaterialBaseData & {
  doSun?: boolean;
  doRGB?: boolean;
  doAO?: boolean;
} & {
  getProgress?: (progress: WorkItemProgress) => void;
};
const defaultMaterials = [
  "dve_glow",
  "dve_flora",
  "dve_flora_transparent",
  "dve_solid",
  "dve_transparent",
  "dve_liquid",
];

const TERRAIN_CLASS_UNIFORM_SIZE = 512;

const TerrainMaterialClass = {
  Default: 0,
  Soil: 1,
  Rock: 2,
  Flora: 3,
  Liquid: 4,
  Wood: 5,
  Cultivated: 6,
  Exotic: 7,
} as const;

function classifyTextureKey(key: string) {
  const id = key.split(":")[0];

  if (id.includes("liquid") || id.includes("foam") || id.includes("ether")) {
    return TerrainMaterialClass.Liquid;
  }
  if (
    id.includes("grass") ||
    id.includes("leaves") ||
    id.includes("vine") ||
    id.includes("wheat")
  ) {
    return TerrainMaterialClass.Flora;
  }
  if (id.includes("farmland")) {
    return TerrainMaterialClass.Cultivated;
  }
  if (id.includes("dirt") || id.includes("mud") || id.includes("sand")) {
    return TerrainMaterialClass.Soil;
  }
  if (id.includes("log") || id.includes("wood")) {
    return TerrainMaterialClass.Wood;
  }
  if (id.includes("dream") || id.includes("dread")) {
    return TerrainMaterialClass.Exotic;
  }
  if (id.includes("stone") || id.includes("pillar")) {
    return TerrainMaterialClass.Rock;
  }

  return TerrainMaterialClass.Default;
}

function buildTerrainMaterialClassLookup() {
  const texture = TextureManager.getTexture("dve_voxel");
  const lookup = new Array<number>(TERRAIN_CLASS_UNIFORM_SIZE).fill(
    TerrainMaterialClass.Default
  );

  for (const [key, index] of Object.entries(texture.textureMap)) {
    if (index >= TERRAIN_CLASS_UNIFORM_SIZE) continue;
    lookup[index] = Math.max(lookup[index], classifyTextureKey(key));
  }

  return lookup;
}

function getClassicTerrainUniforms() {
  return /* glsl */ `
uniform float dve_terrain_material_class[${TERRAIN_CLASS_UNIFORM_SIZE}];
`;
}

function getClassicTerrainShaderFunctions() {
  return /* glsl */ `
float dveHash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float dveNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  float n000 = dveHash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = dveHash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = dveHash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = dveHash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = dveHash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = dveHash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = dveHash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = dveHash13(i + vec3(1.0, 1.0, 1.0));

  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  float nxy0 = mix(nx00, nx10, f.y);
  float nxy1 = mix(nx01, nx11, f.y);
  return mix(nxy0, nxy1, f.z);
}

float dveFbm3(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 4; octave++) {
    value += dveNoise3(p) * amplitude;
    p *= 2.02;
    amplitude *= 0.5;
  }
  return value;
}

float dveWetnessMask(vec3 normalDir, vec3 worldPos) {
  float upward = clamp(normalDir.y * 0.5 + 0.5, 0.0, 1.0);
  float macro = dveFbm3(worldPos * 0.045 + vec3(13.1, 0.0, -7.3));
  float drainage = 1.0 - clamp(abs(normalDir.y), 0.0, 1.0);
  return clamp(upward * 0.55 + macro * 0.35 - drainage * 0.15, 0.0, 1.0);
}

float dveEdgeMask(vec2 faceUV) {
  vec2 centered = abs(faceUV - 0.5) * 2.0;
  float edge = max(centered.x, centered.y);
  return smoothstep(0.7, 0.985, edge);
}

float dveTopExposureMask(vec3 normalDir, vec3 worldPos) {
  float upward = smoothstep(0.18, 0.88, normalDir.y);
  float breakup = dveFbm3(worldPos * 0.03 + vec3(-4.7, 9.2, 2.1));
  return clamp(upward * 0.7 + breakup * 0.35, 0.0, 1.0);
}

float dveCavityMask(vec4 ao, vec3 worldPos) {
  float aoAverage = (ao.x + ao.y + ao.z + ao.w) * 0.25;
  float cavity = clamp(1.0 - aoAverage, 0.0, 1.0);
  float breakup = dveFbm3(worldPos * 0.12 + vec3(6.1, -2.4, 8.7));
  return clamp(cavity * 0.75 + breakup * 0.2, 0.0, 1.0);
}

float dveDistanceBoost(float distanceValue) {
  return 1.0 - smoothstep(24.0, 128.0, distanceValue);
}

float dveCenterMask(vec2 faceUV) {
  vec2 centered = abs(faceUV - 0.5) * 2.0;
  float radial = dot(centered, centered);
  return 1.0 - smoothstep(0.18, 1.12, radial);
}

float dveNearFieldMask(float distanceValue, float startDistance, float endDistance) {
  return 1.0 - smoothstep(startDistance, endDistance, distanceValue);
}
`;
}

function getClassicTerrainShaderAfter(material: string) {
  const terrain = EngineSettings.settings.terrain;
  if (
    !terrain.visualV2 &&
    !terrain.macroVariation &&
    !terrain.materialTriplanar &&
    !terrain.materialWetness &&
    !terrain.surfaceMetadata &&
    !terrain.surfaceOverlays &&
    !terrain.transitionMeshes &&
    !terrain.nearCameraHighDetail &&
    !terrain.microVariation
  ) {
    return "";
  }

  const isLiquid = material.includes("liquid");
  const isTransparent = material.includes("transparent");
  const isGlow = material.includes("glow");

  if (isLiquid) {
    return terrain.visualV2
      ? /* glsl */ `
vec3 dveLiquidTint = mix(vec3(1.08, 1.14, 1.22), vec3(0.52, 0.72, 1.18), dveFbm3(worldPOS * 0.04));
FragColor.rgb *= dveLiquidTint;
`
      : "";
  }

  const surfaceMetadataSetup = /* glsl */ `
float dveMaterialIndex = float(min(int(vUV.z + 0.5), ${
  TERRAIN_CLASS_UNIFORM_SIZE - 1
}));
float dveMaterialClass = dve_terrain_material_class[int(dveMaterialIndex)];
float dveCloseBoost = dveDistanceBoost(vDistance);
float dveSurfaceExposure = clamp(vMetadata.x, 0.0, 1.0);
float dveSurfaceSlope = clamp(vMetadata.y, 0.0, 1.0);
float dveSurfaceCavity = clamp(vMetadata.z, 0.0, 1.0);
float dveSurfaceTop = clamp(vMetadata.w, 0.0, 1.0);
float dveMacroBase = clamp(dveFbm3(worldPOS * 0.035) * 1.2, 0.0, 1.0);
float dveMacroBands = dveFbm3(vec3(worldPOS.x * 0.018, worldPOS.y * 0.045, worldPOS.z * 0.018) + vec3(17.2, -3.1, 8.4));
float dveMacroPatch = dveFbm3(worldPOS * 0.012 + vec3(-9.7, 5.2, 11.1));
float dveBaseCavity = max(dveCavityMask(vAO, worldPOS), dveSurfaceCavity * 0.82);
float dveWetnessBase = clamp(dveWetnessMask(normalDir, worldPOS) * 0.72 + dveSurfaceCavity * 0.14 + (1.0 - dveSurfaceExposure) * 0.08, 0.0, 1.0);
float dveNearField = dveNearFieldMask(vDistance, 10.0, 56.0);
float dveCenterBlend = dveCenterMask(iUV);
float dveMicroNoise = dveFbm3(worldPOS * 0.34 + normalDir * 2.3);
float dveMicroNoiseFine = dveFbm3(worldPOS * 0.72 + vec3(iUV, dveSurfaceSlope) * 2.8);
float dveOrganicMaterial = 0.08;
if (dveMaterialClass == ${TerrainMaterialClass.Soil}.0) {
  dveOrganicMaterial = 0.95;
}
if (dveMaterialClass == ${TerrainMaterialClass.Flora}.0) {
  dveOrganicMaterial = 1.0;
}
if (dveMaterialClass == ${TerrainMaterialClass.Cultivated}.0) {
  dveOrganicMaterial = 0.92;
}
if (dveMaterialClass == ${TerrainMaterialClass.Wood}.0) {
  dveOrganicMaterial = 0.48;
}
if (dveMaterialClass == ${TerrainMaterialClass.Exotic}.0) {
  dveOrganicMaterial = 0.72;
}
if (dveMaterialClass == ${TerrainMaterialClass.Rock}.0) {
  dveOrganicMaterial = 0.15;
}
`;

  const visualV2Code = terrain.visualV2
    ? /* glsl */ `
float dveTopExposure = ${
      terrain.surfaceMetadata
        ? "mix(dveTopExposureMask(normalDir, worldPOS), dveSurfaceExposure, 0.85)"
        : "dveTopExposureMask(normalDir, worldPOS)"
    };
float dveEdgeWear = dveEdgeMask(iUV);
float dveCavity = ${
      terrain.surfaceMetadata
  ? "dveBaseCavity"
        : "dveCavityMask(vAO, worldPOS)"
    };
terrainColor = pow(max(terrainColor, vec3(0.0)), vec3(0.9));
terrainColor = mix(terrainColor, terrainColor * vec3(1.12, 1.1, 1.06), dveTopExposure * 0.18);
terrainColor = mix(terrainColor, terrainColor * vec3(0.74, 0.72, 0.7), dveCavity * 0.2);
terrainColor += vec3(0.045, 0.04, 0.03) * dveEdgeWear * (0.1 + dveCloseBoost * 0.08);
float dveEdgeRim = dveEdgeWear * (1.0 - abs(normalDir.y));
terrainColor = mix(terrainColor, terrainColor * vec3(1.06, 1.04, 1.01), dveEdgeRim * 0.08);

if (dveMaterialClass == ${TerrainMaterialClass.Soil}.0) {
  terrainColor *= vec3(1.1, 0.96, 0.86);
  terrainColor = mix(terrainColor, terrainColor * vec3(1.06, 1.02, 0.94), dveTopExposure * 0.2);
  terrainColor = mix(terrainColor, terrainColor * vec3(0.78, 0.68, 0.6), dveCavity * 0.22);
}
if (dveMaterialClass == ${TerrainMaterialClass.Rock}.0) {
  terrainColor *= vec3(0.96, 1.0, 1.06);
  terrainColor = mix(terrainColor, terrainColor * vec3(1.1, 1.08, 1.05), dveEdgeWear * 0.18);
  terrainColor = mix(terrainColor, terrainColor * vec3(0.76, 0.8, 0.88), dveCavity * 0.12);
}
if (dveMaterialClass == ${TerrainMaterialClass.Flora}.0) {
  terrainColor *= vec3(0.9, 1.12, 0.88);
  terrainColor = mix(terrainColor, terrainColor * vec3(1.08, 1.1, 0.98), dveTopExposure * 0.18);
}
if (dveMaterialClass == ${TerrainMaterialClass.Wood}.0) {
  terrainColor *= vec3(1.06, 0.9, 0.78);
  terrainColor = mix(terrainColor, terrainColor * vec3(1.04, 0.96, 0.88), dveEdgeWear * 0.16);
  terrainColor = mix(terrainColor, terrainColor * vec3(0.72, 0.62, 0.54), dveCavity * 0.2);
}
if (dveMaterialClass == ${TerrainMaterialClass.Cultivated}.0) {
  terrainColor *= vec3(1.12, 1.02, 0.9);
  terrainColor = mix(terrainColor, terrainColor * vec3(0.76, 0.68, 0.58), dveCavity * 0.18);
}
if (dveMaterialClass == ${TerrainMaterialClass.Exotic}.0) {
  terrainColor *= vec3(0.94, 0.88, 1.12);
  terrainColor += vec3(0.06, 0.02, 0.1) * dveEdgeWear * 0.2;
}

float dveSlopeWearMask = clamp(dveSurfaceSlope * (1.0 - dveSurfaceCavity * 0.5), 0.0, 1.0);
terrainColor = mix(terrainColor, terrainColor * vec3(0.82, 0.78, 0.74), dveSlopeWearMask * 0.12);
`
    : "";

  const macroVariationCode = terrain.macroVariation && !isTransparent && !isGlow
    ? /* glsl */ `
float dveMacroBlend = clamp(dveMacroBase * 0.52 + dveMacroBands * 0.28 + dveMacroPatch * 0.2, 0.0, 1.0);
float dveMacroTintMask = clamp(mix(dveMacroPatch, dveMacroBands, 0.45) + dveSurfaceExposure * 0.08 - dveSurfaceCavity * 0.06, 0.0, 1.0);
vec3 dveMacroTint = mix(vec3(0.7, 0.64, 0.58), vec3(1.22, 1.14, 1.04), dveMacroBlend);
terrainColor *= dveMacroTint;
terrainColor = mix(terrainColor, terrainColor * vec3(0.86, 0.82, 0.78), (1.0 - dveMacroTintMask) * 0.1 * (0.55 + dveOrganicMaterial * 0.45));
terrainColor = mix(terrainColor, terrainColor * vec3(1.08, 1.05, 1.01), dveMacroTintMask * 0.08);

if (dveMaterialClass == ${TerrainMaterialClass.Soil}.0 || dveMaterialClass == ${TerrainMaterialClass.Cultivated}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(1.12, 0.98, 0.88), dveMacroBlend * 0.22);
  terrainColor = mix(terrainColor, terrainColor * vec3(0.82, 0.74, 0.66), (1.0 - dveMacroTintMask) * 0.16);
}
if (dveMaterialClass == ${TerrainMaterialClass.Rock}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.86, 0.9, 0.98), dveMacroBlend * 0.2);
  terrainColor = mix(terrainColor, terrainColor * vec3(1.1, 1.06, 1.0), dveMacroBands * 0.12);
}
if (dveMaterialClass == ${TerrainMaterialClass.Flora}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.84, 1.04, 0.82), dveMacroBlend * 0.2);
  terrainColor = mix(terrainColor, terrainColor * vec3(1.1, 1.14, 0.98), dveMacroTintMask * 0.12);
}
if (dveMaterialClass == ${TerrainMaterialClass.Wood}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(1.08, 0.94, 0.82), dveMacroBands * 0.16);
}
if (dveMaterialClass == ${TerrainMaterialClass.Exotic}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.92, 0.84, 1.1), dveMacroBlend * 0.22);
  terrainColor += vec3(0.04, 0.01, 0.08) * dveMacroTintMask * 0.16;
}
`
    : "";

  const surfaceOverlaysCode = terrain.surfaceOverlays && !isTransparent && !isGlow
    ? /* glsl */ `
float dveOverlayNoise = dveFbm3(worldPOS * 0.11 + vec3(4.3, -1.7, 8.1));
float dveDepositionMask = clamp(dveSurfaceTop * (1.0 - dveSurfaceSlope) * 0.66 + dveSurfaceCavity * 0.08 + dveOverlayNoise * 0.14, 0.0, 1.0);
float dveMossMask = clamp(dveWetnessBase * 0.38 + dveSurfaceCavity * 0.3 + (1.0 - dveSurfaceSlope) * 0.08 - dveSurfaceExposure * 0.12, 0.0, 1.0);
float dveDustMask = clamp(dveSurfaceExposure * 0.3 + (1.0 - dveWetnessBase) * 0.18 + dveOverlayNoise * 0.1, 0.0, 1.0);
float dveCrustMask = clamp(dveSurfaceExposure * 0.18 + dveSurfaceCavity * 0.24 + dveOverlayNoise * 0.18, 0.0, 1.0);

if (dveMaterialClass == ${TerrainMaterialClass.Rock}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.7, 0.9, 0.68), dveMossMask * 0.22);
  terrainColor = mix(terrainColor, terrainColor * vec3(1.1, 1.06, 0.98), dveDepositionMask * 0.16);
}
if (dveMaterialClass == ${TerrainMaterialClass.Soil}.0 || dveMaterialClass == ${TerrainMaterialClass.Cultivated}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(1.12, 1.08, 0.94), dveDepositionMask * 0.18);
  terrainColor = mix(terrainColor, terrainColor * vec3(0.68, 0.78, 0.62), dveMossMask * 0.12);
}
if (dveMaterialClass == ${TerrainMaterialClass.Flora}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(1.06, 1.1, 0.96), dveDepositionMask * 0.1);
  terrainColor = mix(terrainColor, terrainColor * vec3(0.78, 0.94, 0.74), dveMossMask * 0.16);
}
if (dveMaterialClass == ${TerrainMaterialClass.Wood}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.76, 0.88, 0.74), dveMossMask * 0.12);
  terrainColor = mix(terrainColor, terrainColor * vec3(1.04, 1.0, 0.9), dveDustMask * 0.08);
}
if (dveMaterialClass == ${TerrainMaterialClass.Exotic}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(1.02, 0.92, 1.14), dveCrustMask * 0.18);
  terrainColor += vec3(0.05, 0.04, 0.09) * dveCrustMask * 0.12;
}
`
    : "";

  const microVariationCode = terrain.microVariation && !isTransparent
    ? /* glsl */ `
float dveMicroRelief = clamp(dveMicroNoise * 0.62 + dveMicroNoiseFine * 0.38, 0.0, 1.0);
float dveMicroEdge = dveEdgeMask(iUV) * (0.18 + dveSurfaceSlope * 0.22);
float dveMicroBreakup = clamp((dveMicroNoiseFine - 0.5) * 1.3 + 0.5, 0.0, 1.0);
terrainColor = mix(terrainColor, terrainColor * mix(vec3(0.94, 0.92, 0.9), vec3(1.05, 1.04, 1.01), dveMicroRelief), dveNearField * 0.06 * (0.45 + dveOrganicMaterial * 0.55));
terrainColor += vec3(0.03, 0.026, 0.022) * dveCenterBlend * dveNearField * dveSurfaceTop * 0.07 * dveOrganicMaterial;
terrainColor = mix(terrainColor, terrainColor * vec3(0.86, 0.84, 0.82), dveMicroEdge * dveNearField * 0.07 * (0.35 + dveOrganicMaterial * 0.65));

if (dveMaterialClass == ${TerrainMaterialClass.Rock}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.92, 0.94, 0.97), dveMicroBreakup * dveNearField * 0.05);
}
if (dveMaterialClass == ${TerrainMaterialClass.Flora}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.94, 1.03, 0.92), dveMicroBreakup * dveNearField * 0.06);
}
`
    : "";

  const nearCameraHighDetailCode = terrain.nearCameraHighDetail && !isTransparent
    ? /* glsl */ `
float dveNearFocus = dveNearField * (0.42 + dveSurfaceTop * 0.3 + dveOrganicMaterial * 0.18);
terrainColor = mix(terrainColor, terrainColor * vec3(1.04, 1.03, 1.01), dveCenterBlend * dveNearFocus * 0.12);
terrainColor = mix(terrainColor, terrainColor * vec3(0.8, 0.78, 0.76), dveEdgeMask(iUV) * dveNearFocus * 0.08);
`
    : "";

  const transitionMeshesCode = terrain.transitionMeshes && !isTransparent
    ? /* glsl */ `
float dveSoftCap = dveCenterBlend * dveSurfaceTop * (1.0 - dveSurfaceSlope);
float dveShoulder = dveEdgeMask(iUV) * (0.18 + dveSurfaceSlope * 0.4);
float dveTransitionBlend = dveNearField * (0.28 + dveOrganicMaterial * 0.72);
terrainColor = mix(terrainColor, terrainColor * vec3(1.08, 1.06, 1.03), dveSoftCap * dveTransitionBlend * 0.14);
terrainColor = mix(terrainColor, terrainColor * vec3(0.8, 0.78, 0.76), dveShoulder * dveTransitionBlend * 0.08);

if (dveMaterialClass == ${TerrainMaterialClass.Soil}.0 || dveMaterialClass == ${TerrainMaterialClass.Cultivated}.0 || dveMaterialClass == ${TerrainMaterialClass.Flora}.0) {
  terrainColor += vec3(0.036, 0.032, 0.025) * dveSoftCap * dveNearField * 0.12;
}
if (dveMaterialClass == ${TerrainMaterialClass.Rock}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.9, 0.92, 0.96), dveShoulder * dveNearField * 0.08);
}
`
    : "";

  const triplanarCode = terrain.materialTriplanar && !isTransparent
    ? /* glsl */ `
float dveCliffMask = smoothstep(0.18, 0.82, ${
      terrain.surfaceMetadata ? "max(slope, dveSurfaceSlope)" : "slope"
    });
float dveStrata = dveFbm3(vec3(worldPOS.x * 0.08, worldPOS.y * 0.18, worldPOS.z * 0.08));
float dveStrataBands = smoothstep(0.28, 0.72, abs(fract(worldPOS.y * 0.16 + dveStrata * 0.6) - 0.5) * 2.0);
vec3 dveCliffTint = mix(vec3(0.74, 0.7, 0.66), vec3(1.12, 1.08, 1.02), dveStrata);
terrainColor = mix(terrainColor, terrainColor * dveCliffTint + vec3(0.04, 0.03, 0.02), dveCliffMask * 0.62);
terrainColor += vec3(0.04, 0.025, 0.01) * dveCliffMask;
terrainColor = mix(terrainColor, terrainColor * vec3(1.08, 1.06, 1.02), dveCliffMask * dveStrataBands * 0.18);

if (dveMaterialClass == ${TerrainMaterialClass.Rock}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(1.12, 1.08, 1.02), dveCliffMask * 0.28);
  terrainColor = mix(terrainColor, terrainColor * vec3(0.84, 0.88, 0.94), dveCliffMask * (1.0 - dveStrataBands) * 0.1);
}
if (dveMaterialClass == ${TerrainMaterialClass.Soil}.0 || dveMaterialClass == ${TerrainMaterialClass.Cultivated}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(1.06, 0.98, 0.9), dveCliffMask * 0.24);
}
if (dveMaterialClass == ${TerrainMaterialClass.Flora}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.92, 1.06, 0.9), dveCliffMask * 0.12);
}
if (dveMaterialClass == ${TerrainMaterialClass.Exotic}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.96, 0.92, 1.08), dveCliffMask * 0.2);
}
`
    : "";

  const wetnessCode = terrain.materialWetness && !isTransparent && !isGlow
    ? /* glsl */ `
float dveWetness = ${
      terrain.surfaceMetadata
        ? "dveWetnessBase"
        : "dveWetnessMask(normalDir, worldPOS)"
    };
terrainColor = mix(terrainColor, terrainColor * vec3(0.52, 0.6, 0.72), dveWetness * 0.32);
vec3 viewDir = normalize(cameraPosition - worldPOS);
float dveSheen = pow(1.0 - max(dot(normalDir, viewDir), 0.0), 3.0);
terrainColor += vec3(0.1, 0.12, 0.16) * dveSheen * dveWetness * 0.28;
terrainColor = mix(terrainColor, terrainColor * vec3(0.68, 0.74, 0.82), dveWetness * dveBaseCavity * 0.05);

if (dveMaterialClass == ${TerrainMaterialClass.Soil}.0 || dveMaterialClass == ${TerrainMaterialClass.Cultivated}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.58, 0.64, 0.76), dveWetness * 0.16);
}
if (dveMaterialClass == ${TerrainMaterialClass.Rock}.0) {
  terrainColor += vec3(0.05, 0.06, 0.08) * dveWetness * 0.12;
}
if (dveMaterialClass == ${TerrainMaterialClass.Flora}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.74, 0.86, 0.74), dveWetness * 0.12);
}
`
    : "";

  const surfaceMetadataCode = terrain.surfaceMetadata && !isTransparent
    ? /* glsl */ `
terrainColor = mix(terrainColor, terrainColor * vec3(1.06, 1.05, 1.02), dveSurfaceExposure * 0.12);
terrainColor = mix(terrainColor, terrainColor * vec3(0.76, 0.74, 0.72), dveSurfaceCavity * 0.18);
terrainColor += vec3(0.035, 0.03, 0.025) * dveSurfaceSlope * (0.16 + dveCloseBoost * 0.18);
terrainColor = mix(terrainColor, terrainColor * vec3(1.04, 1.03, 1.0), dveSurfaceTop * 0.08);

if (dveMaterialClass == ${TerrainMaterialClass.Rock}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(1.08, 1.06, 1.02), dveSurfaceExposure * 0.12);
}
if (dveMaterialClass == ${TerrainMaterialClass.Soil}.0 || dveMaterialClass == ${TerrainMaterialClass.Cultivated}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.82, 0.76, 0.68), dveSurfaceCavity * 0.12);
}
if (dveMaterialClass == ${TerrainMaterialClass.Flora}.0) {
  terrainColor = mix(terrainColor, terrainColor * vec3(0.94, 1.04, 0.92), dveSurfaceExposure * 0.08);
}
`
    : "";

  return /* glsl */ `
vec3 terrainColor = FragColor.rgb;
vec3 normalDir = normalize(vNormal);
float slope = 1.0 - abs(normalDir.y);
${surfaceMetadataSetup}
${visualV2Code}
${macroVariationCode}
${surfaceOverlaysCode}
${microVariationCode}
${nearCameraHighDetailCode}
${transitionMeshesCode}
${triplanarCode}
${wetnessCode}
${surfaceMetadataCode}
FragColor.rgb = terrainColor;
`;
}

export default async function InitDVEBRClassic(initData: DVEBRClassicData) {
  if (initData.textureSize) {
    EngineSettings.settings.rendererSettings.textureSize = [
      ...initData.textureSize,
    ];
  }
  const progress = new WorkItemProgress();
  if (initData.getProgress) initData.getProgress(progress);
  progress.startTask("Init Classic Renderer");
  await CreateTextures(initData.scene, initData.textureData, progress);
  const terrainMaterialClassLookup = buildTerrainMaterialClassLookup();

  const engine = initData.scene.getEngine();
  SceneUBO.UniformBufferSuppourted = engine.supportsUniformBuffers;
  //items
  DVEBRShaderStore.setShaderData(
    "dve_item",
    [
      "world",
      "viewProjection",
      "dve_item",
      "dve_item_animation",
      "dve_item_animation_size",
    ],
    ["position", "normal", "textureIndex", "uv"],
  );

  DVEBRShaderStore.storeShader("dve_item", "vertex", ItemShader.GetVertex());

  DVEBRShaderStore.storeShader("dve_item", "frag", ItemShader.GetFragment());

  //voxel particles
  DVEBRShaderStore.setShaderData(
    "dve_voxel_particle",
    [
      "world",
      "viewProjection",
      "dve_voxel",
      "dve_voxel_animation",
      "dve_voxel_animation_size",
    ],
    ["position", "normal", "uv", "color"],
  );

  DVEBRShaderStore.storeShader(
    "dve_voxel_particle",
    "vertex",
    VoxelParticleShader.GetVertex(),
  );

  DVEBRShaderStore.storeShader(
    "dve_voxel_particle",
    "frag",
    VoxelParticleShader.GetFragment(),
  );

  for (const material of defaultMaterials) {
    const terrainFunctions = getClassicTerrainShaderFunctions();
    const terrainAfter = getClassicTerrainShaderAfter(material);
    DVEBRShaderStore.setShaderData(
      material,
      [
        "world",
        "viewProjection",
        "worldOrigin",
        "cameraPosition",
        "dve_terrain_material_class",
        "dve_voxel",
        "dve_voxel_animation",
        "dve_voxel_animation_size",
      ],
      ["position", "normal", "voxelData", "metadata", "textureIndex", "uv", "colors"],
    );

    DVEBRShaderStore.storeShader(
      material,
      "vertex",
      VoxelBaseShader.GetVertex({
        doAO: true,
      }),
    );
    DVEBRShaderStore.storeShader(
      material,
      "frag",
      material.includes("liquid")
        ? VoxelBaseShader.GetFragment({
            main: VoxelBaseShader.DefaultLiquidFragmentMain(true),
            functions: terrainFunctions,
            uniforms: getClassicTerrainUniforms(),
            inMainAfter: terrainAfter,
          })
        : VoxelBaseShader.GetFragment({
            main: VoxelBaseShader.DefaultFragmentMain(true),
            functions: terrainFunctions,
            uniforms: getClassicTerrainUniforms(),
            inMainAfter: terrainAfter,
          }),
    );
  }

  const renderer = await CreateDefaultRenderer({
    progress,
    afterCreate: async (_renderer, materials) => {
      for (const material of materials) {
        if (!(material instanceof DVEBRClassicMaterial)) continue;
        material.setNumberArray(
          "dve_terrain_material_class",
          terrainMaterialClassLookup
        );
      }
    },
    createMaterial: (renderer, scene, matData) => {
      const newMat = new DVEBRClassicMaterial(
        renderer.sceneOptions,
        matData.id,
        {
          scene,
          data: {
            effectId: matData.shaderId,
            textureTypeId: matData.textureTypeId || "",
          },
          ...matData,
        },
      );
      newMat.createMaterial(scene);
      return newMat;
    },
    scene: initData.scene,
    textureData: initData.textureData,
    textureTypes: initData.textureTypes,
    substances: initData.substances,
  });

  renderer.sceneOptions.shade.doSun = true;
  renderer.sceneOptions.shade.doRGB = true;
  renderer.sceneOptions.shade.doAO = true;
  renderer.sceneOptions.shade.doColor = true;
  renderer.sceneOptions.levels.baseLevel = 0.2;
  renderer.sceneOptions.levels.sunLevel = 1;
  renderer.sceneOptions.fog.setColor(255, 255, 255);
  renderer.sceneOptions.fog.heightFactor = 0.25;
  renderer.sceneOptions.sky.setColor(130, 174, 255);
  renderer.sceneOptions.sky.horizonStart = 0;
  renderer.sceneOptions.sky.horizon = 64;
  renderer.sceneOptions.sky.horizonEnd = 120;
  renderer.sceneOptions.sky.startBlend = 100;
  renderer.sceneOptions.sky.endBlend = 150;

  if (EngineSettings.settings.terrain.visualV2) {
    renderer.sceneOptions.sky.setColor(186, 214, 255);
    renderer.sceneOptions.levels.baseLevel = 0.3;
  }

  if (EngineSettings.settings.terrain.macroVariation) {
    renderer.sceneOptions.fog.heightFactor = Math.max(
      renderer.sceneOptions.fog.heightFactor,
      0.32
    );
  }

  if (EngineSettings.settings.terrain.materialTriplanar) {
    renderer.sceneOptions.fog.setColor(255, 228, 204);
    renderer.sceneOptions.fog.heightFactor = 0.4;
  }

  if (EngineSettings.settings.terrain.materialWetness) {
    renderer.sceneOptions.sky.setColor(86, 118, 168);
    renderer.sceneOptions.fog.setColor(132, 154, 196);
    renderer.sceneOptions.levels.baseLevel = 0.12;
  }

  if (EngineSettings.settings.terrain.surfaceOverlays) {
    renderer.sceneOptions.fog.heightFactor = Math.max(
      renderer.sceneOptions.fog.heightFactor,
      0.45
    );
  }

  if (EngineSettings.settings.terrain.nearCameraHighDetail) {
    renderer.sceneOptions.levels.baseLevel = Math.max(
      renderer.sceneOptions.levels.baseLevel,
      0.18
    );
  }

  if (EngineSettings.settings.terrain.microVariation) {
    renderer.sceneOptions.levels.baseLevel = Math.max(
      renderer.sceneOptions.levels.baseLevel,
      0.22
    );
  }

  renderer.sceneOptions.ubo.buffer?.update();

  progress.endTask();
  return renderer;
}
