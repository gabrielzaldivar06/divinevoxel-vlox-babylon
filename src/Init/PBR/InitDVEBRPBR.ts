import { DVEBRPBRMaterial } from "../../Matereials/PBR/DVEBRPBRMaterial";
import { DVEBRDefaultMaterialBaseData } from "../../Matereials/Types/DVEBRDefaultMaterial.types";
import {
  CreateDefaultRenderer,
  CreateTextures,
} from "../Default/CreateDefaultRenderer";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SSRRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssrRenderingPipeline";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
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

import { LevelParticles } from "./LevelParticles";
import { WorkItemProgress } from "@divinevoxel/vlox/Util/WorkItemProgress";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";
import { MaterialInterface } from "../../Matereials/MaterialInterface";
import { InitSkybox } from "../Skybox/InitSkybox";
import {
  applyActiveTerrainMaterialProfiles,
  classifyTerrainMaterial,
} from "../../Matereials/PBR/MaterialFamilyProfiles";
export type DVEBRPBRData = DVEBRDefaultMaterialBaseData & {
  getProgress?: (progress: WorkItemProgress) => void;
};

function applyTerrainPhase1SkyProfile(renderer: Awaited<ReturnType<typeof CreateDefaultRenderer>>) {
  const terrain = EngineSettings.settings.terrain;
  const isPBRPremium = terrain.benchmarkPreset === "pbr-premium";
  const isPBRPremiumV2 = terrain.benchmarkPreset === "pbr-premium-v2";
  const isMaterialImport = terrain.benchmarkPreset === "material-import";
  const isOptimumInspired = terrain.benchmarkPreset === "optimum-inspired";
  const isUniversalisInspired = terrain.benchmarkPreset === "universalis-inspired";

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
  if (
    !terrain.visualV2 &&
    !terrain.materialTriplanar &&
    !terrain.materialWetness &&
    !isMaterialImport &&
    !isOptimumInspired &&
    !isUniversalisInspired &&
    !isPBRPremium &&
    !isPBRPremiumV2
  ) {
    return;
  }

  if (isMaterialImport) {
    pipeline.imageProcessing.contrast = 1.16;
    pipeline.imageProcessing.exposure = 0.9;
    pipeline.bloomThreshold = 0.62;
    ssr.strength = 0.64;
    ssr.roughnessFactor = 0.24;
    sunLight.intensity = 6.8;
  }

  if (terrain.visualV2) {
    pipeline.imageProcessing.contrast = 1.12;
    pipeline.imageProcessing.exposure = 1.04;
    pipeline.bloomThreshold = 0.5;
    ssr.strength = 0.72;
    ssr.roughnessFactor = 0.18;
    sunLight.intensity = 8.2;
  }

  if (terrain.materialWetness) {
    pipeline.imageProcessing.exposure = 1.02;
    pipeline.bloomThreshold = 0.56;
    ssr.strength = 0.78;
    ssr.roughnessFactor = 0.14;
    sunLight.intensity = 8.0;
  }

  if (isOptimumInspired) {
    pipeline.imageProcessing.contrast = 1.13;
    pipeline.imageProcessing.exposure = 1.08;
    pipeline.bloomThreshold = 0.5;
    ssr.samples = Math.max(ssr.samples, 4);
    ssr.strength = 0.76;
    ssr.roughnessFactor = 0.16;
    sunLight.intensity = 8.6;
  }

  if (isUniversalisInspired) {
    pipeline.imageProcessing.contrast = 1.08;
    pipeline.imageProcessing.exposure = 1.22;
    pipeline.bloomThreshold = 0.54;
    ssr.samples = Math.max(ssr.samples, 4);
    ssr.strength = 0.88;
    ssr.roughnessFactor = 0.08;
    ssr.maxDistance = Math.max(ssr.maxDistance, 128);
    sunLight.intensity = 9.4;
  }

  if (isPBRPremium) {
    pipeline.imageProcessing.contrast = 1.08;
    pipeline.imageProcessing.exposure = 1.3;
    pipeline.imageProcessing.toneMappingEnabled = false;
    pipeline.bloomThreshold = 0.62;
    ssr.samples = 6;
    ssr.strength = 0.66;
    ssr.roughnessFactor = 0.24;
    sunLight.intensity = 9.6;
  }

  if (isPBRPremiumV2) {
    pipeline.imageProcessing.contrast = 1.1;
    pipeline.imageProcessing.exposure = 1.24;
    pipeline.bloomThreshold = 0.52;
    ssr.samples = Math.max(ssr.samples, 4);
    ssr.strength = 0.84;
    ssr.roughnessFactor = 0.1;
    ssr.maxDistance = Math.max(ssr.maxDistance, 128);
    sunLight.intensity = 9.6;
  }
}

function applyTerrainPhase1Atmosphere(scene: Scene, isPBRPremium: boolean) {
  const terrain = EngineSettings.settings.terrain;
  const isMaterialImport = terrain.benchmarkPreset === "material-import";
  const isOptimumInspired = terrain.benchmarkPreset === "optimum-inspired";
  const isUniversalisInspired = terrain.benchmarkPreset === "universalis-inspired";
  const isPBRPremiumV2 = terrain.benchmarkPreset === "pbr-premium-v2";
  if (
    !terrain.visualV2 &&
    !terrain.materialTriplanar &&
    !terrain.materialWetness &&
    !isMaterialImport &&
    !isOptimumInspired &&
    !isUniversalisInspired &&
    !isPBRPremium &&
    !isPBRPremiumV2
  ) {
    return;
  }

  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = isPBRPremiumV2
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
  if (
    !terrain.visualV2 &&
    !terrain.materialTriplanar &&
    !terrain.materialWetness &&
    !isMaterialImport &&
    !isOptimumInspired &&
    !isUniversalisInspired &&
    !isPBRPremium &&
    !isPBRPremiumV2
  ) {
    return;
  }

  for (const material of materials) {
    if (!(material instanceof DVEBRPBRMaterial)) continue;

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
  const activeCamera = scene.activeCamera ?? scene.cameras[0];
  if (!activeCamera) {
    throw new Error(
      "InitDVEPBR requires an active camera on the scene before initialization."
    );
  }
  await CreateTextures(initData.scene, initData.textureData, progress);
  const hdrTexture = new HDRCubeTexture("assets/skybox.hdr", scene, 512);
  initData.scene.environmentTexture = hdrTexture;
  initData.scene.environmentIntensity = isPBRPremiumV2
    ? 0.68
    : isPBRPremium
    ? 0.42
    : isUniversalisInspired
      ? 0.74
    : isOptimumInspired
      ? 0.62
    : 0.58;
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
  // pipeline.sharpenEnabled = true;
  pipeline.depthOfFieldEnabled = false;

  pipeline.fxaaEnabled = true;
  pipeline.fxaa.adaptScaleToCurrentViewport = true;

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
  ssr.samples = isPBRPremiumV2 ? 4 : isPBRPremium ? 4 : isUniversalisInspired ? 4 : isOptimumInspired ? 4 : 2;
  ssr.strength = isPBRPremiumV2 ? 0.8 : isPBRPremium ? 0.72 : isUniversalisInspired ? 0.82 : isOptimumInspired ? 0.76 : 0.8;
  ssr.roughnessFactor = isPBRPremiumV2 ? 0.1 : isPBRPremium ? 0.24 : isUniversalisInspired ? 0.12 : isOptimumInspired ? 0.16 : 0.22;
  ssr.reflectivityThreshold = 0.12;
  ssr.selfCollisionNumSkip = 2;
  ssr.step = isPBRPremiumV2 ? 3 : isPBRPremium ? 3 : isUniversalisInspired ? 3 : isOptimumInspired ? 3 : 2;
  ssr.maxSteps = isPBRPremiumV2 ? 50 : isPBRPremium ? 52 : isUniversalisInspired ? 48 : isOptimumInspired ? 48 : 64;
  ssr.maxDistance = isPBRPremiumV2 ? 128 : isPBRPremium ? 112 : isUniversalisInspired ? 128 : 128;
  ssr.blurDownsample = isPBRPremiumV2 ? 2 : isPBRPremium ? 2 : isUniversalisInspired ? 2 : isOptimumInspired ? 2 : 1;
  ssr.thickness = isPBRPremiumV2 ? 0.98 : isPBRPremium ? 1.05 : isUniversalisInspired ? 0.96 : 0.8;
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
      scene.ambientColor.set(1, 1, 1);
      {
        const hemLight = new HemisphericLight("", new Vector3(0, 0, 0), scene);
        hemLight.specular.set(0, 0, 0);
        hemLight.intensity = 0.4;
        hemLight.diffuse.set(0.6, 0.62, 0.66);
        hemLight.groundColor.set(0.82, 0.85, 0.9);
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
      sunLight.specular.set(0, 0, 0);
      if (isMaterialImport) {
        // Imported material arrays still destabilize the shadow compile path here.
        // Keep this disabled until Etapa 1 can re-enable shadows without black-world startup regressions.
        sunLight.shadowEnabled = false;
      } else {
        const shadowMapSize = 1024;
        const shadows = new ShadowGenerator(shadowMapSize, sunLight);
        // this.shadows.usePoissonSampling = true;
        shadows.usePercentageCloserFiltering = true;

        //  shadows.forceBackFacesOnly = true;
        shadows.useContactHardeningShadow = true;
        shadows.contactHardeningLightSizeUVRatio = isPBRPremium || isPBRPremiumV2 ? 0.08 : 0.05;
        shadows.setDarkness(0.1);
      }

      // this.shadows.blurScale = 0;
      // initData.scene.useRightHandedSystem = false;

      applyTerrainPhase1RendererProfile(pipeline, ssr, sunLight);
      applyTerrainPhase1MaterialProfile(materials);
      scheduleTerrainPhase1MaterialProfileRefresh(scene, materials);
      scheduleTerrainPhase1PostRenderWarmup(scene, materials);
      LevelParticles.startNatureAmbient(
        isPBRPremium || isPBRPremiumV2 || isUniversalisInspired ? "premium" : "lush"
      );
      /*  
      renderer.observers.meshCreated.subscribe(InitDVEPBR, (mesh) => {
        if (!probe.renderList) probe.renderList = [];
  if (mesh._mesh.id.includes("glow")) {

          glow.referenceMeshToUseItsOwnMaterial(mesh._mesh);
        }
        shadows.addShadowCaster(mesh._mesh);

        mesh._mesh.receiveShadows = true;
        probe.renderList.push(mesh._mesh);
      });
      renderer.observers.meshDisposed.subscribe(InitDVEPBR, ({ _mesh }) => {
        if (!probe.renderList) return;
        shadows.removeShadowCaster(_mesh);
        probe.renderList = probe.renderList.filter((_) => _ == _mesh);
      });

      renderer.materials.materials.forEach((material, key) => {
        (material as DVEBRPBRMaterial)._material.disableLighting = false;
      });
 */
      initData.scene.ambientColor.set(0.32, 0.33, 0.38);

      const proceduralSkybox = InitSkybox({ renderer: _renderer });
      proceduralSkybox.renderingGroupId = 0;
      proceduralSkybox.infiniteDistance = true;
      proceduralSkybox.isPickable = false;

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
