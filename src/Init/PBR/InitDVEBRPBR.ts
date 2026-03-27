import { DVEBRPBRMaterial } from "../../Matereials/PBR/DVEBRPBRMaterial";
import { DVEBRDefaultMaterialBaseData } from "../../Matereials/Types/DVEBRDefaultMaterial.types";
import {
  CreateDefaultRenderer,
  CreateTextures,
} from "../Default/CreateDefaultRenderer";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SSRRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssrRenderingPipeline";
import { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { ColorCurves } from "@babylonjs/core/Materials/colorCurves";
import { Material } from "@babylonjs/core/Materials/material";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent";
import "@babylonjs/core/Rendering/prePassRendererSceneComponent";
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent";

import { LevelParticles } from "./LevelParticles";
import { WorkItemProgress } from "@divinevoxel/vlox/Util/WorkItemProgress";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";
import { MaterialInterface } from "../../Matereials/MaterialInterface";
import { InitSkybox } from "../Skybox/InitSkybox";
import { BilateralNormalSmoothPostProcess } from "../../PostProcess/BilateralNormalSmooth";
import {
  applyActiveTerrainMaterialProfiles,
  classifyTerrainMaterial,
} from "../../Matereials/PBR/MaterialFamilyProfiles";
import { getSceneWaterHybridBridge } from "../../Water/DVEWaterHybridBridge.js";
export type DVEBRPBRData = DVEBRDefaultMaterialBaseData & {
  getProgress?: (progress: WorkItemProgress) => void;
};

// ─── Preset renderer configuration lookup table ─────────────────────────────
// Fix 4: All per-preset numeric values live here. Adding a new preset only
// requires a single entry in this table — no more scattered if-chains.
// Fix 2: Safe SSR fallback (step=3, maxSteps=48, blurDownsample=2) prevents
// the documented ~1 FPS regression on unrecognised or future presets.
interface SSRPresetCfg {
  samples: number; strength: number; roughnessFactor: number;
  step: number; maxSteps: number; maxDistance: number;
  blurDownsample: number; thickness: number;
}
interface RendererPresetCfg {
  environmentIntensity: number;
  grainIntensity: number;
  bilateralStrength: number;   // 0 = SE-02 disabled for this preset
  depthOfField?: { enabled: boolean }; // T6: opt-in DoF for ground-plane grid softening
  ssr: SSRPresetCfg;
  ssao: { totalStrength: number; samples: number; radius: number };
}
const DEFAULT_RENDERER_PRESET: RendererPresetCfg = {
  environmentIntensity: 0.58,
  grainIntensity: 12,
  bilateralStrength: 0,
  ssr:  { samples: 2, strength: 0.8, roughnessFactor: 0.22, step: 3, maxSteps: 48, maxDistance: 128, blurDownsample: 2, thickness: 0.8 },
  ssao: { totalStrength: 0.8, samples: 12, radius: 1.5 },
};
const RENDERER_PRESET_CONFIGS: Readonly<Record<string, RendererPresetCfg>> = {
  "pbr-premium": {
    environmentIntensity: 0.42, grainIntensity: 16, bilateralStrength: 0.65,
    ssr:  { samples: 4, strength: 0.72, roughnessFactor: 0.24, step: 3, maxSteps: 52, maxDistance: 112, blurDownsample: 2, thickness: 1.05 },
    ssao: { totalStrength: 0.9, samples: 14, radius: 2.5 },
  },
  "pbr-premium-v2": {
    environmentIntensity: 0.68, grainIntensity: 16, bilateralStrength: 0.65,
    depthOfField: { enabled: true },
    ssr:  { samples: 4, strength: 0.8, roughnessFactor: 0.1, step: 3, maxSteps: 50, maxDistance: 128, blurDownsample: 2, thickness: 0.98 },
    ssao: { totalStrength: 0.9, samples: 16, radius: 2.2 },
  },
  "optimum-inspired": {
    environmentIntensity: 0.62, grainIntensity: 12, bilateralStrength: 0,
    ssr:  { samples: 4, strength: 0.76, roughnessFactor: 0.16, step: 3, maxSteps: 48, maxDistance: 128, blurDownsample: 2, thickness: 0.8 },
    ssao: { totalStrength: 0.8, samples: 12, radius: 1.5 },
  },
  "universalis-inspired": {
    environmentIntensity: 0.74, grainIntensity: 12, bilateralStrength: 0,
    ssr:  { samples: 4, strength: 0.82, roughnessFactor: 0.12, step: 3, maxSteps: 48, maxDistance: 128, blurDownsample: 2, thickness: 0.96 },
    ssao: { totalStrength: 0.85, samples: 14, radius: 2.2 },
  },
  "definitivo": {
    environmentIntensity: 0.78, grainIntensity: 14, bilateralStrength: 0.65,
    depthOfField: { enabled: true },
    ssr:  { samples: 4, strength: 0.84, roughnessFactor: 0.11, step: 3, maxSteps: 50, maxDistance: 128, blurDownsample: 2, thickness: 0.96 },
    ssao: { totalStrength: 0.97, samples: 16, radius: 3.2 },
  },
  // BUG-A01: these premium presets were missing — they fell to DEFAULT (ssr.samples=2, SE-02 off)
  "pbr-surface-lod": {
    environmentIntensity: 0.64, grainIntensity: 14, bilateralStrength: 0.55,
    ssr:  { samples: 4, strength: 0.78, roughnessFactor: 0.14, step: 3, maxSteps: 50, maxDistance: 128, blurDownsample: 2, thickness: 0.9 },
    ssao: { totalStrength: 0.85, samples: 14, radius: 2.2 },
  },
  "phase-4-geometry": {
    environmentIntensity: 0.66, grainIntensity: 14, bilateralStrength: 0.60,
    ssr:  { samples: 4, strength: 0.82, roughnessFactor: 0.12, step: 3, maxSteps: 50, maxDistance: 128, blurDownsample: 2, thickness: 0.92 },
    ssao: { totalStrength: 0.88, samples: 14, radius: 2.2 },
  },
};

const WATER_NORMAL_ASSET_PATH = "assets/water/water-001-normal.jpg";
const WATER_FOAM_BODY_ASSET_PATH = "assets/water/foam-body-001.jpg";
const WATER_FOAM_BREAKER_ASSET_PATH = "assets/water/foam-breaker-003.jpg";
const WATER_HDRI_ASSET_PATH = "assets/skybox-blouberg-sunrise-2.hdr";

function createLinearWaterTexture(scene: Scene, path: string) {
  const texture = new Texture(
    path,
    scene,
    false,
    false,
    Texture.TRILINEAR_SAMPLINGMODE
  );
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.gammaSpace = false;
  texture.anisotropicFilteringLevel = 4;
  return texture;
}
// ────────────────────────────────────────────────────────────────────────────

function applyTerrainPhase1SkyProfile(renderer: Awaited<ReturnType<typeof CreateDefaultRenderer>>) {
  const terrain = EngineSettings.settings.terrain;
  const isPBRPremium = terrain.benchmarkPreset === "pbr-premium";
  const isPBRPremiumV2 = terrain.benchmarkPreset === "pbr-premium-v2";
  const isMaterialImport = terrain.benchmarkPreset === "material-import";
  const isOptimumInspired = terrain.benchmarkPreset === "optimum-inspired";
  const isUniversalisInspired = terrain.benchmarkPreset === "universalis-inspired";
  const isDefinitivo = terrain.benchmarkPreset === "definitivo";

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

  if (terrain.visualV2) {
    renderer.sceneOptions.sky.setColor(186, 214, 255);
    renderer.sceneOptions.levels.baseLevel = 0.3;
  }

  if (terrain.macroVariation) {
    renderer.sceneOptions.fog.heightFactor = Math.max(
      renderer.sceneOptions.fog.heightFactor,
      0.32
    );
  }

  if (terrain.materialTriplanar) {
    renderer.sceneOptions.fog.setColor(255, 228, 204);
    renderer.sceneOptions.fog.heightFactor = 0.4;
  }

  if (terrain.materialWetness) {
    renderer.sceneOptions.sky.setColor(86, 118, 168);
    renderer.sceneOptions.fog.setColor(132, 154, 196);
    renderer.sceneOptions.levels.baseLevel = 0.12;
  }

  if (terrain.surfaceOverlays) {
    renderer.sceneOptions.fog.heightFactor = Math.max(
      renderer.sceneOptions.fog.heightFactor,
      0.45
    );
  }

  if (terrain.nearCameraHighDetail) {
    renderer.sceneOptions.levels.baseLevel = Math.max(
      renderer.sceneOptions.levels.baseLevel,
      0.18
    );
  }

  if (terrain.microVariation) {
    renderer.sceneOptions.levels.baseLevel = Math.max(
      renderer.sceneOptions.levels.baseLevel,
      0.22
    );
  }

  if (isMaterialImport) {
    renderer.sceneOptions.levels.baseLevel = Math.max(
      renderer.sceneOptions.levels.baseLevel,
      0.24
    );
    renderer.sceneOptions.fog.heightFactor = Math.max(
      renderer.sceneOptions.fog.heightFactor,
      0.3
    );
  }

  if (isOptimumInspired) {
    renderer.sceneOptions.sky.setColor(176, 205, 246);
    renderer.sceneOptions.fog.setColor(255, 230, 208);
    renderer.sceneOptions.fog.heightFactor = Math.max(
      renderer.sceneOptions.fog.heightFactor,
      0.44
    );
    renderer.sceneOptions.levels.baseLevel = Math.max(
      renderer.sceneOptions.levels.baseLevel,
      0.24
    );
  }

  if (isUniversalisInspired) {
    renderer.sceneOptions.sky.setColor(112, 146, 196);
    renderer.sceneOptions.fog.setColor(124, 150, 182);
    renderer.sceneOptions.fog.heightFactor = Math.max(
      renderer.sceneOptions.fog.heightFactor,
      0.52
    );
    renderer.sceneOptions.levels.baseLevel = Math.max(
      renderer.sceneOptions.levels.baseLevel,
      0.16
    );
    renderer.sceneOptions.sky.horizon = Math.max(renderer.sceneOptions.sky.horizon, 76);
    renderer.sceneOptions.sky.horizonEnd = Math.max(renderer.sceneOptions.sky.horizonEnd, 140);
  }

  if (isPBRPremium) {
    renderer.sceneOptions.sky.setColor(134, 170, 214);
    renderer.sceneOptions.fog.setColor(148, 166, 194);
    renderer.sceneOptions.fog.heightFactor = Math.max(
      renderer.sceneOptions.fog.heightFactor,
      0.48
    );
    renderer.sceneOptions.levels.baseLevel = Math.max(
      renderer.sceneOptions.levels.baseLevel,
      0.18
    );
  }

  if (isPBRPremiumV2) {
    renderer.sceneOptions.sky.setColor(118, 154, 204);
    renderer.sceneOptions.fog.setColor(132, 156, 188);
    renderer.sceneOptions.fog.heightFactor = Math.max(
      renderer.sceneOptions.fog.heightFactor,
      0.50
    );
    renderer.sceneOptions.levels.baseLevel = Math.max(
      renderer.sceneOptions.levels.baseLevel,
      0.17
    );
    renderer.sceneOptions.sky.horizon = Math.max(renderer.sceneOptions.sky.horizon, 76);
    renderer.sceneOptions.sky.horizonEnd = Math.max(renderer.sceneOptions.sky.horizonEnd, 140);
  }

  if (isDefinitivo) {
    // Deep azure zenith sky; warm amber-tinted horizon fog simulates late-afternoon sun scatter.
    renderer.sceneOptions.sky.setColor(102, 146, 210);  // deep azure zenith
    renderer.sceneOptions.fog.setColor(172, 148, 122);  // amber horizon haze
    renderer.sceneOptions.fog.heightFactor = Math.max(
      renderer.sceneOptions.fog.heightFactor,
      0.56
    );
    renderer.sceneOptions.levels.baseLevel = Math.max(
      renderer.sceneOptions.levels.baseLevel,
      0.22
    );
    renderer.sceneOptions.sky.horizon    = Math.max(renderer.sceneOptions.sky.horizon, 68);
    renderer.sceneOptions.sky.horizonEnd = Math.max(renderer.sceneOptions.sky.horizonEnd, 130);
    renderer.sceneOptions.sky.startBlend = Math.max(renderer.sceneOptions.sky.startBlend, 80);
    renderer.sceneOptions.sky.endBlend   = Math.max(renderer.sceneOptions.sky.endBlend, 128);
  }

  renderer.sceneOptions.ubo.buffer?.update();
}

function applyTerrainPhase1RendererProfile(
  pipeline: DefaultRenderingPipeline,
  ssr: SSRRenderingPipeline,
  sunLight: DirectionalLight
) {
  const terrain = EngineSettings.settings.terrain;
  const isPBRPremium = terrain.benchmarkPreset === "pbr-premium";
  const isPBRPremiumV2 = terrain.benchmarkPreset === "pbr-premium-v2";
  const isMaterialImport = terrain.benchmarkPreset === "material-import";
  const isOptimumInspired = terrain.benchmarkPreset === "optimum-inspired";
  const isUniversalisInspired = terrain.benchmarkPreset === "universalis-inspired";
  const isDefinitivo = terrain.benchmarkPreset === "definitivo";
  if (
    !terrain.visualV2 &&
    !terrain.materialTriplanar &&
    !terrain.materialWetness &&
    !isMaterialImport &&
    !isOptimumInspired &&
    !isUniversalisInspired &&
    !isPBRPremium &&
    !isPBRPremiumV2 &&
    !isDefinitivo
  ) {
    return;
  }

  if (isMaterialImport) {
    pipeline.imageProcessing.contrast = 1.16;
    pipeline.imageProcessing.exposure = 0.9;
    pipeline.bloomThreshold = 0.62;
    ssr.strength = 0.64;       // material-import not in RENDERER_PRESET_CONFIGS — keep here
    ssr.roughnessFactor = 0.24;
    sunLight.intensity = 6.8;
  }

  if (terrain.visualV2) {
    pipeline.imageProcessing.contrast = 1.12;
    pipeline.imageProcessing.exposure = 1.04;
    pipeline.bloomThreshold = 0.5;
    ssr.strength = 0.72;       // feature-flag path — not in table, keep here
    ssr.roughnessFactor = 0.18;
    sunLight.intensity = 8.2;
  }

  if (terrain.materialWetness) {
    pipeline.imageProcessing.exposure = 1.02;
    pipeline.bloomThreshold = 0.56;
    ssr.strength = 0.78;       // feature-flag path — not in table, keep here
    ssr.roughnessFactor = 0.14;
    sunLight.intensity = 8.0;
  }

  // BUG-A02: SSR params for named presets are now authoritative in RENDERER_PRESET_CONFIGS.
  // Only pipeline visual params (contrast, exposure, bloom, sunLight) remain here;
  // ssr.strength/samples/roughnessFactor/maxDistance were removed to eliminate the
  // dual-source-of-truth conflict where this function silently overrode the lookup table.
  if (isOptimumInspired) {
    pipeline.imageProcessing.contrast = 1.13;
    pipeline.imageProcessing.exposure = 1.08;
    pipeline.bloomThreshold = 0.5;
    sunLight.intensity = 8.6;
  }

  if (isUniversalisInspired) {
    pipeline.imageProcessing.contrast = 1.08;
    pipeline.imageProcessing.exposure = 1.22;
    pipeline.bloomThreshold = 0.54;
    sunLight.intensity = 9.4;
  }

  if (isPBRPremium) {
    pipeline.imageProcessing.contrast = 1.08;
    pipeline.imageProcessing.exposure = 1.3;
    pipeline.imageProcessing.toneMappingEnabled = false;
    pipeline.bloomThreshold = 0.62;
    sunLight.intensity = 9.6;
  }

  if (isPBRPremiumV2) {
    pipeline.imageProcessing.contrast = 1.1;
    pipeline.imageProcessing.exposure = 1.24;
    pipeline.bloomThreshold = 0.52;
    sunLight.intensity = 9.6;
  }

  if (isDefinitivo) {
    pipeline.imageProcessing.contrast = 1.18;  // punchy cinema contrast
    pipeline.imageProcessing.exposure = 1.28;  // brighter exposure, let ACES handle rolloff
    pipeline.bloomThreshold = 0.42;            // more surfaces contribute to haze
    sunLight.intensity = 11.5;                 // strong golden-hour sun
    sunLight.direction.set(-0.55, -0.76, -0.35); // low NW angle: late afternoon slant
    sunLight.diffuse.set(1.0, 0.91, 0.72);    // warm amber sunlight
    sunLight.specular.set(1.0, 0.93, 0.78);   // warm specular glint
    // Extra sharpening for organic terrain micro-detail
    pipeline.sharpen.edgeAmount = 0.36;
  }
}

function applyTerrainPhase1Atmosphere(scene: Scene, isPBRPremium: boolean) {
  const terrain = EngineSettings.settings.terrain;
  const isMaterialImport = terrain.benchmarkPreset === "material-import";
  const isOptimumInspired = terrain.benchmarkPreset === "optimum-inspired";
  const isUniversalisInspired = terrain.benchmarkPreset === "universalis-inspired";
  const isPBRPremiumV2 = terrain.benchmarkPreset === "pbr-premium-v2";
  const isDefinitivo = terrain.benchmarkPreset === "definitivo";
  if (
    !terrain.visualV2 &&
    !terrain.materialTriplanar &&
    !terrain.materialWetness &&
    !isMaterialImport &&
    !isOptimumInspired &&
    !isUniversalisInspired &&
    !isPBRPremium &&
    !isPBRPremiumV2 &&
    !isDefinitivo
  ) {
    return;
  }

  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = isDefinitivo
    ? 0.0022
    : isPBRPremiumV2
    ? 0.0023
    : isPBRPremium
    ? 0.00245
    : isUniversalisInspired
      ? 0.0021
    : isOptimumInspired
      ? 0.0017
    : terrain.materialWetness
      ? 0.0024
      : isMaterialImport
        ? 0.00075
      : 0.00145;

  if (isMaterialImport) {
    scene.fogEnabled = false;
    scene.fogMode = Scene.FOGMODE_NONE;
    scene.fogColor.set(0.74, 0.78, 0.8);
    scene.clearColor.set(0.58, 0.64, 0.7, 1);
    return;
  }

  if (isPBRPremiumV2) {
    scene.fogColor.set(0.54, 0.66, 0.78);
    scene.clearColor.set(0.58, 0.72, 0.86, 1);
    return;
  }

  if (isPBRPremium) {
    scene.fogColor.set(0.62, 0.71, 0.8);
    scene.clearColor.set(0.68, 0.78, 0.9, 1);
    return;
  }

  if (isDefinitivo) {
    // Warm afternoon haze — golden sun warms the low-frequency fog; sky stays azure.
    scene.fogColor.set(0.68, 0.62, 0.54);    // warm dusty amber-fog at horizon
    scene.clearColor.set(0.46, 0.64, 0.88, 1); // deeper azure sky
    return;
  }

  if (terrain.materialWetness) {
    scene.fogColor.set(0.62, 0.7, 0.8);
    scene.clearColor.set(0.68, 0.77, 0.9, 1);
    return;
  }

  if (isUniversalisInspired) {
    scene.fogColor.set(0.50, 0.62, 0.74);
    scene.clearColor.set(0.52, 0.66, 0.82, 1);
    return;
  }

  if (isOptimumInspired) {
    scene.fogColor.set(0.82, 0.84, 0.8);
    scene.clearColor.set(0.88, 0.9, 0.86, 1);
    return;
  }

  scene.fogColor.set(0.79, 0.84, 0.9);
  scene.clearColor.set(0.84, 0.9, 0.97, 1);
}

function applyTerrainPhase1MaterialProfile(materials: MaterialInterface[]) {
  const terrain = EngineSettings.settings.terrain;
  const isPBRPremium = terrain.benchmarkPreset === "pbr-premium";
  const isPBRPremiumV2 = terrain.benchmarkPreset === "pbr-premium-v2";
  const isMaterialImport = terrain.benchmarkPreset === "material-import";
  const isOptimumInspired = terrain.benchmarkPreset === "optimum-inspired";
  const isUniversalisInspired = terrain.benchmarkPreset === "universalis-inspired";
  const isDefinitivo = terrain.benchmarkPreset === "definitivo";
  if (
    !terrain.visualV2 &&
    !terrain.materialTriplanar &&
    !terrain.materialWetness &&
    !isMaterialImport &&
    !isOptimumInspired &&
    !isUniversalisInspired &&
    !isPBRPremium &&
    !isPBRPremiumV2 &&
    !isDefinitivo
  ) {
    return;
  }

  for (const material of materials) {
    if (!(material instanceof DVEBRPBRMaterial)) continue;
    if (classifyTerrainMaterial(material.id).isLiquid) continue;

    const pbr = material._material;
    applyActiveTerrainMaterialProfiles(pbr, material.id, terrain);

    pbr.markAsDirty(Material.AllDirtyFlag);
  }
}

const terrainPhase1StartupDirtyFlags = 127;

function getTrackedPBRMaterials(materials: MaterialInterface[]) {
  return materials
    .filter((material): material is DVEBRPBRMaterial => {
      return material instanceof DVEBRPBRMaterial;
    })
    .map((material) => material._material);
}

function getScenePBRMaterials(scene: Scene) {
  return scene.materials.filter(
    (
      material
    ): material is Material & {
      markAsDirty: (flag: number) => void;
      isReady?: () => boolean;
      name?: string;
    } =>
      material.getClassName?.() === "PBRMaterial" ||
      material.constructor?.name === "PBRMaterial"
  );
}

function collectTerrainPhase1PBRMaterials(
  scene: Scene,
  materials: MaterialInterface[]
) {
  const uniqueMaterials = new Set<Material>();
  const collectedMaterials: Array<
    Material & {
      markAsDirty: (flag: number) => void;
      isReady?: () => boolean;
      name?: string;
    }
  > = [];

  for (const material of getTrackedPBRMaterials(materials)) {
    uniqueMaterials.add(material);
    collectedMaterials.push(material);
  }

  for (const material of getScenePBRMaterials(scene)) {
    if (uniqueMaterials.has(material)) {
      continue;
    }
    uniqueMaterials.add(material);
    collectedMaterials.push(material);
  }

  return collectedMaterials;
}

function scheduleTerrainPhase1MaterialProfileRefresh(
  scene: Scene,
  materials: MaterialInterface[]
) {
  const minimumSceneMeshes = 160;
  const minimumPBRMaterials = 6;
  const maxPollFrames = 2400;
  const maxRefreshFrames = 720;
  const minimumRefreshFrames = 120;
  const refreshIntervalFrames = 12;
  const refreshDelayFrames = 30;
  const requiredReadyFrames = 16;
  const scheduleFrame =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (callback: FrameRequestCallback) => setTimeout(callback, 16);
  let pollFrames = 0;
  let refreshFrames = 0;
  let delayFrames = 0;
  let readyFrames = 0;
  const tick = () => {
    const sceneDisposed = Boolean(scene.isDisposed);
    if (sceneDisposed) {
      return;
    }

    const scenePBRMaterials = collectTerrainPhase1PBRMaterials(scene, materials);

    if (
      scene.meshes.length < minimumSceneMeshes ||
      scenePBRMaterials.length < minimumPBRMaterials
    ) {
      pollFrames++;
      if (pollFrames < maxPollFrames) {
        scheduleFrame(tick);
      }
      return;
    }

    if (delayFrames < refreshDelayFrames) {
      delayFrames++;
      scheduleFrame(tick);
      return;
    }

    const shouldRefreshNow = refreshFrames % refreshIntervalFrames === 0;
    if (shouldRefreshNow) {
      applyTerrainPhase1MaterialProfile(materials);
      for (const material of scenePBRMaterials) {
        material.markAsDirty(terrainPhase1StartupDirtyFlags);
      }
    }

    refreshFrames++;
    const hasPendingMaterials = scenePBRMaterials.some(
      (material) => material.isReady?.() === false
    );
    readyFrames = hasPendingMaterials ? 0 : readyFrames + 1;

    const shouldContinueRefreshing =
      refreshFrames < minimumRefreshFrames ||
      hasPendingMaterials ||
      readyFrames < requiredReadyFrames;

    if (shouldContinueRefreshing && refreshFrames < maxRefreshFrames) {
      scheduleFrame(tick);
    }
  };

  scheduleFrame(tick);
}

function scheduleTerrainPhase1PostRenderWarmup(
  scene: Scene,
  materials: MaterialInterface[]
) {
  const startRefreshFrame = 2;
  const endRefreshFrame = 8;
  let renderFrames = 0;

  const observer = scene.onBeforeRenderObservable.add(() => {
    if (scene.isDisposed) {
      if (observer) {
        scene.onBeforeRenderObservable.remove(observer);
      }
      return;
    }

    renderFrames++;
    if (renderFrames < startRefreshFrame) {
      return;
    }

    const trackedPBRMaterials = collectTerrainPhase1PBRMaterials(scene, materials);
    applyTerrainPhase1MaterialProfile(materials);
    for (const material of trackedPBRMaterials) {
      material.markAsDirty(terrainPhase1StartupDirtyFlags);
    }

    if (renderFrames >= endRefreshFrame && observer) {
      scene.onBeforeRenderObservable.remove(observer);
    }
  });
}

export default async function InitDVEPBR(initData: DVEBRPBRData) {
  if (initData.textureSize) {
    EngineSettings.settings.rendererSettings.textureSize = [
      ...initData.textureSize,
    ];
  }
  const progress = new WorkItemProgress();
  if (initData.getProgress) initData.getProgress(progress);
  progress.startTask("Init PBR Renderer");
  const scene = initData.scene;
  const terrain = EngineSettings.settings.terrain;
  const isPBRPremium = terrain.benchmarkPreset === "pbr-premium";
  const isPBRPremiumV2 = terrain.benchmarkPreset === "pbr-premium-v2";
  const isOptimumInspired = terrain.benchmarkPreset === "optimum-inspired";
  const isUniversalisInspired = terrain.benchmarkPreset === "universalis-inspired";
  const isDefinitivo = terrain.benchmarkPreset === "definitivo";
  // Fix 4: resolve all numeric preset config from the lookup table.
  // Unknown/future presets fall back to DEFAULT_RENDERER_PRESET (safe SSR values).
  const presetCfg = RENDERER_PRESET_CONFIGS[terrain.benchmarkPreset] ?? DEFAULT_RENDERER_PRESET;
  const activeCamera = scene.activeCamera ?? scene.cameras[0];
  if (!activeCamera) {
    throw new Error(
      "InitDVEPBR requires an active camera on the scene before initialization."
    );
  }
  await CreateTextures(initData.scene, initData.textureData, progress);
  const hdrTexture = new HDRCubeTexture(WATER_HDRI_ASSET_PATH, scene, 512);
  initData.scene.environmentTexture = hdrTexture;
  // BUG-G02: dispose the HDR texture (~3–6 MB VRAM) when the scene is torn down;
  // without this, reloads leak the old texture in GPU memory indefinitely.
  scene.onDisposeObservable.addOnce(() => hdrTexture.dispose());
  initData.scene.environmentIntensity = presetCfg.environmentIntensity;
  const pipeline = new DefaultRenderingPipeline("atom", true, initData.scene, [
    activeCamera,
  ]);
  activeCamera.maxZ = 600;
  const postprocess = pipeline.imageProcessing;
  postprocess.toneMappingEnabled = !isPBRPremium;
  postprocess.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.contrast = 1.08;
  pipeline.imageProcessing.exposure = 1.02;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.52;
  // Bloom shape: wider kernel for softer atmospheric glow (cinematic haze)
  pipeline.bloomKernel = 96;
  pipeline.bloomWeight = 0.72;
  pipeline.bloomScale  = 0.9;
  // R20: Enable sharpening to compensate FXAA blur
  pipeline.sharpenEnabled = true;
  pipeline.sharpen.edgeAmount = 0.28;
  pipeline.sharpen.colorAmount = 1.0;
  // T6: DoF opt-in — ground-plane blur softens the distant cubic grid pattern.
  // Enabled only for presets that declare depthOfField.enabled in RENDERER_PRESET_CONFIGS.
  pipeline.depthOfFieldEnabled = presetCfg.depthOfField?.enabled ?? false;
  if (pipeline.depthOfFieldEnabled) {
    pipeline.depthOfField.focalLength   = 55;    // 55mm telephoto — natural FOV compression
    pipeline.depthOfField.fStop         = 2.4;   // f/2.4 — shallow but not distracting
    pipeline.depthOfField.focusDistance = 10000; // 10 m midground: near terrain sharp, far horizon soft
    pipeline.depthOfField.lensSize      = 50;
  }

  // R14: Color grading via color curves — cinematic teal/orange split
  // Warm amber shadows + cold teal highlights = film look without a LUT texture.
  pipeline.imageProcessing.colorCurvesEnabled = true;
  const curves = new ColorCurves();
  curves.shadowsHue        = 22;   // amber-orange shadows (sunset warmth)
  curves.shadowsDensity    = 30;
  curves.shadowsSaturation = 36;
  curves.highlightsHue        = 194; // teal highlights (sky bounce)
  curves.highlightsDensity    = 22;
  curves.highlightsSaturation = 28;
  curves.midtonesHue        = 18;   // slight golden midtone cast
  curves.midtonesDensity    = 10;
  curves.midtonesSaturation = 16;
  pipeline.imageProcessing.colorCurves = curves;

  pipeline.fxaaEnabled = true;
  pipeline.fxaa.adaptScaleToCurrentViewport = true;

  // F02: Filmic vignette — MULTIPLY blend darkens screen edges for cinematic depth.
  pipeline.imageProcessing.vignetteEnabled = true;
  pipeline.imageProcessing.vignetteWeight = 3.0;  // stronger oval frame
  pipeline.imageProcessing.vignetteCentreX = 0.0;
  pipeline.imageProcessing.vignetteCentreY = 0.08; // very slightly off-centre toward top
  pipeline.imageProcessing.vignetteBlendMode = 0; // 0 = VIGNETTEMODE_MULTIPLY
  // F02: Animated film grain — breaks color banding, adds high-frequency cinematic texture.
  pipeline.grainEnabled = true;
  pipeline.grain.intensity = presetCfg.grainIntensity;
  pipeline.grain.animated = true;

  /*   const glow = new GlowLayer("", scene);
  glow.intensity = 1;
 */
  LevelParticles.init(scene);
  applyTerrainPhase1Atmosphere(scene, isPBRPremium || isPBRPremiumV2);
  const ssr = new SSRRenderingPipeline("ssr", initData.scene, [
    activeCamera,
  ]);

  // ssr.reflectionSpecularFalloffExponent = 2;

  ssr.environmentTexture = hdrTexture as any;
  ssr.environmentTextureIsProbe = false;
  // Fix 2+4: SSR values from lookup table. Safe fallback guarantees step=3,
  // maxSteps=48, blurDownsample=2 — preventing the documented ~1 FPS regression
  // seen with step=2/maxSteps=64/blurDownsample=1 on unrecognised presets.
  ssr.samples           = presetCfg.ssr.samples;
  ssr.strength          = presetCfg.ssr.strength;
  ssr.roughnessFactor   = presetCfg.ssr.roughnessFactor;
  ssr.reflectivityThreshold = 0.12;
  ssr.selfCollisionNumSkip  = 2;
  ssr.step              = presetCfg.ssr.step;
  ssr.maxSteps          = presetCfg.ssr.maxSteps;
  ssr.maxDistance       = presetCfg.ssr.maxDistance;
  ssr.blurDownsample    = presetCfg.ssr.blurDownsample;
  ssr.thickness         = presetCfg.ssr.thickness;

  // R20: SSAO2 — contact shadows for voxel geometry
  const ssao = new SSAO2RenderingPipeline("ssao", initData.scene, {
    ssaoRatio: 0.5,
    blurRatio: 0.5,
  }, [activeCamera]);
  ssao.radius = presetCfg.ssao.radius;  // T5: per-preset radius; premium=2.2–2.5 for chamfer visual effect
  ssao.totalStrength = presetCfg.ssao.totalStrength;
  ssao.base = 0.1;
  ssao.samples = presetCfg.ssao.samples;
  ssao.maxZ = 200;
  ssao.minZAspect = 0.5;

  // SE-02: Bilateral normal filter — edge-preserving colour blend at cube face boundaries.
  // Fix 3: capture instance for runtime toggle/strength tuning and deterministic cleanup.
  const bilateralNormalSmooth = presetCfg.bilateralStrength > 0
    ? new BilateralNormalSmoothPostProcess(initData.scene, activeCamera, presetCfg.bilateralStrength)
    : null;
  if (bilateralNormalSmooth) {
    scene.onDisposeObservable.addOnce(() => bilateralNormalSmooth.dispose());
  }

  /*   ssrPipeline.thickness = 0.1;
  ssrPipeline.selfCollisionNumSkip = 2;
  ssrPipeline.blurDispersionStrength = 0;
  ssrPipeline.roughnessFactor = 0; */
  //ssrPipeline.environmentTexture = probe.cubeTexture as any;
  // ssrPipeline.environmentTextureIsProbe = true;

  const renderer = await CreateDefaultRenderer({
    progress,
    createMaterial: (renderer, scene, matData) => {
      const newMat = new DVEBRPBRMaterial(renderer.sceneOptions, matData.id, {
        scene,
        data: {
          effectId: matData.shaderId,
          textureTypeId: matData.textureTypeId || "",
        },
        ...matData,
      });
      newMat.createMaterial(scene);
      return newMat;
    },
    scene: initData.scene,
    textureData: initData.textureData,
    textureTypes: initData.textureTypes,
    substances: initData.substances,
    afterCreate: async (_renderer, materials) => {
      const waterNormalTexture = createLinearWaterTexture(scene, WATER_NORMAL_ASSET_PATH);
      const waterFoamBodyTexture = createLinearWaterTexture(scene, WATER_FOAM_BODY_ASSET_PATH);
      const waterFoamBreakerTexture = createLinearWaterTexture(scene, WATER_FOAM_BREAKER_ASSET_PATH);
      const waterHybridBridge = getSceneWaterHybridBridge(scene);
      scene.onDisposeObservable.addOnce(() => {
        waterNormalTexture.dispose();
        waterFoamBodyTexture.dispose();
        waterFoamBreakerTexture.dispose();
        waterHybridBridge.dispose();
      });
      for (const material of materials) {
        material.setTexture("dve_water_hybrid_base", waterHybridBridge.getBaseTexture());
        material.setTexture("dve_water_hybrid_dynamic", waterHybridBridge.getDynamicTexture());
        material.setTexture("dve_water_hybrid_flow", waterHybridBridge.getFlowTexture());
        if (!classifyTerrainMaterial(material.id).isLiquid) continue;
        material.setTexture("dve_water_normal", waterNormalTexture);
        material.setTexture("dve_water_foam_body", waterFoamBodyTexture);
        material.setTexture("dve_water_foam_breaker", waterFoamBreakerTexture);
      }

      scene.ambientColor.set(1, 1, 1);
      // Prevenir que el depth buffer se limpie entre render groups, permitiendo 
      // que el shader de líquidos (Group 1) colisione con el terreno (Group 0).
      scene.setRenderingAutoClearDepthStencil(1, false, false, false);
      
      {
        // direction=(0,1,0): sky is "up", ground hemisphere is "down".
        // (0,0,0) is an invalid direction that produces undefined behaviour in some GL drivers.
        const hemLight = new HemisphericLight("", new Vector3(0, 1, 0), scene);
        hemLight.specular.set(0, 0, 0);
        // Definitivo: sky hemisphere is cooler blue-tinted (azure bounce from clear sky),
        // ground hemisphere is warm ochre (reflected amber from sun-lit terrain).
        if (isDefinitivo) {
          hemLight.intensity    = 0.52;
          hemLight.diffuse.set(0.56, 0.62, 0.78);     // cool blue sky bouncelight
          hemLight.groundColor.set(0.88, 0.80, 0.62);  // warm ochre ground bounce
        } else {
          hemLight.intensity = 0.4;
          hemLight.diffuse.set(0.6, 0.62, 0.66);
          hemLight.groundColor.set(0.82, 0.85, 0.9);
        }
      }

      /*     */
      /*     
      {
        const hemLight = new HemisphericLight("", new Vector3(0, -1, 0), scene);
        hemLight.specular.set(0, 0, 0);
        hemLight.intensity = 0.1;
      } */
      // probe.renderList = [];
      const sunLight = new DirectionalLight(
        "",
        new Vector3(-1, -1, -0.5),
        initData.scene
      );
      const isMaterialImport =
        EngineSettings.settings.terrain.benchmarkPreset === "material-import";

      sunLight.intensity = 10;
      sunLight.shadowMinZ = 1;
      sunLight.shadowMaxZ = 500;
      sunLight.position.y = 200;

      sunLight.diffuse.set(1, 0.95, 0.88);
      // Enable specular on the sun light so PBR surfaces (especially water) receive
      // sun glint and specular highlights. Previously disabled (0,0,0) which caused
      // the water to appear uniformly flat with no solar sparkle.
      sunLight.specular.set(1, 0.95, 0.88);

      // R14: Enable Scene Depth Renderer for soft liquid intersection and wet shores
      scene.enableDepthRenderer(scene.activeCamera || undefined, false, true);

      if (isMaterialImport) {
        // Imported material arrays still destabilize the shadow compile path here.
        // Keep this disabled until Etapa 1 can re-enable shadows without black-world startup regressions.
        sunLight.shadowEnabled = false;
      } else {
        // R13: Cascaded Shadow Generator — 2 cascades (near + far) for quality gradient + PCF softening.
        // Performance notes: numCascades=2 saves ~20% draw calls vs 3; autoCalcDepthBounds=false avoids
        // per-frame GPU readback; stabilizeCascades=true reduces cascade-boundary shimmer on movement.
        const shadowMapSize = 512;
        const shadows = new CascadedShadowGenerator(shadowMapSize, sunLight);
        shadows.numCascades = 2;
        shadows.lambda = 0.9;          // slight spread — near cascade covers crisp region, far covers mid-range
        shadows.stabilizeCascades = true;
        shadows.usePercentageCloserFiltering = true;
        shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
        shadows.setDarkness(0.1);

        // R13: Register terrain chunks as shadow casters and receivers.
        // DVE terrain meshes use empty names ("") — filter on that identifier.
        // BUG-G01: capture observer references so they can be removed on scene dispose;
        // without cleanup, each reload accumulates N duplicate observers → N shadow draw calls per chunk.
        const onMeshAdded = scene.onNewMeshAddedObservable.add((mesh) => {
          if (mesh.name === "") {
            shadows.addShadowCaster(mesh);
            mesh.receiveShadows = true;
          }
        });
        const onMeshRemoved = scene.onMeshRemovedObservable.add((mesh) => {
          if (mesh.name === "") {
            shadows.removeShadowCaster(mesh);
          }
        });
        scene.onDisposeObservable.addOnce(() => {
          scene.onNewMeshAddedObservable.remove(onMeshAdded);
          scene.onMeshRemovedObservable.remove(onMeshRemoved);
          shadows.dispose();
        });
      }

      // this.shadows.blurScale = 0;
      // initData.scene.useRightHandedSystem = false;

      // R17: Weather state controller — per-frame fog/light/SSR modulation driven by
      // (terrain as any).weatherState (0=clear, 1=full rain). Game layer sets this value;
      // the observer applies corresponding scene-level changes each frame.
      const dve_baseFogDensity = scene.fogDensity;
      const dve_baseSunIntensity = sunLight.intensity;
      scene.onBeforeRenderObservable.add(() => {
        // R04: Update LOD camera position so mesher-side SubdivisionBuilder can cap N by distance.
        // Written each frame; read lazily when a chunk builds and accesses lodCameraPos.
        const dve_cam = scene.activeCamera;
        if (dve_cam) {
          const cp = dve_cam.globalPosition;
          (EngineSettings.settings.terrain as any).lodCameraPos = [cp.x, cp.y, cp.z];
        }

        const dve_ws = (EngineSettings.settings.terrain as any).weatherState ?? 0.0;
        if (dve_ws < 0.001) {
          scene.fogDensity = dve_baseFogDensity;
          sunLight.intensity = dve_baseSunIntensity;
          return;
        }
        const dve_rAmt = Math.max(0, Math.min(1, (dve_ws - 0.3) / 0.55));
        const dve_t = dve_rAmt * dve_rAmt * (3 - 2 * dve_rAmt); // smoothstep
        scene.fogDensity = dve_baseFogDensity * (1 + dve_t * 0.22);
        sunLight.intensity = dve_baseSunIntensity * (1 - dve_t * 0.18);
        ssr.strength = Math.min(0.82 + dve_t * 0.10, 1.0);
      });

      applyTerrainPhase1RendererProfile(pipeline, ssr, sunLight);
      applyTerrainPhase1MaterialProfile(materials);
      scheduleTerrainPhase1MaterialProfileRefresh(scene, materials);
      scheduleTerrainPhase1PostRenderWarmup(scene, materials);
      LevelParticles.startNatureAmbient(
        isPBRPremium || isPBRPremiumV2 || isUniversalisInspired || isDefinitivo ? "premium" : "lush"
      );
      initData.scene.ambientColor.set(0.32, 0.33, 0.38);

      const visibleSkybox = InitSkybox({ renderer: _renderer });
      visibleSkybox.renderingGroupId = 0;
      visibleSkybox.infiniteDistance = true;
      visibleSkybox.isPickable = false;

      DVEBRPBRMaterial.flushImportedMapLog();

      /*    LevelParticles.start(
        new Color4(0, 1, 1, 1),
        new Color4(0, 1, 1, 0.7),
        new Color4(0, 1, 1, 0.5)
      ); */
    },
  });

  applyTerrainPhase1SkyProfile(renderer);

  return renderer;
}
