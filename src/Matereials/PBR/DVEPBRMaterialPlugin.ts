import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { DVEBRPBRMaterial } from "./DVEBRPBRMaterial";
import { classifyTerrainMaterial } from "./MaterialFamilyProfiles";
import { isUnstablePBRSurfaceContextPreset } from "./ActiveTerrainPBRFlags";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";
import { getDepthTextureBinding } from "./DepthTextureBinding";
import { getSceneWaterHybridBridge } from "../../Water/DVEWaterHybridBridge.js";

export class DVEPBRMaterialPlugin extends MaterialPluginBase {
  uniformBuffer: UniformBuffer;
  private static frameTimes = new WeakMap<Scene, { frameId: number; time: number }>();

  id = crypto.randomUUID();

  private hasImportedMaterialMapsEnabled() {
    return !!this.dveMaterial?.hasImportedMaterialMaps?.();
  }

  private shouldUseImportedMaterialMaps() {
    return !!this.dveMaterial?.shouldUseImportedMaterialMaps?.();
  }

  constructor(
    material: PBRMaterial,
    name: string,
    public dveMaterial: DVEBRPBRMaterial,
    public onUBSet: (uniformBuffer: UniformBuffer) => void
  ) {
    //  shaders.set(material.id, dveMaterial.shader);
    //  textures.set(material.id, dveMaterial.texture);

    super(material, name, 20, {
      [`DVE_${name}`]: true,
    });

    this._enable(true);
  }

  hasTexture(texture: BaseTexture): boolean {
    for (const [, activeTexture] of this.dveMaterial.textures) {
      if (activeTexture === texture) {
        return true;
      }
    }
    return false;
  }
  getActiveTextures(activeTextures: BaseTexture[]) {
    for (const [, texture] of this.dveMaterial.textures) {
      activeTextures.push(texture);
    }
    return activeTextures;
  }

  prepareDefines(defines: any) {
    defines[`DVE_${this.name}`] = true;
    defines.UV1 = true;
    defines.NORMAL = true;
    // R11: Enable POM when material maps are active and pomEnabled runtime flag is set
    defines.DVE_POM_ENABLED =
      this.hasImportedMaterialMapsEnabled() &&
      !!((EngineSettings.settings.terrain as any)?.pomEnabled);
    // T2: track imported-map availability as a define so a define-change triggers
    // shader recompilation when normal/material textures finish loading after first compile.
    defines.DVE_IMPORTED_MAPS = this.shouldUseImportedMaterialMaps();
  }

  getClassName() {
    return "DVEPBRMaterialPlugin";
  }
  getSamplers(samplers: string[]) {
    samplers.push("dve_voxel", "dve_voxel_animation");
    if (this.hasImportedMaterialMapsEnabled()) {
      samplers.push("dve_voxel_normal", "dve_voxel_material");
    }
    samplers.push(
      "dve_depthTexture",
      "dve_water_hybrid_base",
      "dve_water_hybrid_dynamic",
      "dve_water_hybrid_flow"
    );
  }

  getAttributes(attributes: string[]) {
    attributes.push("textureIndex", "uv", "voxelData", "metadata", "worldContext");
  }

  getUniforms() {
    return {
      ubo: [
        { name: "dve_voxel_animation_size" },
        { name: "dve_time" },
        { name: "dve_cameraNearFar", size: 2 },
        { name: "dve_screenSize", size: 2 },
        { name: "dve_water_hybrid_clip", size: 4 },
      ],
    };
  }

  /*   getUniforms() {
    const shader = this.dveMaterial?.shader || shaders.get(this._material.id)!;
    const ubo: {
      name: string;
      size?: number;
      arraySize?: number;
      type: string;
    }[] = [];
    const ignoreUniforms = ["viewProjection", "world", "lightGradient"];
    for (const [key, [name, type, length]] of shader.getUniformDataList()) {
      if (ignoreUniforms.includes(key)) continue;
      if (type == "ignore") continue;
      let isArray = false;
      if (length) isArray = true;
      if (type == "float") {
        if (!isArray) ubo.push({ name, size: 1, type });
        if (isArray) ubo.push({ name, arraySize: length, size: 1, type });
        continue;
      }
      if (type == "vec2") {
        if (!isArray) ubo.push({ name, size: 2, type });
        if (isArray) ubo.push({ name, arraySize: length, size: 2, type });
        continue;
      }
      if (type == "vec3") {
        if (!isArray) ubo.push({ name, size: 3, type });
        if (isArray) ubo.push({ name, arraySize: length, size: 3, type });
        continue;
      }
      if (type == "vec4") {
        if (!isArray) ubo.push({ name, size: 4, type });
        if (isArray) ubo.push({ name, arraySize: length, size: 4, type });
        continue;
      }
      if (type == "mat3") {
        ubo.push({ name, size: 3 * 3, type });
        continue;
      }
      if (type == "mat4") {
        ubo.push({ name, size: 4 * 4, type });
        continue;
      }
    }
  
    const uniforms = shader.compileUniforms(
      (id) => !ignoreUniforms.includes(id)
    );
    return {
      ubo,
      vertex: uniforms.vertex,
      fragment: uniforms.fragment,
    };
  }
 */
  _textureBound = false;
  bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, engine: Engine) {
    this.bindResources(uniformBuffer, scene);
  }

  hardBindForSubMesh(
    uniformBuffer: UniformBuffer,
    scene: Scene,
    engine: Engine
  ) {
    this.bindResources(uniformBuffer, scene);
  }

  isReadyForSubMesh(): boolean {
    for (const [, texture] of this.dveMaterial.textures) {
      if (!texture || !texture.isReady()) {
        return false;
      }
    }
    return true;
  }

  private bindResources(uniformBuffer: UniformBuffer, scene?: Scene) {
    if (!this.uniformBuffer) {
      this.uniformBuffer = uniformBuffer;
      this.onUBSet(uniformBuffer);
    }
    const effect = this._material.getEffect();
    if (!effect) return;

    for (const [samplerId, texture] of this.dveMaterial.textures) {
      effect.setTexture(samplerId, texture);
    }
    for (const [uniformId, size] of this.dveMaterial.animationSizes) {
      effect.setInt(uniformId, size);
    }
    if (scene) {
      const frameId = scene.getFrameId();
      let frameTime = DVEPBRMaterialPlugin.frameTimes.get(scene);
      if (!frameTime || frameTime.frameId !== frameId) {
        frameTime = { frameId, time: performance.now() * 0.001 };
        DVEPBRMaterialPlugin.frameTimes.set(scene, frameTime);
      }
      effect.setFloat("dve_time", frameTime.time);
    } else {
      effect.setFloat("dve_time", performance.now() * 0.001);
    }

    const depthBinding = getDepthTextureBinding(this._material, scene);
    effect.setTexture("dve_depthTexture", depthBinding.depthTexture);
    effect.setFloat2("dve_cameraNearFar", depthBinding.near, depthBinding.far);
    effect.setFloat2("dve_screenSize", depthBinding.screenWidth, depthBinding.screenHeight);
    if (scene) {
      const waterHybridBridge = getSceneWaterHybridBridge(scene);
      const clip = waterHybridBridge.getClipState();
      effect.setTexture("dve_water_hybrid_base", waterHybridBridge.getBaseTexture());
      effect.setTexture("dve_water_hybrid_dynamic", waterHybridBridge.getDynamicTexture());
      effect.setTexture("dve_water_hybrid_flow", waterHybridBridge.getFlowTexture());
      effect.setFloat4(
        "dve_water_hybrid_clip",
        clip.originX,
        clip.originZ,
        clip.invWidth,
        clip.invHeight
      );
    }
  }

  //@ts-ignore
  getCustomCode(shaderType: any) {
    const terrain = EngineSettings.settings.terrain;
    const benchmarkPreset = String(terrain.benchmarkPreset);
    const materialClass = classifyTerrainMaterial(this.name);
    const isTransparent = materialClass.isTransparent;
    const isGlow = materialClass.isGlow;
    const isRock = materialClass.isRock;
    const isWood = materialClass.isWood;
    const isFlora = materialClass.isFlora;
    const isSoil = materialClass.isSoil;
    const isCultivated = materialClass.isCultivated;
    const isExotic = materialClass.isExotic;
    const materialWetnessPorosity = isFlora
      ? 0.72
      : isSoil || isCultivated
        ? 0.58
        : isWood
          ? 0.34
          : isRock
            ? 0.12
            : isExotic
              ? 0.26
              : 0.2;
    const disableUnstablePBRSurfaceContext = isUnstablePBRSurfaceContextPreset(benchmarkPreset);
    const enableVisualV2 = terrain.visualV2 && !disableUnstablePBRSurfaceContext;
    const enableMacroVariation = terrain.macroVariation && !isTransparent && !isGlow;
    const enableTriplanar =
      terrain.materialTriplanar && !isTransparent && !disableUnstablePBRSurfaceContext;
    const enableWetness = terrain.materialWetness && !isTransparent && !isGlow;
    const enableSurfaceOverlays =
      terrain.surfaceOverlays &&
      !disableUnstablePBRSurfaceContext &&
      !isTransparent &&
      !isGlow;
    const enableMicroVariation =
      terrain.microVariation && !isTransparent && !disableUnstablePBRSurfaceContext;
    const enableNearCameraHighDetail =
      terrain.nearCameraHighDetail &&
      !isTransparent &&
      !disableUnstablePBRSurfaceContext;
    const enableSurfaceMetadata =
      terrain.surfaceMetadata &&
      !isTransparent &&
      !isGlow &&
      !disableUnstablePBRSurfaceContext;
    const enableWorldContext =
      (enableSurfaceMetadata || enableWetness) &&
      !isTransparent &&
      !isGlow;
    const enableSurfaceHeightGradient =
      terrain.surfaceHeightGradient &&
      !isTransparent &&
      !isGlow &&
      !disableUnstablePBRSurfaceContext;
    const enablePBRPremium = (benchmarkPreset === "pbr-premium" || benchmarkPreset === "pbr-premium-v2") && !isTransparent;
    const enableImportedMaterialMaps =
      this.shouldUseImportedMaterialMaps() && !isTransparent;
    // R11: POM enabled when imported material maps are active and runtime flag is set
    const enablePOM =
      enableImportedMaterialMaps &&
      !!((terrain as any)?.pomEnabled);
    const baseLightFloor =
      benchmarkPreset === "material-import"
        ? 0.72
        : benchmarkPreset === "optimum-inspired"
          ? 0.62
          : benchmarkPreset === "universalis-inspired"
            ? 0.58
            : benchmarkPreset === "pbr-premium"
              ? 0.54
              : benchmarkPreset === "pbr-premium-v2"
                ? 0.52
                : benchmarkPreset === "pbr-surface-lod"
                  ? 0.56
                  : 0.48;
    const voxelLightMix =
      benchmarkPreset === "material-import"
        ? 0.18
        : benchmarkPreset === "optimum-inspired"
          ? 0.28
          : benchmarkPreset === "universalis-inspired"
            ? 0.32
            : benchmarkPreset === "pbr-premium"
              ? 0.34
              : benchmarkPreset === "pbr-premium-v2"
                ? 0.33
                : benchmarkPreset === "pbr-surface-lod"
                  ? 0.32
                  : 1;
    const textures = /* glsl */ `
uniform sampler2DArray dve_voxel;
uniform highp usampler2D dve_voxel_animation;
uniform highp int dve_voxel_animation_size;
uniform sampler2D dve_depthTexture;
uniform vec2 dve_cameraNearFar;
uniform vec2 dve_screenSize;
uniform sampler2D dve_water_hybrid_base;
uniform sampler2D dve_water_hybrid_dynamic;
uniform sampler2D dve_water_hybrid_flow;
uniform vec4 dve_water_hybrid_clip;
  ${enableImportedMaterialMaps ? "uniform sampler2DArray dve_voxel_normal;\nuniform sampler2DArray dve_voxel_material;" : ""}
`;
    const varying = /* glsl */ `
varying vec2 dveBaseUV;
varying float dveTextureLayer;
  varying vec4 dveOverlayTextureIndex;
varying vec2 dveIUV;
varying vec3 dveLight1;
varying vec3 dveLight2;
varying vec3 dveLight3;
varying vec3 dveLight4;
  ${enableSurfaceMetadata ? "varying vec4 dveMetadata;" : ""}
  ${enableWorldContext ? "varying vec3 dveWorldContext;" : ""}
`;

    const attributes = /* glsl */ `
attribute vec3 textureIndex;
attribute vec4 voxelData;
  ${enableSurfaceMetadata ? "attribute vec4 metadata;" : ""}
  ${enableWorldContext ? "attribute vec3 worldContext;" : ""}
`;
    const coreFunctions = /* glsl */ `
const uint dveLightMask = uint(0xf);
const uint dveSunLightIndex = 0u;
const uint dveRedLightIndex = 4u;
const uint dveGreenLightIndex = 8u;
const uint dveBlueLightIndex = 12u;
const uint dveTextureIndexMask = uint(0xffff);
const uint dveSecondaryTextureIndex = uint(0x10);
const uint dveVertexIndex = 16u;
const uint dveVertexMask = uint(0x3);
const vec2 dveQuadUVArray[4] = vec2[4](vec2(1.,1.),vec2(0.,1.),vec2(0.,0.),vec2(1.,0.));

float dveGetTextureIndex(int index) {
  uint tInt = texelFetch(
    dve_voxel_animation,
    ivec2(index % dve_voxel_animation_size, index / dve_voxel_animation_size),
    0
  ).r;
  if (tInt == 0u) return float(index);
  return float(tInt);
}

vec3 dveDecodeLightValue(uint value) {
  vec3 rgbLight = vec3(
    lightGradient[(value >> dveRedLightIndex) & dveLightMask],
    lightGradient[(value >> dveGreenLightIndex) & dveLightMask],
    lightGradient[(value >> dveBlueLightIndex) & dveLightMask]
  );
  float sunLight = lightGradient[(value >> dveSunLightIndex) & dveLightMask];
  return max(rgbLight + vec3(sunLight), vec3(${baseLightFloor.toFixed(2)}));
}

vec3 dveGetVoxelLight() {
  vec3 dveTop = mix(dveLight2, dveLight1, dveIUV.x);
  vec3 dveBottom = mix(dveLight3, dveLight4, dveIUV.x);
  return mix(dveBottom, dveTop, dveIUV.y);
}
`;
    const functions = /* glsl */ `
${coreFunctions}

float dveHash13(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float dveNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  // Quintic Hermite (C² continuous) — reduces grid-boundary visibility vs cubic smoothstep.
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

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

vec3 dveRotXZ(vec3 p, float a) {
  float c = cos(a); float s = sin(a);
  return vec3(p.x*c - p.z*s, p.y, p.x*s + p.z*c);
}

vec3 dveBlendWeights(vec3 normalDir) {
  // T1: N=2.5 widens the blend band to ~35° (was 6.0 → ~10°), smoothing triplanar seams
  vec3 weights = pow(abs(normalDir), vec3(2.5));
  return weights / max(dot(weights, vec3(1.0)), 0.0001);
}

vec4 dveProjectedColor(vec2 uv) {
  return texture(dve_voxel, vec3(fract(uv), dveTextureLayer));
}

${
  enableImportedMaterialMaps
    ? /* glsl */ `
vec4 dveSampleMaterialMap(vec2 uv) {
  return texture(dve_voxel_material, vec3(uv, dveTextureLayer));
}

vec3 dveSampleDetailNormal(vec2 uv) {
  return texture(dve_voxel_normal, vec3(uv, dveTextureLayer)).xyz * 2.0 - 1.0;
}
`
    : ""
}

float dveComputeWetness(vec3 normalDir, vec3 worldPos) {
  float upward = clamp(normalDir.y * 0.5 + 0.5, 0.0, 1.0);
  float drainage = 1.0 - clamp(abs(normalDir.y), 0.0, 1.0);
  float macro = dveFbm3(worldPos * 0.045 + vec3(13.1, 0.0, -7.3));
  return clamp(upward * 0.55 + macro * 0.35 - drainage * 0.15, 0.0, 1.0);
}

float dveEdgeMask(vec2 faceUV) {
  vec2 centered = abs(faceUV - 0.5) * 2.0;
  float edge = max(centered.x, centered.y);
  return smoothstep(0.62, 0.96, edge);
}

float dveTopExposureMask(vec3 normalDir, vec3 worldPos) {
  float upward = smoothstep(0.18, 0.88, normalDir.y);
  float breakup = dveFbm3(worldPos * 0.03 + vec3(-4.7, 9.2, 2.1));
  return clamp(upward * 0.7 + breakup * 0.35, 0.0, 1.0);
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

vec2 dveGetWaterHybridUV(vec3 worldPos) {
  return fract((worldPos.xz - dve_water_hybrid_clip.xy) * dve_water_hybrid_clip.zw);
}

vec4 dveGetTerrainHydrologyFields(
  vec3 worldPos,
  vec3 normalDir,
  float baseHydrology,
  float materialPorosity
) {
  vec2 hybridUV = dveGetWaterHybridUV(worldPos);
  vec2 texel = dve_water_hybrid_clip.zw;
  vec4 hybridBase = texture(dve_water_hybrid_base, hybridUV);
  vec4 hybridDynamic = texture(dve_water_hybrid_dynamic, hybridUV);
  vec4 hybridFlow = texture(dve_water_hybrid_flow, hybridUV);
  float neighborFill = 0.0;
  neighborFill = max(neighborFill, texture(dve_water_hybrid_base, fract(hybridUV + vec2(texel.x, 0.0))).a);
  neighborFill = max(neighborFill, texture(dve_water_hybrid_base, fract(hybridUV - vec2(texel.x, 0.0))).a);
  neighborFill = max(neighborFill, texture(dve_water_hybrid_base, fract(hybridUV + vec2(0.0, texel.y))).a);
  neighborFill = max(neighborFill, texture(dve_water_hybrid_base, fract(hybridUV - vec2(0.0, texel.y))).a);

  float explicitWetness = clamp(
    max(baseHydrology * 0.38, hybridBase.a * 0.86 + neighborFill * 0.34 + hybridFlow.a * 0.16),
    0.0,
    1.0
  );
  float freshWetness = clamp(
    max(hybridFlow.a * 0.84 + hybridDynamic.b * 0.34, hybridDynamic.r * 0.72 + hybridDynamic.g * 0.18),
    0.0,
    1.0
  );
  float contactPersistence = clamp(
    (1.0 - abs(normalDir.y)) * 0.72 + neighborFill * 0.38 + hybridFlow.a * 0.28 + hybridDynamic.r * 0.22,
    0.0,
    1.0
  );
  float dryingPersistence = clamp(
    explicitWetness * (0.26 + materialPorosity * 0.36) +
      hybridBase.b * (0.10 + materialPorosity * 0.12) +
      contactPersistence * 0.18 -
      freshWetness * 0.14,
    0.0,
    1.0
  );

  return vec4(explicitWetness, freshWetness, dryingPersistence, contactPersistence);
}
`;
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: /*glsl*/ `
#ifdef  DVE_${this.name}
const float lightGradient[16] = float[16]( 0.06, 0.1, 0.11, 0.14, 0.17, 0.21, 0.26, 0.31, 0.38, 0.45, 0.54, 0.64, 0.74, 0.85, 0.97, 1.);
uniform highp usampler2D dve_voxel_animation;
uniform highp int dve_voxel_animation_size;
uniform float dve_time;
${attributes}
${varying}

const uint dveLightMask = uint(0xf);
const uint dveSunLightIndex = 0u;
const uint dveRedLightIndex = 4u;
const uint dveGreenLightIndex = 8u;
const uint dveBlueLightIndex = 12u;
const uint dveTextureIndexMask = uint(0xffff);
const uint dveSecondaryTextureIndex = uint(0x10);
const uint dveVertexIndex = 16u;
const uint dveVertexMask = uint(0x3);
const vec2 dveQuadUVArray[4] = vec2[4](vec2(1.,1.),vec2(0.,1.),vec2(0.,0.),vec2(1.,0.));

float dveGetTextureIndex(int index) {
  uint tInt = texelFetch(
    dve_voxel_animation,
    ivec2(index % dve_voxel_animation_size, index / dve_voxel_animation_size),
    0
  ).r;
  if (tInt == 0u) return float(index);
  return float(tInt);
}

vec3 dveDecodeLightValue(uint value) {
  vec3 rgbLight = vec3(
    lightGradient[(value >> dveRedLightIndex) & dveLightMask],
    lightGradient[(value >> dveGreenLightIndex) & dveLightMask],
    lightGradient[(value >> dveBlueLightIndex) & dveLightMask]
  );
  float sunLight = lightGradient[(value >> dveSunLightIndex) & dveLightMask];
  return max(rgbLight + vec3(sunLight), vec3(${baseLightFloor.toFixed(2)}));
}

#endif
`,
        CUSTOM_VERTEX_UPDATE_NORMAL: /*glsl*/ `
#ifdef  DVE_${this.name}
#endif

`,

        CUSTOM_VERTEX_MAIN_BEGIN: /*glsl*/ `
#ifdef  DVE_${this.name}
      dveBaseUV = uv;
  dveTextureLayer = dveGetTextureIndex(int(uint(textureIndex.x) & dveTextureIndexMask));
  dveOverlayTextureIndex.x = dveGetTextureIndex(int((uint(textureIndex.x) >> dveSecondaryTextureIndex) & dveTextureIndexMask));
  dveOverlayTextureIndex.y = dveGetTextureIndex(int(uint(textureIndex.y) & dveTextureIndexMask));
  dveOverlayTextureIndex.z = dveGetTextureIndex(int((uint(textureIndex.y) >> dveSecondaryTextureIndex) & dveTextureIndexMask));
  dveOverlayTextureIndex.w = dveGetTextureIndex(int(uint(textureIndex.z) & dveTextureIndexMask));
  dveLight1 = dveDecodeLightValue(uint(voxelData.x));
  dveLight2 = dveDecodeLightValue(uint(voxelData.y));
  dveLight3 = dveDecodeLightValue(uint(voxelData.z));
  dveLight4 = dveDecodeLightValue(uint(voxelData.w));
  dveIUV = dveQuadUVArray[(uint(voxelData.z) >> dveVertexIndex) & dveVertexMask];
  ${enableSurfaceMetadata ? "dveMetadata = metadata;" : ""}
  ${enableWorldContext ? "dveWorldContext = worldContext;" : ""}

#endif
        `,
      };
    }
    if (shaderType === "fragment") {
      const albedoEnhancement = /* glsl */ `
vec3 dveNormalW = normalize(vNormalW);
float dveSlope = 1.0 - abs(dveNormalW.y);
      float dveCameraDistance = length(vPositionW - vEyePosition.xyz);
      float dveCloseBoost = dveDistanceBoost(dveCameraDistance);
      float dveNearField = dveNearFieldMask(dveCameraDistance, 10.0, 56.0);
      float dveCenterBlend = dveCenterMask(fract(dveBaseUV));
  float dveEdgeWear = dveEdgeMask(fract(dveBaseUV));
      float dveTopExposure = dveTopExposureMask(dveNormalW, vPositionW);
      float dveSurfaceExposure = dveTopExposure;
      float dveSurfaceSlope = dveSlope;
      float dveSurfaceCavity = 0.0;
      float dveSurfaceTop = smoothstep(0.45, 0.8, dveNormalW.y);
      float dveBakedHeight = 0.0;
  ${enableSurfaceMetadata ? "vec4 dveMetadataClamped = clamp(dveMetadata, 0.0, 1.0); float dveMetadataWeight = smoothstep(0.04, 0.28, dot(dveMetadataClamped, vec4(0.25))); dveSurfaceExposure = mix(dveSurfaceExposure, dveMetadataClamped.x, dveMetadataWeight * 0.72); dveSurfaceSlope = mix(dveSurfaceSlope, dveMetadataClamped.y, dveMetadataWeight * 0.72); dveSurfaceCavity = mix(dveSurfaceCavity, dveMetadataClamped.z, dveMetadataWeight * 0.72); dveSurfaceTop = mix(dveSurfaceTop, smoothstep(0.4, 0.85, dveMetadataClamped.x), dveMetadataWeight * 0.72); dveBakedHeight = dveMetadataClamped.w; dveTopExposure = mix(dveTopExposure, max(dveTopExposure, dveSurfaceExposure), dveMetadataWeight * 0.55);" : ""}
      float dveSunExposure = ${enableWorldContext ? "clamp(dveWorldContext.x, 0.0, 1.0)" : "1.0"};
      float dveEnclosure = ${enableWorldContext ? "clamp(dveWorldContext.y, 0.0, 1.0)" : "0.0"};
      float dveEdgeBoundary = ${enableSurfaceMetadata ? "clamp((1.0 - dveEdgeWear * 0.72) * (0.76 + dveSurfaceExposure * 0.16 + dveSurfaceTop * 0.08) + dveSurfaceCavity * 0.08, 0.0, 1.0)" : "1.0"};
      float dveHeightNorm = ${enableSurfaceMetadata ? "dveBakedHeight" : enableSurfaceHeightGradient ? "clamp((vPositionW.y - 16.0) / 112.0, 0.0, 1.0)" : "0.0"};
      float dveBaseCavity = clamp(max(dveSurfaceCavity * 0.82, dveEdgeMask(fract(dveBaseUV * 0.85 + vec2(vPositionW.y * 0.03))) * 0.18), 0.0, 1.0);
      float dveMaterialPorosity = ${materialWetnessPorosity.toFixed(2)};
      float dveLegacyHydrologyWetness = ${enableWorldContext ? "clamp(dveWorldContext.z, 0.0, 1.0)" : "0.0"};
      vec4 dveHydrologyFields = dveGetTerrainHydrologyFields(vPositionW, dveNormalW, dveLegacyHydrologyWetness, dveMaterialPorosity);
      float dveHydrologyWetness = dveHydrologyFields.x;
      float dveHydrologyFresh = dveHydrologyFields.y;
      float dveHydrologyDrying = dveHydrologyFields.z;
      float dveHydrologyContact = dveHydrologyFields.w;
      float dveWetnessBase = clamp(dveComputeWetness(dveNormalW, vPositionW) * 0.56 + dveSurfaceCavity * 0.14 + (1.0 - dveSurfaceExposure) * 0.06 + (1.0 - dveHeightNorm) * 0.14 - dveHeightNorm * 0.08 + (1.0 - dveSunExposure) * 0.1 + dveEnclosure * 0.08 + dveHydrologyWetness * (0.24 + dveMaterialPorosity * 0.24) + dveHydrologyContact * (0.12 + dveMaterialPorosity * 0.08), 0.0, 1.0);
      float dveWetnessRetention = clamp(0.26 + dveMaterialPorosity * 0.58 + dveBaseCavity * 0.12 + dveEnclosure * 0.08 - dveSunExposure * 0.1 + dveHydrologyDrying * (0.18 + dveMaterialPorosity * 0.14) + dveHydrologyContact * 0.08, 0.0, 1.0);
      float dveFreshWetness = max(max(smoothstep(0.24, 0.78, dveWetnessBase), smoothstep(0.08, 0.52, dveHydrologyWetness) * (0.72 + dveMaterialPorosity * 0.18)), smoothstep(0.08, 0.58, dveHydrologyFresh) * (0.68 + dveMaterialPorosity * 0.22));
      float dveDryingWetness = clamp(dveWetnessBase * (0.42 + dveWetnessRetention * 0.42) * (1.0 - dveFreshWetness * 0.55) + dveHydrologyWetness * (0.12 + dveWetnessRetention * 0.22) * (1.0 - dveFreshWetness * 0.45) + dveHydrologyDrying * (0.18 + dveWetnessRetention * 0.14), 0.0, 1.0);
      float dveWetFilm = clamp(dveFreshWetness * (0.58 + dveMaterialPorosity * 0.18 + dveEnclosure * 0.08) + dveDryingWetness + dveHydrologyWetness * (0.08 + dveMaterialPorosity * 0.16) + dveHydrologyContact * (0.10 + dveMaterialPorosity * 0.10), 0.0, 1.0);
    `;
      const visualV2Code = enableVisualV2
        ? /* glsl */ `
  voxelBaseColor.rgb = pow(max(voxelBaseColor.rgb, vec3(0.0)), vec3(0.9));
float dveVisualCavity = clamp(dveBaseCavity * (0.42 + dveSurfaceSlope * 0.18), 0.0, 1.0);
voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.1, 1.08, 1.04), dveTopExposure * 0.16);
voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.88, 0.86, 0.84), dveVisualCavity * 0.08);
voxelBaseColor.rgb += vec3(0.035, 0.03, 0.024) * dveEdgeWear * (0.08 + dveCloseBoost * 0.06) * (0.7 + dveEdgeBoundary * 0.3);
voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.06, 1.04, 0.98), dveSunExposure * dveEdgeBoundary * 0.06);
voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.92, 0.94, 0.96), dveEnclosure * (1.0 - dveSunExposure) * 0.05);
// Idea 3 — vSubdivAO depth cue: shines exposed crests slightly and deepens occluded
// crevices, reinforcing the 3D silhouette without an explicit AO pass.
#if defined(DVE_DISSOLUTION) || defined(DVE_SUBDIV_AO)
voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.09, 1.07, 1.03), vSubdivAO * dveCloseBoost * 0.11);
voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.75, 0.73, 0.71), (1.0 - vSubdivAO) * dveNearField * 0.12);
#endif
`
        : "";
      const macroVariationCode = enableMacroVariation
        ? /* glsl */ `
float dveMacro = clamp(dveFbm3(dveRotXZ(vPositionW, 0.41) * 0.035) * 1.1, 0.0, 1.0);
float dveMacroPatch = dveFbm3(dveRotXZ(vPositionW, 0.83) * 0.012 + vec3(-9.7, 5.2, 11.1));
float dveMacroTintMask = clamp(dveMacro * 0.6 + dveMacroPatch * 0.32 + dveSurfaceExposure * 0.08 - dveBaseCavity * 0.06, 0.0, 1.0);
vec3 dveMacroTint = mix(vec3(0.80, 0.75, 0.70), vec3(1.14, 1.08, 1.00), dveMacroTintMask);
voxelBaseColor.rgb *= dveMacroTint;
// Per-block brightness variation: breaks uniform same-type blocks.
// Use floor(vPositionW) instead of floor(dveBaseUV) to avoid per-triangle
// interpolation mismatch that creates diagonal seams at quad boundaries.
vec3 dveBlockSeed = floor(vPositionW) + vec3(dveTextureLayer * 0.03125 + 17.3);
float dveBlockVar = (dveHash13(dveBlockSeed) * 2.0 - 1.0) * 0.08;    // ±8% brightness
float dveBlockHue = (dveHash13(dveBlockSeed + vec3(5.1, 3.7, 2.9)) - 0.5) * 0.04;  // ±4% hue twist
voxelBaseColor.rgb *= (1.0 + dveBlockVar);
voxelBaseColor.r   += dveBlockHue;
voxelBaseColor.b   -= dveBlockHue * 0.5;
`
        : "";
      const triplanarCode = enableTriplanar
        ? /* glsl */ `
vec3 dveBlend = dveBlendWeights(dveNormalW);
vec3 dveWorldUV = vPositionW * 0.12;
// Anti-mirror offsets (Golus): prevent XY/XZ planes from producing perfectly
// mirrored UV at shared corners, which creates visible seam artefacts.
vec2 dveUVX = dveWorldUV.yz;
vec2 dveUVY = dveWorldUV.xz + vec2(0.33);
vec2 dveUVZ = dveWorldUV.xy + vec2(0.67);
vec4 dveXColor = dveProjectedColor(dveUVX);
vec4 dveYColor = dveProjectedColor(dveUVY);
vec4 dveZColor = dveProjectedColor(dveUVZ);
vec4 dveTriplanarColor = dveXColor * dveBlend.x + dveYColor * dveBlend.y + dveZColor * dveBlend.z;
float dveTriplanarMix = smoothstep(0.18, 0.82, max(dveSlope, dveSurfaceSlope)) * 0.65;
voxelBaseColor = mix(voxelBaseColor, dveTriplanarColor, dveTriplanarMix);
`
        : "";
      const wetnessAlbedoCode = enableWetness
        ? /* glsl */ `
voxelBaseColor.rgb = mix(
  voxelBaseColor.rgb,
  voxelBaseColor.rgb * vec3(0.72, 0.76, 0.82),
  dveWetFilm * mix(0.16, 0.34, dveMaterialPorosity)
);
voxelBaseColor.rgb = mix(
  voxelBaseColor.rgb,
  voxelBaseColor.rgb * vec3(0.84, 0.86, 0.9),
  dveDryingWetness * mix(0.08, 0.18, dveWetnessRetention)
);
`
        : "";
      const microVariationCode = enableMicroVariation
        ? /* glsl */ `
float dveMicro = dveFbm3(dveRotXZ(vPositionW, 0.19) * 0.42 + dveNormalW * 1.8);
// Edge seam: weight by slope so flat terrain shows minimal grid; only steep/curved
// surfaces get the full block-boundary darkening (reduces "mattress" effect).
float dveSlopeEdgeGate = smoothstep(0.15, 0.55, max(dveSlope, dveSurfaceSlope));
float dveMicroEdge = dveEdgeMask(fract(dveBaseUV)) * (0.08 + dveSlopeEdgeGate * 0.14);
// Idea 3 — vSubdivAO amplitude modulation: exposed bump crests get stronger micro
// contrast, dark occluded crevices stay muted — makes the 3D form read clearly.
#if defined(DVE_DISSOLUTION) || defined(DVE_SUBDIV_AO)
float dveMicroAO = 0.65 + smoothstep(0.1, 0.9, vSubdivAO) * 0.70;
#else
float dveMicroAO = 1.0;
#endif
voxelBaseColor.rgb = mix(
  voxelBaseColor.rgb,
  voxelBaseColor.rgb * mix(vec3(0.86, 0.84, 0.82), vec3(1.14, 1.10, 1.05), dveMicro),
  dveNearField * 0.16 * dveMicroAO
);
voxelBaseColor.rgb = mix(
  voxelBaseColor.rgb,
  voxelBaseColor.rgb * vec3(1.05, 1.04, 1.01),
  dveCenterBlend * dveNearField * 0.10
);
voxelBaseColor.rgb = mix(
  voxelBaseColor.rgb,
  voxelBaseColor.rgb * vec3(0.82, 0.80, 0.78),
  dveMicroEdge * dveNearField * 0.09
);
voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.87, 0.85, 0.83), dveBaseCavity * dveNearField * 0.08);
`
        : "";
      const surfaceOverlaysCode = enableSurfaceOverlays
        ? /* glsl */ `
float dveOverlayNoise = dveFbm3(dveRotXZ(vPositionW, 0.62) * 0.11 + vec3(4.3, -1.7, 8.1));
float dveOverlayDistance = mix(0.62, 1.0, dveCloseBoost);
float dveOverlayExposure = clamp(dveSurfaceExposure * 0.84 + dveTopExposure * 0.16, 0.0, 1.0);
float dveSideFaceMask = clamp(1.0 - dveSurfaceTop, 0.0, 1.0);
float dveSideEdgeMask = dveEdgeMask(fract(dveBaseUV * 0.72)) * dveSideFaceMask;
float dveShelterMask = clamp(dveBaseCavity * 0.46 + dveCenterBlend * 0.1 + (1.0 - dveOverlayExposure) * 0.16 + (1.0 - dveSurfaceSlope) * 0.06 + dveEnclosure * 0.14, 0.0, 1.0);
float dveLowlandBias = 1.0 - smoothstep(0.15, 0.45, dveHeightNorm);
float dveHighlandBias = smoothstep(0.55, 0.85, dveHeightNorm);
float dveMidlandBias = clamp(1.0 - abs(dveHeightNorm - 0.42) * 2.4, 0.0, 1.0);
float dveHorizontalSeed = dveHash13(vec3(floor(dveBaseUV.x * 4.0) + dveTextureLayer * 0.03125, 100.0, floor(dveBaseUV.y * 4.0) + dveSurfaceTop));
vec3 dveNormalAbs = abs(dveNormalW);
float dveAxisSwitch = step(dveNormalAbs.x, dveNormalAbs.z);
vec3 dveAxisSeed = mix(vec3(dveNormalW.x * 10.0, 5.0, 0.1), vec3(0.1, 5.0, dveNormalW.z * 10.0), dveAxisSwitch);
float dveDirectionalSeed = dveHash13(vec3(floor(dveBaseUV.x * 4.0) + dveTextureLayer * 0.03125 + dveAxisSeed.x * 0.01, dveSurfaceSlope, floor(dveBaseUV.y * 4.0) + dveAxisSeed.z * 0.01));
float dveConnectedPatch = mix(
  smoothstep(0.34, 0.82, dveHorizontalSeed + dveShelterMask * 0.18),
  smoothstep(0.28, 0.76, dveDirectionalSeed + dveShelterMask * 0.14 - dveSideEdgeMask * 0.12),
  dveSideFaceMask
);
vec2 dveUVDist = min(fract(dveBaseUV), 1.0 - fract(dveBaseUV));
float dveEdgeProximity = 1.0 - smoothstep(0.04, 0.16, min(dveUVDist.x, dveUVDist.y));
float dveSlopeBand = smoothstep(0.22, 0.68, dveSurfaceSlope) * (1.0 - smoothstep(0.72, 0.98, dveSurfaceSlope));
float dveSlopeCurve = mix(smoothstep(-0.18, 0.42, dveSurfaceSlope), 1.0 - smoothstep(0.58, 1.08, dveSurfaceSlope), dveSlopeBand);
float dveUndercutExposure = smoothstep(0.74, 0.98, dveSurfaceSlope) * (1.0 - clamp(dveSurfaceCavity * 1.8, 0.0, 1.0));
float dveGrassSideMask = clamp(dveSideFaceMask * (0.58 + dveBaseCavity * 0.16) + dveCenterBlend * 0.06 + dveOverlayNoise * 0.08, 0.0, 1.0) * mix(0.7, 1.0, dveCloseBoost) * (0.92 + dveEdgeProximity * 0.12);
float dveGrassRimMask = clamp(dveSideEdgeMask * (0.62 + dveCenterBlend * 0.14) + dveOverlayNoise * 0.08, 0.0, 1.0) * mix(0.76, 1.0, dveCloseBoost) * (0.92 + dveEdgeProximity * 0.12) * (1.0 - dveUndercutExposure * 0.2);
float dveConnectedEdgeBlend = clamp(dveGrassRimMask * 0.72 + dveSideFaceMask * 0.18 + dveCenterBlend * 0.08, 0.0, 1.0) * clamp(0.5 + dveSlopeCurve * 0.5, 0.0, 1.0);
float dveFloraConnectedMask = clamp(dveSideFaceMask * (0.42 + (1.0 - dveOverlayExposure) * 0.24) + dveConnectedPatch * 0.18 + dveSideEdgeMask * 0.12, 0.0, 1.0) * mix(0.74, 1.0, dveCloseBoost) * (0.94 + dveEdgeProximity * 0.1);
float dveSoilConnectedMask = clamp(dveConnectedPatch * 0.34 + dveSideFaceMask * 0.28 + dveShelterMask * 0.18 + (1.0 - dveSurfaceSlope) * 0.08, 0.0, 1.0) * mix(0.72, 1.0, dveCloseBoost) * (0.94 + dveEdgeProximity * 0.08);
float dveEdgeDirBias = mix(0.94 + (fract(dveBaseUV.x) - 0.5) * 0.12, 0.94 + (fract(dveBaseUV.y) - 0.5) * 0.12, dveAxisSwitch);
float dveHydrologyDeposition = clamp(dveHydrologyWetness * (0.44 + dveLowlandBias * 0.18 + dveShelterMask * 0.12) + dveFreshWetness * 0.08 - dveSurfaceSlope * 0.12, 0.0, 1.0);
float dveDepositionMask = clamp(dveSurfaceTop * (1.0 - dveSurfaceSlope) * 0.56 + dveBaseCavity * 0.08 + dveOverlayNoise * 0.12 + dveCenterBlend * 0.06 + dveHydrologyDeposition * 0.34, 0.0, 1.0) * dveOverlayDistance;
float dveMossMask = clamp(dveWetnessBase * 0.42 + dveBaseCavity * 0.24 + (1.0 - dveSurfaceSlope) * 0.06 + dveCenterBlend * 0.04 - dveOverlayExposure * 0.08 + dveMidlandBias * 0.1 + dveEnclosure * 0.1 + (1.0 - dveSunExposure) * 0.08, 0.0, 1.0) * mix(0.72, 1.0, dveCloseBoost);
float dveDustMask = clamp(dveOverlayExposure * 0.24 + dveBaseCavity * 0.1 + (1.0 - dveWetFilm) * 0.2 + dveOverlayNoise * 0.08 + dveHighlandBias * 0.12 + dveSunExposure * 0.1 - dveEnclosure * 0.14, 0.0, 1.0) * mix(0.68, 1.0, dveCloseBoost);
float dveSandDriftMask = clamp(dveDepositionMask * (0.48 + dveOverlayExposure * 0.22 + (1.0 - dveWetFilm) * 0.26) + dveSideEdgeMask * 0.08 + dveShelterMask * 0.12 + dveLowlandBias * 0.16 - dveMossMask * 0.22 - dveEnclosure * 0.12, 0.0, 1.0) * mix(0.72, 1.0, dveCloseBoost);
float dveSandPocketMask = clamp(dveDepositionMask * (0.34 + dveShelterMask * 0.28) + dveBaseCavity * 0.16 + (1.0 - dveWetFilm) * 0.12 + dveLowlandBias * 0.12 - dveSurfaceSlope * 0.06, 0.0, 1.0) * mix(0.7, 1.0, dveCloseBoost);
float dveMossDominanceZone = clamp(dveMossMask * (1.4 - dveSurfaceTop * 0.35) - dveSandDriftMask * 0.18 - dveOverlayExposure * 0.12, 0.0, 1.0);
float dveDryInteraction = (1.0 - dveWetFilm) * clamp(dveOverlayExposure * 0.6 + dveTopExposure * 0.4, 0.0, 1.0);
float dveGrainSettlingMask = clamp(dveDepositionMask * (0.34 + dveShelterMask * 0.32 + dveBaseCavity * 0.18) + dveOverlayNoise * 0.08 - dveSurfaceSlope * 0.12, 0.0, 1.0) * mix(0.7, 1.0, dveCloseBoost);
float dveRockMossMask = clamp(dveMossMask * (0.72 + dveBaseCavity * 0.18) + dveSideFaceMask * (0.08 + (1.0 - dveOverlayExposure) * 0.08) + dveShelterMask * 0.12 - dveDustMask * 0.18, 0.0, 1.0) * mix(0.74, 1.0, dveCloseBoost);
float dveRockMossCreepMask = clamp(dveRockMossMask * (0.42 + dveSideFaceMask * 0.42) + dveSideEdgeMask * 0.08 + dveOverlayNoise * 0.05 - dveSandDriftMask * 0.16, 0.0, 1.0);
float dveMossVerticalCreepMask = clamp(dveRockMossMask * (1.2 - abs(dveNormalW.y) * 0.8) + dveShelterMask * (0.16 + (1.0 - dveOverlayExposure) * 0.24) + dveBaseCavity * 0.14 + (1.0 - dveSurfaceSlope) * 0.08 - dveOverlayExposure * 0.14, 0.0, 1.0) * mix(0.76, 1.0, dveCloseBoost);

${
  isRock
    ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.7, 0.9, 0.68), dveRockMossMask * (1.0 - dveDryInteraction * 0.28) * 0.22); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.62, 0.8, 0.62), dveMossVerticalCreepMask * 0.14); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.08, 1.04, 0.94), dveSandDriftMask * (1.0 + dveDryInteraction * 0.18) * 0.14); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.12, 1.08, 0.96), dveGrainSettlingMask * 0.12); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.1, 1.06, 0.92), dveHydrologyDeposition * 0.14);"
    : ""
}
${
  isSoil || isCultivated
    ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.08, 1.01, 0.92), dveSandDriftMask * 0.16); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.12, 1.04, 0.96), dveSandPocketMask * 0.08); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.14, 1.06, 0.9), dveHydrologyDeposition * 0.18); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.78, 0.9, 0.7), dveGrassSideMask * 0.12); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.82, 0.99, 0.75), dveGrassRimMask * 0.18); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.76, 0.9, 0.72) * dveEdgeDirBias, dveConnectedEdgeBlend * dveSoilConnectedMask * 0.1); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.92, 0.88, 0.8), (1.0 - dveConnectedPatch) * dveSoilConnectedMask * 0.08); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.71, 0.87, 0.64), dveMossMask * 0.14); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.68, 0.91, 0.62), dveMossDominanceZone * 0.08);"
    : ""
}
${
  isFlora
    ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.74, 0.9, 0.7), dveGrassSideMask * 0.18); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.82, 0.99, 0.75), dveGrassRimMask * 0.18); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.82, 0.9, 0.72) * dveEdgeDirBias, dveFloraConnectedMask * 0.14); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.9, 1.02, 0.82), dveConnectedEdgeBlend * dveFloraConnectedMask * 0.08); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.04, 1.08, 0.96), dveSandDriftMask * 0.07); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.08, 1.05, 0.92), dveHydrologyDeposition * 0.08);"
    : ""
}
${
  isWood
    ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.76, 0.88, 0.74), dveRockMossMask * 0.1); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.04, 1.0, 0.9), dveDustMask * 0.08);"
    : ""
}
${
  isExotic
    ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.02, 0.94, 1.12), dveDepositionMask * 0.12);"
    : ""
}
`
        : "";
      const nearCameraHighDetailCode = enableNearCameraHighDetail
        ? /* glsl */ `
      float dveNearCenter = dveCenterBlend;
      voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.04, 1.03, 1.01), dveNearCenter * dveNearField * 0.12);
      voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.8, 0.78, 0.76), dveEdgeMask(fract(dveBaseUV * 1.4 + vec2(vPositionW.y * 0.04))) * dveNearField * 0.06);
      voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.88, 0.86, 0.84), dveBaseCavity * dveNearField * 0.06);
`
        : "";
      const premiumAlbedoCode = enablePBRPremium
        ? /* glsl */ `
float dvePremiumSlope = 1.0 - abs(dveNormalW.y);
float dvePremiumMacro = dveFbm3(dveRotXZ(vPositionW, 1.05) * 0.082 + vec3(4.1, -1.2, 2.7));
vec3 _bndP = dveRotXZ(vPositionW, 0.41); float dvePremiumBands = dveFbm3(vec3(_bndP.x * 0.06, vPositionW.y * 0.18, _bndP.z * 0.06));
float dvePremiumEdge = dveEdgeMask(fract(vPositionW.xz * 0.22 + vPositionW.y * 0.04));
voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.82, 0.8, 0.78), dvePremiumSlope * (0.08 + dvePremiumMacro * 0.06));
voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.08, 1.05, 1.02), dvePremiumBands * (0.04 + dvePremiumEdge * 0.05));
${
  isRock
    ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.88, 0.92, 1.0), dvePremiumBands * 0.18); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.08, 1.06, 1.02), dvePremiumEdge * 0.12);"
    : isWood
      ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.08, 0.96, 0.84), dvePremiumBands * 0.16); voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.78, 0.68, 0.58), dvePremiumSlope * 0.08);"
      : isFlora
        ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.94, 1.08, 0.92), dvePremiumMacro * 0.14);"
        : isExotic
          ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.96, 0.9, 1.12), dvePremiumMacro * 0.18); voxelBaseColor.rgb += vec3(0.03, 0.015, 0.05) * dvePremiumEdge * 0.18;"
          : "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.04, 1.01, 0.96), dvePremiumMacro * 0.08);"
}
`
        : "";
      const heightGradientAlbedoCode = enableSurfaceHeightGradient
        ? /* glsl */ `
float dveHGBreakup = dveFbm3(dveRotXZ(vPositionW, 0.83) * 0.04 + vec3(7.3, -2.1, 5.5));
float dveHGMask = clamp(dveHeightNorm + dveHGBreakup * 0.18 - 0.08, 0.0, 1.0);
vec3 dveWarmTint = vec3(1.06, 1.02, 0.94);
vec3 dveCoolTint = vec3(0.94, 0.97, 1.05);
vec3 dveHGTint = mix(dveWarmTint, dveCoolTint, dveHGMask);
voxelBaseColor.rgb *= mix(vec3(1.0), dveHGTint, 0.14);
${isRock ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.92, 0.95, 1.02), dveHGMask * dveSurfaceSlope * 0.1);" : ""}
${isFlora ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.96, 1.04, 0.94), (1.0 - dveHGMask) * dveSurfaceTop * 0.08);" : ""}
${isSoil || isCultivated ? "voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(1.04, 0.98, 0.9), (1.0 - dveHGMask) * 0.06);" : ""}
`
        : "";
      const importedMaterialAlbedoCode = enableImportedMaterialMaps
        ? /* glsl */ `
vec4 dveMaterialSample = dveSampleMaterialMap(dveBaseUV);
float dveMaterialPresence = clamp(dveMaterialSample.b, 0.0, 1.0);
voxelBaseColor.rgb = mix(
  voxelBaseColor.rgb,
  voxelBaseColor.rgb * mix(vec3(0.98), vec3(1.03, 1.025, 1.02), dveMaterialPresence),
  0.08
);
`
        : "";
      const unstableSurfaceContextLiftCode =
        disableUnstablePBRSurfaceContext
          ? /* glsl */ `
float dveBaseLightLift = mix(0.18, 0.32, dveTopExposure);
float dveCavityRecovery = (1.0 - dveBaseCavity) * 0.06;
float dveExposureRecovery = dveSurfaceExposure * 0.08;
float dveNearLift = dveNearField * 0.03;
voxelBaseColor.rgb += vec3(dveBaseLightLift * 0.12 + dveCavityRecovery + dveExposureRecovery + dveNearLift);
voxelBaseColor.rgb = mix(
  voxelBaseColor.rgb,
  voxelBaseColor.rgb * vec3(1.04, 1.035, 1.02),
  dveTopExposure * 0.1 + dveNearField * 0.06
);
`
          : "";
      const wetnessMicroSurfaceCode = enableWetness
        ? /* glsl */ `
#ifdef  DVE_${this.name}
vec3 dveNormalW = normalize(vNormalW);
float dveHydrologyWetness = ${enableWorldContext ? "clamp(dveWorldContext.z, 0.0, 1.0)" : "0.0"};
vec4 dveHydrologyFields = dveGetTerrainHydrologyFields(vPositionW, dveNormalW, dveHydrologyWetness, ${materialWetnessPorosity.toFixed(2)});
float dveWetnessBase = clamp(dveComputeWetness(dveNormalW, vPositionW) + dveHydrologyFields.x * (0.22 + ${materialWetnessPorosity.toFixed(2)} * 0.24) + dveHydrologyFields.w * (0.10 + ${materialWetnessPorosity.toFixed(2)} * 0.08), 0.0, 1.0);
float dveWetnessRetention = clamp(0.26 + ${materialWetnessPorosity.toFixed(2)} * 0.58 + dveHydrologyFields.z * 0.18 + dveHydrologyFields.w * 0.08, 0.0, 1.0);
float dveFreshWetness = max(max(smoothstep(0.24, 0.78, dveWetnessBase), smoothstep(0.08, 0.52, dveHydrologyFields.x) * (0.72 + ${materialWetnessPorosity.toFixed(2)} * 0.18)), smoothstep(0.08, 0.58, dveHydrologyFields.y) * (0.68 + ${materialWetnessPorosity.toFixed(2)} * 0.22));
float dveDryingWetness = clamp(dveWetnessBase * (0.42 + dveWetnessRetention * 0.42) * (1.0 - dveFreshWetness * 0.55) + dveHydrologyFields.x * (0.12 + dveWetnessRetention * 0.22) * (1.0 - dveFreshWetness * 0.45) + dveHydrologyFields.z * (0.18 + dveWetnessRetention * 0.14), 0.0, 1.0);
float dveWetnessMask = clamp(dveFreshWetness * (0.58 + ${materialWetnessPorosity.toFixed(2)} * 0.18) + dveDryingWetness + dveHydrologyFields.x * (0.08 + ${materialWetnessPorosity.toFixed(2)} * 0.16) + dveHydrologyFields.w * (0.08 + ${materialWetnessPorosity.toFixed(2)} * 0.12), 0.0, 1.0);
microSurface = mix(microSurface, mix(0.9, 0.98, dveFreshWetness), dveWetnessMask * mix(0.42, 0.82, ${materialWetnessPorosity.toFixed(2)}));
surfaceReflectivityColor = mix(
  surfaceReflectivityColor,
  max(surfaceReflectivityColor, vec3(0.08, 0.08, 0.08)),
  dveWetnessMask * mix(0.12, 0.32, ${materialWetnessPorosity.toFixed(2)})
);
#endif
`
        : "";
      const heightGradientMicroSurfaceCode =
        enableSurfaceHeightGradient && enableSurfaceMetadata
          ? /* glsl */ `
#ifdef  DVE_${this.name}
{
  float dveHGCavityRough = dveBaseCavity * 0.12;
  float dveHGHeightRough = dveHeightNorm * 0.08;
  float dveHGSlopeRough = dveSurfaceSlope * 0.06;
  microSurface = max(microSurface - dveHGCavityRough - dveHGHeightRough - dveHGSlopeRough, 0.02);
}
#endif
`
          : "";
      const importedMaterialMicroSurfaceCode = enableImportedMaterialMaps
  ? /* glsl */ `
#ifdef  DVE_${this.name}
vec4 dveMaterialSample = dveSampleMaterialMap(dveBaseUV);
float dveSmoothness = clamp(dveMaterialSample.r, 0.02, 0.98);
float dveF0Specular = clamp(dveMaterialSample.g, 0.0, 1.0);
float dveAmbientOcclusion = clamp(dveMaterialSample.b, 0.0, 1.0);
float dveReflectance = mix(0.02, 0.16, dveF0Specular);
surfaceAlbedo.rgb *= mix(vec3(1.0), vec3(0.92), dveAmbientOcclusion * 0.12);
microSurface = mix(microSurface, dveSmoothness, 0.45);
surfaceReflectivityColor = mix(surfaceReflectivityColor, vec3(dveReflectance), 0.28);
surfaceReflectivityColor *= mix(vec3(1.0), vec3(0.96), dveAmbientOcclusion * 0.08);
#endif
`
  : "";
      const importedMaterialBeforeLightsCode = enableImportedMaterialMaps
        ? /* glsl */ `
#ifdef DVE_${this.name}
// T2: Triplanar Whiteout detail-normal blend for imported material maps.
// Samples dve_voxel_normal from three world-space axes and applies the Whiteout
// reorientation (Mikkelsen 2017) to blend into normalW before lighting.
{
  vec3 dveT2GeomNorm = normalize(vNormalW);
  vec3 dveT2Blend = dveBlendWeights(dveT2GeomNorm);
  vec3 dveT2UV = vPositionW * 0.12;
  vec3 dveT2nX = dveSampleDetailNormal(dveT2UV.yz);
  vec3 dveT2nY = dveSampleDetailNormal(dveT2UV.xz + vec2(0.33));
  vec3 dveT2nZ = dveSampleDetailNormal(dveT2UV.xy + vec2(0.67));
  dveT2nX = vec3(dveT2nX.xy + dveT2GeomNorm.zy, abs(dveT2nX.z));
  dveT2nY = vec3(dveT2nY.xy + dveT2GeomNorm.xz, abs(dveT2nY.z));
  dveT2nZ = vec3(dveT2nZ.xy + dveT2GeomNorm.xy, abs(dveT2nZ.z));
  vec3 dveT2Detail = normalize(dveT2nX.zyx * dveT2Blend.x + dveT2nY.xzy * dveT2Blend.y + dveT2nZ.xyz * dveT2Blend.z);
  normalW = normalize(normalW + dveT2Detail * 0.5);
}
#endif
`
        : "";
      const wetnessFinalCode = enableWetness
        ? /* glsl */ `
vec3 dveNormalW = normalize(vNormalW);
float dveHydrologyWetness = ${enableWorldContext ? "clamp(dveWorldContext.z, 0.0, 1.0)" : "0.0"};
vec4 dveHydrologyFields = dveGetTerrainHydrologyFields(vPositionW, dveNormalW, dveHydrologyWetness, ${materialWetnessPorosity.toFixed(2)});
float dveWetnessBase = clamp(dveComputeWetness(dveNormalW, vPositionW) + dveHydrologyFields.x * (0.22 + ${materialWetnessPorosity.toFixed(2)} * 0.24) + dveHydrologyFields.w * (0.10 + ${materialWetnessPorosity.toFixed(2)} * 0.08), 0.0, 1.0);
float dveWetnessRetention = clamp(0.26 + ${materialWetnessPorosity.toFixed(2)} * 0.58 + dveHydrologyFields.z * 0.18 + dveHydrologyFields.w * 0.08, 0.0, 1.0);
float dveFreshWetness = max(max(smoothstep(0.24, 0.78, dveWetnessBase), smoothstep(0.08, 0.52, dveHydrologyFields.x) * (0.72 + ${materialWetnessPorosity.toFixed(2)} * 0.18)), smoothstep(0.08, 0.58, dveHydrologyFields.y) * (0.68 + ${materialWetnessPorosity.toFixed(2)} * 0.22));
float dveDryingWetness = clamp(dveWetnessBase * (0.42 + dveWetnessRetention * 0.42) * (1.0 - dveFreshWetness * 0.55) + dveHydrologyFields.x * (0.12 + dveWetnessRetention * 0.22) * (1.0 - dveFreshWetness * 0.45) + dveHydrologyFields.z * (0.18 + dveWetnessRetention * 0.14), 0.0, 1.0);
float dveWetnessMask = clamp(dveFreshWetness * (0.58 + ${materialWetnessPorosity.toFixed(2)} * 0.18) + dveDryingWetness + dveHydrologyFields.x * (0.08 + ${materialWetnessPorosity.toFixed(2)} * 0.16) + dveHydrologyFields.w * (0.08 + ${materialWetnessPorosity.toFixed(2)} * 0.12), 0.0, 1.0);
finalDiffuse.rgb = mix(finalDiffuse.rgb, finalDiffuse.rgb * vec3(0.9, 0.93, 0.98), dveWetnessMask * mix(0.08, 0.22, ${materialWetnessPorosity.toFixed(2)}));
finalDiffuse.rgb = mix(finalDiffuse.rgb, finalDiffuse.rgb * vec3(0.95, 0.96, 0.98), dveDryingWetness * 0.08);
`
        : "";
      const voxelLightFinalCode = /* glsl */ `
vec3 dveVoxelLight = dveGetVoxelLight();
      finalDiffuse.rgb *= mix(vec3(1.0), dveVoxelLight, ${voxelLightMix.toFixed(2)});
finalDiffuse.rgb += dveVoxelLight * 0.02;
`;

      return {
        CUSTOM_FRAGMENT_DEFINITIONS: /*glsl*/ `
#ifdef  DVE_${this.name}
precision highp sampler2DArray;
const float lightGradient[16] = float[16]( 0.06, 0.1, 0.11, 0.14, 0.17, 0.21, 0.26, 0.31, 0.38, 0.45, 0.54, 0.64, 0.74, 0.85, 0.97, 1.);
uniform float dve_time;
${textures}
${varying}
${functions}
// R11: POM UV delta — vec2(0) when POM is disabled, computed each fragment when pomEnabled.
vec2 dvePOMDelta = vec2(0.0);
#endif
`,

        CUSTOM_FRAGMENT_UPDATE_ALBEDO: /*glsl*/ `
#ifdef  DVE_${this.name}
${enablePOM ? `
// R11: Parallax Occlusion Mapping — derivative-based TBN, 8-step ray march
#ifdef DVE_POM_ENABLED
{
  vec3 dve_pomViewDir = normalize(vEyePosition.xyz - vPositionW);
  vec3 dve_pomNorm = normalize(vNormalW);
  vec3 dve_pomPosDx = dFdx(vPositionW), dve_pomPosDy = dFdy(vPositionW);
  vec2 dve_uvDx = dFdx(dveBaseUV), dve_uvDy = dFdy(dveBaseUV);
  float dve_pomDet = dve_uvDx.x * dve_uvDy.y - dve_uvDy.x * dve_uvDx.y;
  if (abs(dve_pomDet) > 1e-5) {
    float dve_invDet = 1.0 / dve_pomDet;
    vec3 dve_pomT = normalize((dve_pomPosDx * dve_uvDy.y - dve_pomPosDy * dve_uvDx.y) * dve_invDet);
    vec3 dve_pomB = normalize((dve_pomPosDy * dve_uvDx.x - dve_pomPosDx * dve_uvDy.x) * dve_invDet);
    float dve_pomTz = max(dot(dve_pomViewDir, dve_pomNorm), 0.1);
    vec2 dve_pomStep = vec2(dot(dve_pomViewDir, dve_pomT), dot(dve_pomViewDir, dve_pomB))
                       / dve_pomTz * 0.04 / 8.0;
    vec2 dve_pomCurUV = dveBaseUV;
    float dve_pomH = 1.0;
    for (int dve_pi = 0; dve_pi < 8; dve_pi++) {
      // E02: Derive height from inverse roughness (G = roughness channel in standard PBR packs:
      // smooth areas are "taller" surfaces, rough areas are recessed). This works without
      // requiring a dedicated height map in the import pipeline.
      float dve_h = 1.0 - texture(dve_voxel_material, vec3(dve_pomCurUV, dveTextureLayer)).g;
      if (dve_pomH < dve_h) break;
      dve_pomH -= 0.125;
      dve_pomCurUV -= dve_pomStep;
    }
    dvePOMDelta = dve_pomCurUV - dveBaseUV;
  }
}
#endif` : ""}

vec4 voxelBaseColor = texture(dve_voxel, vec3(dveBaseUV + dvePOMDelta, dveTextureLayer));
if (dveOverlayTextureIndex.x > 0.) {
  vec4 oRGB = texture(dve_voxel, vec3(dveBaseUV + dvePOMDelta, dveOverlayTextureIndex.x));
  if (oRGB.a > 0.5) voxelBaseColor = oRGB;
}
if (dveOverlayTextureIndex.y > 0.) {
  vec4 oRGB = texture(dve_voxel, vec3(dveBaseUV + dvePOMDelta, dveOverlayTextureIndex.y));
  if (oRGB.a > 0.5) voxelBaseColor = oRGB;
}
if (dveOverlayTextureIndex.z > 0.) {
  vec4 oRGB = texture(dve_voxel, vec3(dveBaseUV + dvePOMDelta, dveOverlayTextureIndex.z));
  if (oRGB.a > 0.5) voxelBaseColor = oRGB;
}
if (dveOverlayTextureIndex.w > 0.) {
  vec4 oRGB = texture(dve_voxel, vec3(dveBaseUV + dvePOMDelta, dveOverlayTextureIndex.w));
  if (oRGB.a > 0.5) voxelBaseColor = oRGB;
}
${albedoEnhancement}
${visualV2Code}
${macroVariationCode}
${triplanarCode}
${wetnessAlbedoCode}

${microVariationCode}
${surfaceOverlaysCode}
${nearCameraHighDetailCode}
${premiumAlbedoCode}
${heightGradientAlbedoCode}
${importedMaterialAlbedoCode}
${unstableSurfaceContextLiftCode}
// R15: Snow/ice accumulation on exposed top surfaces at altitude
float dveSnowEligibility = dveSurfaceTop * smoothstep(0.55, 0.75, dveHeightNorm);
float dveSnowNoise = dveFbm3(dveRotXZ(vPositionW, 0.19) * 0.15 + vec3(3.1, 0.0, 7.7));
float dveSnowMask = smoothstep(0.3, 0.7, dveSnowEligibility + dveSnowNoise * 0.2);
vec3 dveSnowColor = vec3(0.92, 0.94, 0.98);
voxelBaseColor.rgb = mix(voxelBaseColor.rgb, dveSnowColor, dveSnowMask * 0.85);
surfaceAlbedo = toLinearSpace(vec3(voxelBaseColor.r, voxelBaseColor.g, voxelBaseColor.b));
alpha *= voxelBaseColor.a;
`,
  CUSTOM_FRAGMENT_UPDATE_MICROSURFACE: /*glsl*/ `
${wetnessMicroSurfaceCode}
${heightGradientMicroSurfaceCode}
${importedMaterialMicroSurfaceCode}
// R15: Snow microsurface — snow is glossy/icy on top surfaces at altitude
#ifdef  DVE_${this.name}
{
  vec3 dveSnowNW = normalize(vNormalW);
  float dveSnowTop = smoothstep(0.45, 0.8, dveSnowNW.y);
  float dveSnowHN = clamp((vPositionW.y - 16.0) / 112.0, 0.0, 1.0);
  float dveSnowE = dveSnowTop * smoothstep(0.55, 0.75, dveSnowHN);
  float dveSnowN2 = dveFbm3(dveRotXZ(vPositionW, 0.62) * 0.15 + vec3(3.1, 0.0, 7.7));
  float dveSnowM = smoothstep(0.3, 0.7, dveSnowE + dveSnowN2 * 0.2);
  microSurface = mix(microSurface, 0.88, dveSnowM * 0.7);
}
#endif
`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: /*glsl*/ `
${importedMaterialBeforeLightsCode}
#ifdef DVE_${this.name}
// SE-01: Screen-space edge normal softening via dFdx/dFdy reconstruction.
// At flat face interiors the derivative normal matches the geometry normal → edgeFactor ≈ 0 → no change.
// At edge pixels where the hardware 2×2 derivative quad spans two adjacent face orientations,
// derivNormal blends both face normals → softer specular highlight at cube corners and ridges.
// ~4 FLOPs per fragment; no geometry or mesher changes required.
// BUG-N02: guard against zero cross product (silhouette/degenerate pixels) that would
//   make normalize() return NaN on some WebGL drivers.
// BUG-N01: use >= 0.0 instead of sign() — sign() returns 0.0 when dot==0.0, producing vec3(0).
{
  vec3 dve_dX = dFdx(vPositionW);
  vec3 dve_dY = dFdy(vPositionW);
  vec3 dve_cross = cross(dve_dX, dve_dY);
  float dve_edgeFactor = 0.0;  // T8: hoisted so specular occlusion below can read it
  if (dot(dve_cross, dve_cross) > 1e-6) {
    vec3 dve_derivN = normalize(dve_cross);
    dve_derivN *= (dot(dve_derivN, normalW) >= 0.0) ? 1.0 : -1.0;
    // Gate: suppress on near-flat faces to avoid per-triangle shading diamond pattern.
    // On flat surfaces dFdx/dFdy differ between the two triangles of a quad,
    // causing normalW to shift differently on each half → visible diagonal.
    float dve_flatness = max(abs(dot(normalize(vNormalW), vec3(0.0, 1.0, 0.0))),
                             max(abs(dot(normalize(vNormalW), vec3(1.0, 0.0, 0.0))),
                                 abs(dot(normalize(vNormalW), vec3(0.0, 0.0, 1.0)))));
    float dve_flatGate = smoothstep(0.92, 0.80, dve_flatness);
    dve_edgeFactor = smoothstep(0.04, 0.55, 1.0 - abs(dot(normalize(normalW), dve_derivN))) * dve_flatGate;
    normalW = normalize(mix(normalW, dve_derivN, dve_edgeFactor * 0.72));
  }
  // T8 NOTE: surfaceReflectivityColor is not available at CUSTOM_FRAGMENT_BEFORE_LIGHTS
  // (it lives inside reflectivityOut which is computed after this injection point).
  // Specular occlusion removed to avoid GLSL compile error; edge normal softening still active above.
}
#endif
`,
        /* "!finalIrradiance\\*\\=surfaceAlbedo.rgb;":
`finalIrradiance*=surfaceAlbedo.rgb;\nfinalIrradiance = vec3(VOXEL[2].rgb ) ;`, */
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: /*glsl*/ `
#ifdef  DVE_${this.name}
finalDiffuse.rgb += .01;
      ${voxelLightFinalCode}
${wetnessFinalCode}
#endif
`,
        CUSTOM_FRAGMENT_MAIN_END: /*glsl*/ `
#ifdef  DVE_${this.name}
if (glFragColor.a < 0.05) {
  discard;
}
#endif
`,
      };
    }
    return null;
  }
}
