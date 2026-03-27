import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { DVEBRPBRMaterial } from "./DVEBRPBRMaterial";
import { getDepthTextureBinding } from "./DepthTextureBinding";
import { getSceneWaterHybridBridge } from "../../Water/DVEWaterHybridBridge.js";

export class DVEWaterMaterialPlugin extends MaterialPluginBase {
  uniformBuffer: UniformBuffer;
  private static frameTimes = new WeakMap<Scene, { frameId: number; time: number; prevTime: number }>();

  id = crypto.randomUUID();

  constructor(
    material: PBRMaterial,
    name: string,
    public dveMaterial: DVEBRPBRMaterial,
    public onUBSet: (uniformBuffer: UniformBuffer) => void
  ) {
    super(material, name, 21, {
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
  }

  getClassName() {
    return "DVEWaterMaterialPlugin";
  }

  getSamplers(samplers: string[]) {
    samplers.push(
      "dve_voxel",
      "dve_voxel_animation",
      "dve_water_normal",
      "dve_water_foam_body",
      "dve_water_foam_breaker",
      "dve_water_hybrid_base",
      "dve_water_hybrid_dynamic",
      "dve_water_hybrid_flow",
      "dve_water_hybrid_debug",
      "dve_depthTexture"
    );
  }

  getAttributes(attributes: string[]) {
    attributes.push(
      "textureIndex",
      "uv",
      "worldContext",
      "metadata",
      "phNormalized",
      "subdivAO",
      "dissolutionProximity",
      "pullStrength",
      "subdivLevel",
      "pullDirectionBias",
      // Phase 4 — water surface derivatives (offsets 28–30)
      "waterGradientX",
      "waterGradientZ",
      "waterCurvature"
    );
  }

  getUniforms() {
    return {
      ubo: [
        { name: "dve_voxel_animation_size" },
        { name: "dve_time" },
        { name: "dve_time_prev" },
        { name: "dve_cameraNearFar", size: 2 },
        { name: "dve_screenSize", size: 2 },
        { name: "dve_water_hybrid_clip", size: 4 },
        { name: "dve_water_debug_params", size: 4 },
      ],
    };
  }

  private getWaterDebugParams(scene?: Scene) {
    const mode = String(scene?.metadata?.dveWaterDebugMode || "off").toLowerCase();
    const opacity = Number(scene?.metadata?.dveWaterDebugOpacity ?? 0);
    const clampedOpacity = Number.isFinite(opacity)
      ? Math.max(0, Math.min(1, opacity))
      : 0;
    switch (mode) {
      case "ownership":
        return [1, clampedOpacity, 0, 0] as const;
      case "composition":
        return [2, clampedOpacity, 0, 0] as const;
      case "hybrid-base":
        return [3, clampedOpacity, 0, 0] as const;
      case "hybrid-dynamic":
        return [4, clampedOpacity, 0, 0] as const;
      case "hybrid-flow":
        return [5, clampedOpacity, 0, 0] as const;
      case "bridge-raw":
        return [6, clampedOpacity, 0, 0] as const;
      case "context":
        return [7, clampedOpacity, 0, 0] as const;
      case "conflict":
        return [8, clampedOpacity, 0, 0] as const;
      default:
        return [0, 0, 0, 0] as const;
    }
  }

  bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, engine: Engine) {
    this.bindResources(uniformBuffer, scene);
  }

  hardBindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, engine: Engine) {
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
    if (scene) {
      const waterHybridBridge = getSceneWaterHybridBridge(scene);
      const clip = waterHybridBridge.getClipState();
      effect.setFloat4(
        "dve_water_hybrid_clip",
        clip.originX,
        clip.originZ,
        clip.invWidth,
        clip.invHeight,
      );
      effect.setTexture("dve_water_hybrid_debug", waterHybridBridge.getDebugTexture());
      const debugParams = this.getWaterDebugParams(scene);
      effect.setFloat4(
        "dve_water_debug_params",
        debugParams[0],
        debugParams[1],
        debugParams[2],
        debugParams[3],
      );
    } else {
      effect.setFloat4("dve_water_debug_params", 0, 0, 0, 0);
    }
    for (const [uniformId, size] of this.dveMaterial.animationSizes) {
      effect.setInt(uniformId, size);
    }
    if (scene) {
      const frameId = scene.getFrameId();
      let frameTime = DVEWaterMaterialPlugin.frameTimes.get(scene);
      if (!frameTime || frameTime.frameId !== frameId) {
        const prevTime = frameTime?.time ?? performance.now() * 0.001 - 0.016;
        frameTime = { frameId, time: performance.now() * 0.001, prevTime };
        DVEWaterMaterialPlugin.frameTimes.set(scene, frameTime);
      }
      effect.setFloat("dve_time", frameTime.time);
      // Phase 8 — Temporal coherence: previous frame time for height EMA.
      effect.setFloat("dve_time_prev", frameTime.prevTime);
    } else {
      const now = performance.now() * 0.001;
      effect.setFloat("dve_time", now);
      effect.setFloat("dve_time_prev", now - 0.016);
    }

    const depthBinding = getDepthTextureBinding(this._material, scene);
    effect.setTexture("dve_depthTexture", depthBinding.depthTexture);
    effect.setFloat2("dve_cameraNearFar", depthBinding.near, depthBinding.far);
    effect.setFloat2("dve_screenSize", depthBinding.screenWidth, depthBinding.screenHeight);
  }

  getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    const textures = /* glsl */ `
uniform sampler2DArray dve_voxel;
uniform highp usampler2D dve_voxel_animation;
uniform highp int dve_voxel_animation_size;
uniform sampler2D dve_water_normal;
uniform sampler2D dve_water_foam_body;
uniform sampler2D dve_water_foam_breaker;
uniform sampler2D dve_water_hybrid_base;
uniform sampler2D dve_water_hybrid_dynamic;
uniform sampler2D dve_water_hybrid_flow;
uniform sampler2D dve_water_hybrid_debug;
uniform sampler2D dve_depthTexture;
uniform vec2 dve_cameraNearFar;
uniform vec2 dve_screenSize;
uniform vec4 dve_water_hybrid_clip;
uniform vec4 dve_water_debug_params;
// Phase 8 — temporal coherence: previous frame GPU time
uniform float dve_time_prev;
`;
    const varying = /* glsl */ `
varying vec2 dveBaseUV;
varying float dveTextureLayer;
varying vec4 dveOverlayTextureIndex;
varying vec3 dveWorldContext;
varying vec4 dveWaterFlowData;
varying float dveShoreDistanceNormalized;
varying float dveStableWaterSurfaceY;
varying float dveDropHeight;
varying vec3 dveFoamClassData;
varying float dveVertexWaveHeight;
varying float dveVertexWaveCrest;
// Phase 4 — surface derivative varyings
varying vec2 dveWaterGradient;
varying float dveWaterCurvature;
`;
    const attributes = /* glsl */ `
attribute vec3 textureIndex;
attribute vec3 worldContext;
attribute vec4 metadata;
attribute float phNormalized;
attribute float subdivAO;
attribute float dissolutionProximity;
attribute float pullStrength;
attribute float subdivLevel;
attribute float pullDirectionBias;
// Phase 4 — water surface derivatives
attribute float waterGradientX;
attribute float waterGradientZ;
attribute float waterCurvature;
`;
    const functions = /* glsl */ `
const uint dveTextureIndexMask = uint(0xffff);
const uint dveSecondaryTextureIndex = uint(0x10);
const float DVE_SHORE_MOTION_DAMPING_START = 0.16;
const float DVE_SHORE_MOTION_DAMPING_END = 0.58;
const float DVE_SHALLOW_CLARITY_START = 0.02;
const float DVE_SHALLOW_CLARITY_END = 0.38;
const float DVE_FOAM_BAND_START = 0.18;
const float DVE_FOAM_BAND_END = 0.68;
const float DVE_FOAM_BAND_FADE_START = 0.78;
const float DVE_FOAM_BAND_FADE_END = 0.985;
const float DVE_FOAM_EDGE_START = 0.16;
const float DVE_FOAM_EDGE_END = 0.52;
const float DVE_BANK_DAMPING_START = 0.18;
const float DVE_BANK_DAMPING_END = 0.82;

float dveHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float dveValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = dveHash12(i);
  float b = dveHash12(i + vec2(1.0, 0.0));
  float c = dveHash12(i + vec2(0.0, 1.0));
  float d = dveHash12(i + vec2(1.0, 1.0));
  // Quintic Hermite (C² continuous) — reduces grid-boundary visibility vs cubic smoothstep.
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float dveGetLargeScaleWaterVariation(vec2 positionXZ) {
  float n0 = dveValueNoise(mat2(0.9171, -0.3986, 0.3986, 0.9171) * positionXZ * 0.031 + vec2(43.0, -27.0));
  float n1 = dveValueNoise(mat2(0.7648, -0.6442, 0.6442, 0.7648) * positionXZ * 0.019 + vec2(-17.3, 8.6));
  float n2 = dveValueNoise(mat2(0.9090, 0.4168, -0.4168, 0.9090) * positionXZ * 0.052 + vec2(5.1, -31.7));
  return clamp(n0 * 0.50 + n1 * 0.32 + n2 * 0.18, 0.0, 1.0);
}

vec2 dveGetWaterPatternWarp(vec2 positionXZ) {
  // Value-noise warp — avoids sin/cos dot-product diagonal bands.
  float warpX = dveValueNoise(mat2(0.9171, -0.3986, 0.3986, 0.9171) * positionXZ * 0.018 + vec2(31.7, -19.3)) * 2.0 - 1.0;
  float warpY = dveValueNoise(mat2(0.6822, -0.7312, 0.7312, 0.6822) * positionXZ * 0.016 + vec2(-8.4, 27.6)) * 2.0 - 1.0;
  return vec2(warpX, warpY) * 0.5;
}

float dveGetSoftWaterContextValue(float value, float macroVariation, float detailSample, float strength) {
  float centeredMacro = macroVariation - 0.5;
  float centeredDetail = detailSample - 0.5;
  float perturbed = clamp(value + centeredMacro * strength + centeredDetail * strength * 0.55, 0.0, 1.0);
  return clamp(mix(value, perturbed, 0.46), 0.0, 1.0);
}

float dveGetTextureIndex(int index) {
  uint tInt = texelFetch(
    dve_voxel_animation,
    ivec2(index % dve_voxel_animation_size, index / dve_voxel_animation_size),
    0
  ).r;
  if (tInt == 0u) return float(index);
  return float(tInt);
}

float dveWaterFresnel(float viewDot, float power) {
  return pow(clamp(1.0 - viewDot, 0.0, 1.0), power);
}

float dveGetWaterFresnelResponse(float waterViewDot) {
  return dveWaterFresnel(waterViewDot, 5.0);
}

vec3 dveGetWaterNormal(vec3 normalW) {
  return normalize(normalW);
}

vec3 dveGetWaterViewDirection(vec3 eyePosition, vec3 positionW) {
  return normalize(eyePosition - positionW);
}

float dveGetWaterViewDot(vec3 waterNormal, vec3 waterViewDir) {
  return clamp(abs(dot(waterNormal, waterViewDir)), 0.0, 1.0);
}

float dveGetUnderwaterFactor(vec3 eyePosition, float stableSurfaceY, float fragmentPositionY) {
  if (stableSurfaceY < 0.0) return 0.0;
  // Use the actual wave-displaced fragment Y as the surface reference.
  // The old per-cell stableSurfaceY constant caused visible grid banding at
  // every cell boundary because it stepped discontinuously between cells.
  return smoothstep(0.12, 1.75, max(fragmentPositionY + 0.05 - eyePosition.y, 0.0));
}

float dveGetWaterFacing(vec3 waterNormal) {
  return clamp(waterNormal.y * 0.5 + 0.5, 0.0, 1.0);
}

float dveLinearizeDepth(float depthSample, vec2 nearFar) {
  float z = depthSample * 2.0 - 1.0;
  return (2.0 * nearFar.x * nearFar.y) / max(nearFar.y + nearFar.x - z * (nearFar.y - nearFar.x), 0.0001);
}

vec3 dveClampWorldContextValues(vec3 worldContext) {
  return clamp(worldContext, vec3(0.0), vec3(1.0));
}

float dveGetShoreDistanceNormalized(float shoreDistanceNormalized) {
  return clamp(shoreDistanceNormalized, 0.0, 1.0);
}

float dveGetShorelineBand(float shoreFactor, float shoreDistanceNormalized) {
  return clamp(max(shoreFactor, 1.0 - shoreDistanceNormalized), 0.0, 1.0);
}

float dveGetShoreMotionDamping(float shoreDistanceNormalized) {
  return smoothstep(
    DVE_SHORE_MOTION_DAMPING_START,
    DVE_SHORE_MOTION_DAMPING_END,
    shoreDistanceNormalized
  );
}

float dveGetWaveAttenuation(float shoreFactor, float boundaryFactor) {
  return clamp((1.0 - shoreFactor) * (0.5 + boundaryFactor * 0.5), 0.0, 1.0);
}

float dveGetBankWaveDamping(float shorelineBand, float shoreDistanceNormalized) {
  float bankFactor = clamp(shorelineBand * 0.72 + (1.0 - shoreDistanceNormalized) * 0.28, 0.0, 1.0);
  return 1.0 - smoothstep(DVE_BANK_DAMPING_START, DVE_BANK_DAMPING_END, bankFactor) * 0.86;
}

float dveGetClassWaveScale(vec3 classWeights) {
  return classWeights.x * 0.68 + classWeights.y * 0.42 + classWeights.z * 1.08;
}

float dveGetClassDirectionalScale(vec3 classWeights) {
  return classWeights.x * 1.15 + classWeights.y * 0.42 + classWeights.z * 0.16;
}

float dveGetClassLateralScale(vec3 classWeights) {
  return classWeights.x * 0.05 + classWeights.y * 0.18 + classWeights.z * 0.62;
}

vec3 dveGetClassTint(vec3 classWeights) {
  return
    classWeights.x * vec3(0.9, 1.0, 0.92) +
    classWeights.y * vec3(0.98, 1.0, 1.02) +
    classWeights.z * vec3(0.88, 0.97, 1.12);
}

float dveGetClassCalmness(vec3 classWeights) {
  return classWeights.x * 0.02 + classWeights.y * 0.24 + classWeights.z * 0.06;
}

float dveGetClassFoamResponse(vec3 classWeights) {
  return classWeights.x * 0.9 + classWeights.y * 0.45 + classWeights.z * 1.14;
}

vec3 dveGetClassSurfacePreset(vec3 classWeights) {
  vec3 riverPreset = vec3(0.26, 0.105, -0.024);
  vec3 lakePreset = vec3(0.2, 0.082, 0.036);
  vec3 seaPreset = vec3(0.6, 0.26, 0.018);
  return riverPreset * classWeights.x + lakePreset * classWeights.y + seaPreset * classWeights.z;
}

float dveGetWaveResponse(
  float shoreFactor,
  float boundaryFactor,
  float shoreDistanceNormalized,
  vec3 classWeights
) {
  float shoreMotionDamping = dveGetShoreMotionDamping(shoreDistanceNormalized);
  float shorelineBand = dveGetShorelineBand(shoreFactor, shoreDistanceNormalized);
  float bankWaveDamping = dveGetBankWaveDamping(shorelineBand, shoreDistanceNormalized);
  float classWaveScale = dveGetClassWaveScale(classWeights);
  float waveResponse = dveGetWaveAttenuation(shoreFactor, boundaryFactor) * mix(0.12, 1.0, shoreMotionDamping) * bankWaveDamping * classWaveScale;
  // Minimum floor: ensures isolated/editor-placed water always has visible
  // ripple texture and normal-map animation even when shoreFactor == 1.
  return max(waveResponse, 0.22);
}

vec2 dveGetMacroMotion(float time, float waveAttenuation) {
  return vec2(0.006, 0.003) * time * mix(0.12, 0.45, waveAttenuation);
}

vec2 dveGetMicroMotion(float time, float waveAttenuation) {
  return vec2(-0.024, 0.017) * time * mix(0.18, 0.78, waveAttenuation);
}

float dveGetLargeBodySignal(float openWaterFactor, vec4 hybridBaseMask) {
  float bodyOpen = smoothstep(0.34, 0.92, openWaterFactor);
  float calmness = clamp(hybridBaseMask.b, 0.0, 1.0);
  float fill = clamp(hybridBaseMask.a, 0.0, 1.0);
  return clamp(bodyOpen * smoothstep(0.52, 0.92, calmness) * mix(0.78, 1.0, fill), 0.0, 1.0);
}

float dveGetLargeBodyMacroVariation(float baseVariation, vec2 positionXZ, float largeBodySignal) {
  float lowFrequencyVariation = dveGetLargeScaleWaterVariation(positionXZ * 0.28 + vec2(43.0, -27.0));
  return mix(baseVariation, lowFrequencyVariation, largeBodySignal * 0.72);
}

vec2 dveGetLargeBodyPatternWarp(vec2 basePatternWarp, float largeBodySignal) {
  return basePatternWarp * mix(1.0, 0.22, largeBodySignal);
}

float dveGetPatchFlowSignal(vec4 hybridDynamicMask) {
  return clamp(hybridDynamicMask.a, 0.0, 1.0);
}

float dveGetPatchAwareSignal(float largeBodySignal, float patchFlowSignal) {
  return max(largeBodySignal, patchFlowSignal);
}

float dveGetDebugGridMask(vec2 value, float scale, float width) {
  vec2 grid = abs(fract(value * scale) - 0.5);
  float line = 1.0 - smoothstep(0.5 - width, 0.5, max(grid.x, grid.y));
  return clamp(line, 0.0, 1.0);
}

vec3 dveGetOwnershipDebugColor(
  float largeBodyRaw,
  float patchFlowSignal,
  float localFluidEventSignal,
  float shoreFactor,
  float openWaterFactor,
  float patchWeight,
  float ssfrWeight
) {
  float continuous = clamp(max(largeBodyRaw, patchFlowSignal), 0.0, 1.0);
  float legacy = clamp((1.0 - continuous) * (shoreFactor * 0.7 + openWaterFactor * 0.3), 0.0, 1.0);
  float localFluid = clamp(max(localFluidEventSignal, ssfrWeight), 0.0, 1.0);
  vec3 color =
    vec3(0.92, 0.63, 0.14) * legacy +
    vec3(0.08, 0.92, 0.55) * continuous +
    vec3(0.94, 0.16, 0.82) * localFluid;
  float neutral = clamp(1.0 - max(max(legacy, continuous), localFluid), 0.0, 1.0);
  color += vec3(0.12, 0.2, 0.94) * neutral;
  return clamp(mix(color, vec3(patchWeight, 0.0, ssfrWeight), 0.3), 0.0, 1.0);
}

vec3 dveGetConflictDebugColor(
  float largeBodyRaw,
  float patchFlowSignal,
  float shoreRaw,
  float shoreFactor,
  float interactionRaw,
  float patchWeight,
  float ssfrWeight,
  float localFluidEventSignal
) {
  float ownershipConflict = abs(largeBodyRaw - patchFlowSignal);
  float shorelineConflict = abs(shoreRaw - shoreFactor);
  float compositionConflict = abs(patchWeight - ssfrWeight);
  float eventConflict = abs(localFluidEventSignal - interactionRaw);
  return clamp(
    vec3(
      max(ownershipConflict, compositionConflict),
      shorelineConflict,
      max(eventConflict, compositionConflict * 0.75)
    ),
    0.0,
    1.0
  );
}

float dveGetPatchAwareSteering(
  float hybridInfluence,
  float largeBodySignal,
  float patchFlowSignal,
  float largeBodyWeight,
  float patchFlowWeight
) {
  return max(hybridInfluence, max(largeBodySignal * largeBodyWeight, patchFlowSignal * patchFlowWeight));
}

vec2 dveGetPatchAwareFlowDirection(
  vec2 flowDirection,
  vec2 hybridFlowVector,
  float hybridInfluence,
  float largeBodySignal,
  float patchFlowSignal,
  float largeBodyWeight,
  float patchFlowWeight
) {
  return normalize(mix(
    flowDirection,
    hybridFlowVector,
    dveGetPatchAwareSteering(
      hybridInfluence,
      largeBodySignal,
      patchFlowSignal,
      largeBodyWeight,
      patchFlowWeight
    )
  ));
}

vec2 dveGetFoamMotion(float time, float waveAttenuation) {
  return vec2(0.012, -0.007) * time * mix(0.12, 0.48, waveAttenuation);
}

vec2 dveGetShoreFoamMotion(float time, float waveAttenuation) {
  return vec2(0.008, -0.004) * time * mix(0.08, 0.28, waveAttenuation);
}

vec2 dveGetImpactFoamMotion(float time, float waveAttenuation, float dropFactor) {
  return vec2(0.02, -0.016) * time * mix(0.18, 0.76, clamp(waveAttenuation + dropFactor * 0.35, 0.0, 1.0));
}

float dveGetClassLocalShimmerScale(vec3 classWeights) {
  return classWeights.x * 0.012 + classWeights.y * 0.003 + classWeights.z * 0.009;
}

vec2 dveGetFlowDirection(vec4 flowData) {
  float len = length(flowData.xy);
  if (len <= 0.0001) return vec2(0.0, 1.0);
  return flowData.xy / len;
}

float dveGetFlowStrength(vec4 flowData) {
  return clamp(flowData.z, 0.0, 1.0);
}

float dveGetPackedWaterClassValue(vec4 flowData) {
  float packed = clamp(flowData.w, 0.0, 1.0);
  if (packed < 0.33) return 0.16;
  if (packed < 0.67) return 0.5;
  return 0.84;
}

float dveGetWaterTurbidity(vec4 flowData) {
  float packed = clamp(flowData.w, 0.0, 1.0);
  float classCenter = dveGetPackedWaterClassValue(flowData);
  return clamp((packed - (classCenter - 0.09)) / 0.18, 0.0, 1.0);
}

vec3 dveGetWaterClassWeights(float classValue) {
  float river = 1.0 - smoothstep(0.08, 0.3, classValue);
  float sea = smoothstep(0.58, 0.82, classValue);
  float lake = clamp(1.0 - river - sea, 0.0, 1.0);
  return vec3(river, lake, sea);
}

vec2 dveGetPerpendicular(vec2 direction) {
  return vec2(-direction.y, direction.x);
}

vec2 dveGetDirectionalMotion(
  vec2 flowDirection,
  float flowStrength,
  vec3 classWeights,
  float time,
  float speed,
  float lateralScale,
  float waveAttenuation
) {
  float directionalBias = dveGetClassDirectionalScale(classWeights);
  float effectiveStrength = flowStrength * directionalBias * mix(0.25, 1.0, waveAttenuation);
  vec2 lateral = dveGetPerpendicular(flowDirection);
  return (
    flowDirection * speed +
    lateral * speed * lateralScale * dveGetClassLateralScale(classWeights)
  ) * time * effectiveStrength;
}

float dveGetLocalShimmerPattern(vec2 positionXZ, vec2 flowDirection, float time) {
  // Noise-based shimmer — avoids sin/cos diagonal band artifacts.
  vec2 advA = flowDirection * time * 0.38 + vec2(3.1, -7.4);
  vec2 advB = flowDirection * time * 0.21 + vec2(-11.2, 5.9);
  float s0 = dveValueNoise(mat2(0.9553, -0.2955, 0.2955, 0.9553) * positionXZ * 0.11 + advA);
  float s1 = dveValueNoise(mat2(0.8253, -0.5646, 0.5646, 0.8253) * positionXZ * 0.19 + advB + vec2(17.3, -9.1));
  return s0 * 0.6 + s1 * 0.4;
}

vec2 dveHash22(vec2 p) {
  return vec2(
    dveHash12(p + vec2(17.17, 3.11)),
    dveHash12(p + vec2(11.83, 29.47))
  );
}

mat2 dveRotate2D(float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return mat2(c, -s, s, c);
}

vec2 dveGetAperiodicDetailUV(
  vec2 positionXZ,
  vec2 flowDirection,
  float seed,
  float baseScale,
  float waveAttenuation
) {
  vec2 safeFlowDirection = length(flowDirection) <= 0.0001 ? vec2(0.0, 1.0) : normalize(flowDirection);
  float rotation = seed * 6.2831853;
  vec2 domain = dveRotate2D(rotation) * (positionXZ * baseScale);
  vec2 warped = dveGetWaterPatternWarp(positionXZ * (0.75 + seed * 0.9));
  vec2 advected = safeFlowDirection * (seed * 0.17 + waveAttenuation * 0.11);
  return domain + warped * (0.09 + waveAttenuation * 0.16) + advected;
}

float dveGetApproxBoundaryFactor(float fillFactor, float shoreFactor, float shoreDistanceNormalized, float flowStrength) {
  return clamp(
    fillFactor * 0.22 +
    (1.0 - shoreFactor) * 0.3 +
    shoreDistanceNormalized * 0.32 +
    flowStrength * 0.16,
    0.0,
    1.0
  );
}

// ── Realistic multi-scale Voronoi for water foam ──────────────────────────────
// Uses higher jitter for organic cell shapes and tracks d2-d1 gradient for
// natural ridge intensity between cells. Animation is driven by the UV
// coordinates passed in (they already include time-based flow/motion).
// Returns: (closestDist, edgeDist, cellRand, d2-d1 gradient).
vec4 dveVoronoiCellData(vec2 value) {
  vec2 baseCell = floor(value);
  vec2 cellOffset = fract(value);

  float d1 = 10.0;
  float d2 = 10.0;
  vec2 toClosestCell = vec2(0.0);
  vec2 closestCell = vec2(0.0);

  for (int x1 = -1; x1 <= 1; x1++) {
    for (int y1 = -1; y1 <= 1; y1++) {
      vec2 cell = baseCell + vec2(float(x1), float(y1));
      vec2 jitter = dveHash22(cell);
      // High jitter (0.92) for more organic, less grid-like cells
      vec2 point = vec2(float(x1), float(y1)) + jitter * 0.92;
      vec2 toCell = point - cellOffset;
      float distToCell = length(toCell);
      if (distToCell < d1) {
        d2 = d1;
        d1 = distToCell;
        toClosestCell = toCell;
        closestCell = cell;
      } else if (distToCell < d2) {
        d2 = distToCell;
      }
    }
  }

  float minEdgeDistance = 10.0;
  for (int x2 = -1; x2 <= 1; x2++) {
    for (int y2 = -1; y2 <= 1; y2++) {
      vec2 cell = baseCell + vec2(float(x2), float(y2));
      vec2 diffToClosestCell = abs(closestCell - cell);
      if (diffToClosestCell.x + diffToClosestCell.y < 0.1) continue;

      vec2 jitter = dveHash22(cell);
      vec2 point = vec2(float(x2), float(y2)) + jitter * 0.92;
      vec2 toCell = point - cellOffset;
      vec2 toCenter = (toClosestCell + toCell) * 0.5;
      vec2 cellDifference = normalize(toCell - toClosestCell);
      float edgeDistance = dot(toCenter, cellDifference);
      minEdgeDistance = min(minEdgeDistance, edgeDistance);
    }
  }

  return vec4(d1, minEdgeDistance, dveHash12(closestCell + 13.7), d2 - d1);
}

vec4 dveGetVertexWaveDisplacement(
  vec3 positionW,
  vec2 flowDirection,
  float flowStrength,
  float shoreDistanceNormalized,
  float boundaryFactor,
  float worldInteraction,
  vec3 classWeights
) {
  // ─── DOMAIN: world-position + time ONLY ─────────────────────────────────
  // Single domain warp pass (was 3) — saves 2 × dveGetWaterPatternWarp calls
  // in the vertex shader. The single warp already breaks grid alignment.
  vec2 domainWarp = dveGetWaterPatternWarp(
    positionW.xz * 0.47 + vec2(dve_time * 0.08, -dve_time * 0.05)
  );
  vec2 domain = positionW.xz + domainWarp * 2.0;

  // ─── FIXED WORLD-SPACE WAVE DIRECTIONS ───────────────────────────────────
  // Irrational angles (not multiples of 45°) prevent grid-aligned banding.
  vec2 dir0 = vec2( 0.8660,  0.5000);   //  30°
  vec2 dir1 = vec2(-0.3420,  0.9397);   // 110°
  vec2 dir2 = vec2( 0.6428,  0.7660);   //  50°
  vec2 dir3 = vec2(-0.7071,  0.7071);   // 135°
  vec2 dir4 = vec2( 0.9848, -0.1736);   // -10°
  vec2 dir5 = vec2( 0.1392,  0.9903);   //  82°

  // ─── PHASES (A–F only; G/H detail dropped from vertex) ───────────────────
  float t = dve_time;
  // Phase noise: centered around 0 (noise*2-1), multi-scale, slow advection.
  // Breaks up parallel sine ridges without removing the wave feel.
  float pn0 = (dveValueNoise(domain * 0.061 + vec2(t * 0.023, -t * 0.017)) * 2.0 - 1.0) * 2.6;
  float pn1 = (dveValueNoise(domain * 0.034 + vec2(-t * 0.013, t * 0.011) + vec2(23.4, -11.7)) * 2.0 - 1.0) * 4.8;
  float pn2 = (dveValueNoise(domain * 0.112 + vec2(t * 0.041, t * 0.029) + vec2(-8.7, 17.3)) * 2.0 - 1.0) * 1.2;
  float phaseBreak = pn0 + pn1 + pn2;
  float phaseA = dot(domain, dir0) * 0.2472 + t * 0.62 + phaseBreak * 0.22;
  float phaseB = dot(domain, dir1) * 0.3183 - t * 0.41 + phaseBreak * 0.17;
  float phaseC = dot(domain, dir2) * 0.8507 + t * 1.18 + phaseBreak * 0.11;
  float phaseD = dot(domain, dir3) * 1.2732 - t * 0.96 + phaseBreak * 0.08;
  float phaseE = dot(domain, dir4) * 2.2361 + t * 2.38 + phaseBreak * 0.06;
  float phaseF = dot(domain, dir5) * 2.7183 - t * 1.97 + phaseBreak * 0.04;

  // ─── AMPLITUDE ENVELOPE: WORLD-POSITION ONLY ─────────────────────────────
  // ROOT CAUSE FIX (part 2): Even with phases fixed (part 1), any per-cell
  // attribute that scales amplitude produces different heights at shared boundary
  // vertices between adjacent cells. The only safe approach is a fully
  // world-position-based energy. We use a large-scale smooth value noise
  // (period ≈ 55 voxels) so amplitude varies naturally but is C0-continuous
  // at every cell boundary — no step, no seam, no "listones".
  float waveEnergy = clamp(
    mix(0.5, 1.15, dveValueNoise(positionW.xz * 0.018 + vec2(37.4, 15.9))),
    0.35, 1.3
  );

  float steepness  = mix(0.12, 0.42,  clamp(waveEnergy * 0.7,  0.0, 1.0));
  float largeAmp   = mix(0.018, 0.16,  clamp(waveEnergy * 0.82, 0.0, 1.0));
  float mediumAmp  = mix(0.008, 0.085, clamp(waveEnergy * 0.82, 0.0, 1.0));
  float chopAmp    = mix(0.004, 0.05,  clamp(waveEnergy * 0.9,  0.0, 1.0));
  // detailAmp1/2 (phaseG/H) removed from vertex — negligible amplitude, saved 2 sin/cos

  // ─── WAVE HEIGHTS ─────────────────────────────────────────────────────────
  float swellWave  = sin(phaseA) * 0.65 + sin(phaseB) * 0.35;
  float swellShaped = swellWave + steepness * swellWave * abs(swellWave);

  float medWave   = sin(phaseC) * 0.58 + sin(phaseD) * 0.42;
  float medShaped = medWave + steepness * 0.8 * medWave * abs(medWave);

  // pow(x,1.6) → x*sqrt(x) ≈ pow(x,1.5): avoids generic pow() in vertex shader
  float chopSinE  = abs(sin(phaseE));
  float chopCosF  = abs(cos(phaseF));
  float chopWaveA = sign(sin(phaseE)) * chopSinE * sqrt(chopSinE);
  // pow(x,2.0) → x*x: exact, cheaper
  float chopWaveB = sign(cos(phaseF)) * chopCosF * chopCosF;

  // noiseDetail removed from vertex (save 1 × dveValueNoise)
  float noiseWave = (dveValueNoise(domain * 0.17 + vec2(t * 0.07, -t * 0.05)) - 0.5) * mix(0.015, 0.07, clamp(waveEnergy, 0.0, 1.0));

  float height =
    swellShaped  * largeAmp +
    medShaped    * mediumAmp +
    (chopWaveA * 0.72 + chopWaveB * 0.28) * chopAmp +
    noiseWave;
  // NOTE: interaction remains excluded from vertex height so local events do not
  // create constant geometric steps at cell boundaries. Crest reads a continuous
  // world-space hybrid field instead of per-cell vertex payload.

  float crest = clamp(
    max(height, 0.0) * 3.5 +
    abs(chopWaveA) * clamp(chopAmp * 6.0, 0.0, 0.7) +
    abs(medShaped) * clamp(mediumAmp * 2.2, 0.0, 0.4) +
    worldInteraction * 0.35,
    0.0, 1.0
  );

  // ─── GERSTNER LATERAL (XZ): trig-only, no noise in vertex ─────────────────
  // Lateral noise removed (save 2 × dveValueNoise). Phase-based cos/sin is
  // sufficient; noise micro-breakup belongs in the fragment shader.
  // ×0.5 lateral scale: original 0.04–0.19 m range was too large for
  // subdiv=1 geometry, causing visible triangular silhouettes. Scale down
  // to ~0.02–0.095 m; high-energy zones with subdiv=2 still look dynamic.
  vec2 gerstnerLateral = (
    dir0 * (-cos(phaseA) * largeAmp * steepness * 1.2) +
    dir1 * (-cos(phaseB) * largeAmp * steepness * 0.85) +
    dir2 * ( cos(phaseC) * mediumAmp * 0.55 + chopWaveA * chopAmp * 0.35) +
    dir3 * ( sin(phaseB)  * largeAmp * 0.65  + cos(phaseD) * mediumAmp * 0.45)
  ) * mix(0.4, 1.0, clamp(waveEnergy, 0.0, 1.0)) * 0.5;

  return vec4(gerstnerLateral.x, height, gerstnerLateral.y, crest);
}

// ─── Phase 4 \u2014 Flow-noise and directional-wave helpers ────────────────────────
// These functions are vertex-shader safe (no fwidth/derivatives).
// They build on the same dveValueNoise / dveGetWaterPatternWarp base used by
// dveGetVertexWaveDisplacement so their domain continuity is guaranteed
// across cell boundaries.

// Advected multi-octave noise representing micro-turbulence along flow.
// ROOT CAUSE FIX: per-cell flowDir in the advection domain creates different
// sample coordinates at shared voxel-cell boundary vertices → animated Y-seam.
// Use a fixed world-space direction (irrational angle, same convention as dir0-dir5
// in dveGetVertexWaveDisplacement) so adjacent cells always compute the same adv.
// Single-octave version (was 2): saves 1 × dveValueNoise per call × 2 time
// samples in the temporal coherence path = 2 noise calls saved per vertex.
float dveWaterFlowNoise(vec2 posXZ, vec2 flowDir, float flowStrength, float time) {
  vec2 adv = posXZ + vec2(0.6180, 0.7861) * time * 0.12;
  float n0 = dveValueNoise(adv * 0.28 + vec2(3.71, -1.83));
  return (n0 - 0.5) * 0.058;
}

// Directional Gerstner-lite wave along flow axis.
// ROOT CAUSE FIX: per-cell flowDir for the dot-product phase creates an
// immediate height discontinuity at cell boundaries. Use fixed world-space
// directions (matching dir0/dir1 from dveGetVertexWaveDisplacement).
float dveWaterWave(vec2 posXZ, vec2 flowDir, float flowStrength, float time) {
  vec2 fixedDirA = vec2( 0.8660,  0.5000); //  30°
  vec2 fixedDirB = vec2(-0.3420,  0.9397); // 110°
  // Phase noise: centered around 0 to break up parallel sine ridges symmetrically
  float pn = (dveValueNoise(posXZ * 0.061 + vec2(time * 0.027, -time * 0.019)) * 2.0 - 1.0) * 2.4;
  float ph0 = dot(posXZ, fixedDirA) * 0.38 + time * 0.55 + pn * 0.22;
  float ph1 = dot(posXZ, fixedDirB * 0.71) * 0.64 - time * 0.37 + pn * 0.16;
  return (sin(ph0) * 0.6 + sin(ph1) * 0.4) * 0.026;
}

// ─── Phase 7 \u2014 Continuous GPU height field ─────────────────────────────────
// Computes a world-position-derived height DELTA from the CPU base height.
// blend = 0.0 while USE_GPU_WATER = false (CPU controls geometry).
// blend \u2192 1.0 as GPU takes over cell-grid form.
// Uses domain-warped noise + flow-advected waves for C0-continuity at
// all cell boundaries (same domain strategy as dveGetVertexWaveDisplacement).
// 2-octave version (was 3): saves 1 × dveValueNoise in vertex shader.
float dveWaterContinuousHeight(vec3 worldPos, vec2 flowDir, float flowStrength, float time) {
  vec2 advA = vec2( 0.6180,  0.7861) * time;
  vec2 advB = vec2(-0.5257,  0.8507) * time;
  // Domain warp for large-scale continuity
  vec2 dw = dveGetWaterPatternWarp(worldPos.xz * 0.35 + vec2(time * 0.04, -time * 0.03));
  vec2 domain = worldPos.xz + dw * 1.2;
  // 2 noise octaves — world-position only
  float n0 = dveValueNoise(domain * 0.18 + advA * 0.09);
  float n1 = dveValueNoise(domain * 0.34 + advB * 0.14 + vec2(7.3, -3.1));
  float noiseH = (n0 * 0.65 + n1 * 0.35 - 0.5) * 0.07;
  // Additional noise octave to replace sin-based wave lines
  vec2 advC = vec2( 0.7071, 0.7071) * time * 0.062;
  float n2 = dveValueNoise(domain * 0.54 + advC + vec2(-5.7, 14.3));
  float waveDetail = (n2 - 0.5) * 0.038;
  return noiseH + waveDetail;
}

`;

    const fragmentOnlyFunctions = /* glsl */ `
float dveGetDistanceStableDetailFade(vec3 positionW, vec3 eyePosition, float waveAttenuation) {
  float viewDistance = length(eyePosition - positionW);
  float distanceFade = 1.0 - smoothstep(18.0, 120.0, viewDistance);
  float footprint = clamp(viewDistance * 0.008, 0.0, 1.0);
  float footprintPreservation = 1.0 - footprint;
  return clamp(max(distanceFade, footprintPreservation) * (0.28 + waveAttenuation * 0.72), 0.0, 1.0);
}

float dveSampleFoamTexture(vec2 uv, float breakerMix) {
  // Tiled UV scales — body uses larger tiles (calmer pattern), breaker uses finer tiles.
  vec2 bodyUV    = uv * mix(0.38, 0.46, 0.0) + vec2(17.3, -9.1) * 0.07;
  vec2 breakerUV = uv * mix(0.52, 0.68, clamp(breakerMix, 0.0, 1.0)) + vec2(-4.7, 12.9) * 0.07;
  // Sample body foam (ambientCG Foam001 Displacement — organic sheet foam)
  // No manual fract() — texture wrap mode (REPEAT) handles tiling without seam discontinuities.
  float bodyA = texture(dve_water_foam_body, bodyUV).r;
  float bodyB = texture(dve_water_foam_body, dveRotate2D(0.62) * bodyUV * 0.88).r;
  float body  = bodyA * 0.60 + bodyB * 0.40;
  // Sample breaker foam (ambientCG Foam003 Displacement — active sea foam)
  float brkA  = texture(dve_water_foam_breaker, breakerUV).r;
  float brkB  = texture(dve_water_foam_breaker, dveRotate2D(-0.48) * breakerUV * 0.76).r;
  float brk   = brkA * 0.55 + brkB * 0.45;
  return mix(body, brk, clamp(breakerMix, 0.0, 1.0));
}

float dveGetTextureFoamMask(
  vec2 value,
  vec2 flowDirection,
  float anisotropy,
  float threshold
) {
  vec2 dir = length(flowDirection) > 0.0001 ? normalize(flowDirection) : vec2(0.0, 1.0);
  vec2 tangent = vec2(-dir.y, dir.x);
  vec2 aligned = vec2(dot(value, tangent), dot(value, dir));
  vec2 uvA = aligned * vec2(mix(0.42, 0.68, anisotropy), mix(0.72, 0.36, anisotropy));
  vec2 uvB = (dveRotate2D(0.33) * aligned) * vec2(0.58, 0.24) + dir * 0.09;
  vec2 uvC = (dveRotate2D(-0.61) * value) * 0.18 + tangent * 0.08;
  float texA = dveSampleFoamTexture(uvA, 0.0);
  float texB = dveSampleFoamTexture(uvB, 0.0);
  float texC = dveSampleFoamTexture(uvC, 0.0);
  float breakupTex = texA * 0.5 + texB * 0.32 + texC * 0.18;
  float sheetBase = dveValueNoise(aligned * vec2(0.11, 0.07) + dir * 0.63 - tangent * 0.41);
  float sheetSecondary = dveValueNoise((dveRotate2D(0.27) * aligned) * vec2(0.18, 0.12) + dir * 0.91);
  float sheetTertiary = dveValueNoise((dveRotate2D(-0.53) * aligned) * vec2(0.24, 0.16) + tangent * 0.77);
  float sheetField = mix(mix(sheetBase, sheetSecondary, 0.44 + anisotropy * 0.12), sheetTertiary, 0.22);
  float textureField = mix(sheetField, clamp(sheetField + (breakupTex - 0.5) * 0.28, 0.0, 1.0), 0.36);
  float textureWidth = 0.004;
  float foamMask = smoothstep(
    threshold - textureWidth,
    threshold + textureWidth,
    textureField
  );
  float breakup = smoothstep(0.28, 0.72, dveValueNoise(value * 0.24 + dir * 0.83 - tangent * 0.36));
  return clamp(foamMask * (0.78 + breakup * 0.1), 0.0, 1.0);
}

float dveGetBreakerFoamMask(
  vec2 value,
  vec2 flowDirection,
  float breakerSignal,
  float threshold
) {
  vec2 dir = length(flowDirection) > 0.0001 ? normalize(flowDirection) : vec2(0.0, 1.0);
  vec2 tangent = vec2(-dir.y, dir.x);
  vec2 aligned = vec2(dot(value, tangent), dot(value, dir));
  // Streak noise — use flow-aligned coords with modest anisotropy (max 2.5:1) to avoid banding.
  float streakField0 = dveValueNoise(aligned * vec2(mix(0.38, 0.58, breakerSignal), mix(0.22, 0.14, breakerSignal)) + dir * 0.84);
  float streakField1 = dveValueNoise(dveRotate2D(0.29) * aligned * vec2(0.46, 0.22) + tangent * 0.48);
  float streakField2 = dveValueNoise((dveRotate2D(-0.41) * aligned) * vec2(mix(0.32, 0.52, breakerSignal), 0.24) + dir * 0.52);
  float streak = smoothstep(0.42, 0.82, streakField0 * 0.50 + streakField1 * 0.32 + streakField2 * 0.18) * (0.36 + breakerSignal * 0.14);
  vec2 spillValue = aligned * vec2(0.56, 0.34) + dir * 0.08;
  vec2 spillAligned = vec2(dot(spillValue, tangent), dot(spillValue, dir));
  vec2 uvA = spillAligned * vec2(mix(0.48, 0.74, breakerSignal), mix(0.86, 0.38, breakerSignal));
  vec2 uvB = (dveRotate2D(0.23) * spillAligned) * vec2(0.62, 0.28) + dir * 0.06;
  vec2 uvC = (dveRotate2D(-0.52) * spillValue) * 0.22 + tangent * 0.09;
  float breakerTexA = dveSampleFoamTexture(uvA, 1.0);
  float breakerTexB = dveSampleFoamTexture(uvB, 1.0);
  float breakerTexC = dveSampleFoamTexture(uvC, 1.0);
  float breakerEnvelope = dveValueNoise(spillAligned * vec2(0.16, 0.08) + dir * 0.52);
  float breakerMean = mix(breakerEnvelope, breakerEnvelope + (breakerTexA * 0.46 + breakerTexB * 0.34 + breakerTexC * 0.2 - 0.5) * 0.16, 0.26);
  float breakerWidth = 0.004;
  float spill = smoothstep(
    (threshold - 0.03) - breakerWidth,
    (threshold - 0.03) + breakerWidth,
    breakerMean
  );
  float froth = smoothstep(0.22, 0.74, dveValueNoise(value * 0.62 - dir * 0.93)) * 0.16;
  return clamp(
    max(spill * (0.74 + breakerSignal * 0.14), streak + froth * 0.5),
    0.0,
    1.0
  );
}

float dveGetVoronoiFoamMask(vec2 value, float coarseThreshold, float fineThreshold) {
  // ── Coarse layer: large organic foam cells ──
  vec4 coarseCell = dveVoronoiCellData(value);

  float coarseWidth = 0.003;

  float coarseBorder = 1.0 - smoothstep(
    coarseThreshold - coarseWidth, coarseThreshold + coarseWidth, coarseCell.y
  );

  // Inter-cell gradient (d2-d1) creates organic ridge intensity
  float coarseRidge = smoothstep(0.0, 0.45, coarseCell.w) * 0.25;

  // Interior fill — soft spots inside cells (bubble interiors)
  float coarseInterior = (1.0 - smoothstep(0.12, 0.58, coarseCell.x)) * 0.06;

  // Per-cell random modulation breaks uniform look
  float cellBreakup = coarseCell.z * 0.35 + (1.0 - coarseCell.z) * 0.65;

  // Distance-based LOD: skip fine voronoi layer for distant fragments
  float viewDist = length(vEyePosition.xyz - vPositionW);
  float fineLOD = 1.0 - smoothstep(30.0, 70.0, viewDist);

  float fineFoam = 0.0;
  if (fineLOD > 0.01) {
    vec2 fineValue = dveRotate2D(1.0471976) * value * 2.17 + vec2(3.17, -2.41);
    vec4 fineCell = dveVoronoiCellData(fineValue);
    float fineWidth = 0.002;
    float fineBorder = 1.0 - smoothstep(
      fineThreshold - fineWidth, fineThreshold + fineWidth, fineCell.y
    );
    float fineRidge = smoothstep(0.0, 0.35, fineCell.w) * 0.12;
    fineFoam = (fineBorder * (0.35 + fineCell.z * 0.2) + fineRidge) * fineLOD;
  }

  float foam = (
    coarseBorder * cellBreakup * 0.82 +
    coarseRidge * cellBreakup +
    fineFoam +
    coarseInterior
  );

  return clamp(foam, 0.0, 1.0);
}
`;

    if (shaderType === "vertex") {
      const code: { [pointName: string]: string } = {
        CUSTOM_VERTEX_DEFINITIONS: /* glsl */ `
#ifdef DVE_${this.name}
precision highp sampler2DArray;
uniform float dve_time;
${textures}
${attributes}
${varying}
${functions}
#endif
`,
        CUSTOM_VERTEX_MAIN_BEGIN: /* glsl */ `
#ifdef DVE_${this.name}
dveBaseUV = uv;
dveTextureLayer = dveGetTextureIndex(int(uint(textureIndex.x) & dveTextureIndexMask));
dveOverlayTextureIndex.x = dveGetTextureIndex(int((uint(textureIndex.x) >> dveSecondaryTextureIndex) & dveTextureIndexMask));
dveOverlayTextureIndex.y = dveGetTextureIndex(int(uint(textureIndex.y) & dveTextureIndexMask));
dveOverlayTextureIndex.z = dveGetTextureIndex(int((uint(textureIndex.y) >> dveSecondaryTextureIndex) & dveTextureIndexMask));
dveOverlayTextureIndex.w = dveGetTextureIndex(int(uint(textureIndex.z) & dveTextureIndexMask));
dveWorldContext = worldContext;
dveWaterFlowData = metadata;
dveShoreDistanceNormalized = phNormalized;
dveStableWaterSurfaceY = subdivAO;
dveDropHeight = dissolutionProximity;
dveFoamClassData = vec3(pullDirectionBias, pullStrength, subdivLevel);
dveVertexWaveHeight = 0.0;
dveVertexWaveCrest = 0.0;
// Phase 4 — pass surface derivatives to fragment
dveWaterGradient = vec2(waterGradientX, waterGradientZ);
dveWaterCurvature = waterCurvature;
#endif
`,
        CUSTOM_VERTEX_UPDATE_POSITION: /* glsl */ `
#ifdef DVE_${this.name}
if (dveStableWaterSurfaceY >= 0.0) {
  // ROOT CAUSE FIX — world-space domain for ALL noise/wave functions.
  // positionUpdated is in LOCAL mesh space. Each 8×8 section mesh has a
  // different world origin, so two boundary vertices at the same world XZ
  // would otherwise have different local XZ → different noise input → seam.
  // Multiply by world (model matrix uniform) once here and use dveWorldPos.xz
  // as the domain everywhere. NOTE: finalWorld is NOT yet defined at
  // CUSTOM_VERTEX_UPDATE_POSITION (it comes after instancesVertex include).
  vec3 dveWorldPos = (world * vec4(positionUpdated, 1.0)).xyz;
  vec3 dveContext = dveClampWorldContextValues(dveWorldContext);
  float dveShoreDistanceFactor = dveGetShoreDistanceNormalized(dveShoreDistanceNormalized);
  vec2 dveFlowDirection = dveGetFlowDirection(dveWaterFlowData);
  float dveFlowStrength = dveGetFlowStrength(dveWaterFlowData);
  float dveBoundaryFactor = dveGetApproxBoundaryFactor(dveContext.x, dveContext.y, dveShoreDistanceFactor, dveFlowStrength);
  vec2 dveVertexHybridUV = fract((dveWorldPos.xz - dve_water_hybrid_clip.xy) * dve_water_hybrid_clip.zw);
  float dveWorldInteraction = texture(dve_water_hybrid_debug, dveVertexHybridUV).b;
  vec3 dveWaterClassWeights = dveGetWaterClassWeights(dveGetPackedWaterClassValue(dveWaterFlowData));
  vec4 dveWaveDisplacement = dveGetVertexWaveDisplacement(dveWorldPos, dveFlowDirection, dveFlowStrength, dveShoreDistanceFactor, dveBoundaryFactor, dveWorldInteraction, dveWaterClassWeights);
  // Keep lateral drift restrained so duplicated boundary vertices remain visually
  // welded once local perturbation and continuous height are layered on top.
  dveWaveDisplacement.xz *= 0.35;
  dveVertexWaveHeight = dveWaveDisplacement.y;
  dveVertexWaveCrest = dveWaveDisplacement.w;
  positionUpdated.x += dveWaveDisplacement.x;
  positionUpdated.y += dveWaveDisplacement.y;
  positionUpdated.z += dveWaveDisplacement.z;

  // ─── Phase 4 + 8 — Curvature-modulated displacement with temporal coherence ─
  // Phase 4: high-curvature edge/transition zones get extra flow-aligned noise.
  // Phase 8: instead of applying the raw current-frame noise directly, blend it
  // with the same noise evaluated at the previous frame time (dve_time_prev).
  // Equivalent to mix(prevHeightTexture, currentHeight, 0.15) — eliminates
  // high-frequency flicker while preserving smooth wave animation.
  // Paso 4 — Non-linear curvature amplifier: pow(curvature, 1.5) concentrates
  // energy at high-curvature zones (shorelines, edges) while leaving flat open
  // water mostly untouched. Factor 1.8 gives strong non-linear breakup.
  float dveCurvatureBoost   = pow(clamp(dveWaterCurvature, 0.0, 1.0), 1.5);
  float dveFlowNoiseH       = dveWaterFlowNoise(dveWorldPos.xz, dveFlowDirection, dveFlowStrength, dve_time);
  float dveWaveH            = dveWaterWave(dveWorldPos.xz, dveFlowDirection, dveFlowStrength, dve_time);
  float dveFlowNoiseH_prev  = dveWaterFlowNoise(dveWorldPos.xz, dveFlowDirection, dveFlowStrength, dve_time_prev);
  float dveWaveH_prev       = dveWaterWave(dveWorldPos.xz, dveFlowDirection, dveFlowStrength, dve_time_prev);
  float dveCurrentH = dveFlowNoiseH + dveWaveH;
  float dvePrevH    = dveFlowNoiseH_prev + dveWaveH_prev;
  // ROOT CAUSE FIX: dveCurvatureBoost is a per-cell varying interpolated from
  // Catmull-Rom corner analysis. Adjacent cells have different curvature varying
  // values at shared boundary vertices → different amplitude scaling → animated
  // height seam. Use constant 1.0 multiplier. Curvature is still used for
  // normals and shading in the fragment path (not vertex height).
  positionUpdated.y += mix(dvePrevH, dveCurrentH, 0.15);

  // Paso 5 — Microdetail removed from vertex: frequency (wavelength ≈ 0.35 m)
  // cannot be represented by subdivision=2 vertices (Nyquist = 0.5 m spacing).
  // The two sin() calls are now saved per vertex. Fragment normal map handles
  // sub-cell surface detail without the aliasing cost.

  // Phase 5: GPU seam displacement.
  // Keep the pull constrained to real drop edges. Broad shoreline-weighted
  // displacement turns interpolated per-cell edge metadata into visible coastal
  // squares and can exaggerate stitches between neighboring cells.
  float dveOpenEdgeF = clamp(dveWorldContext.z, 0.0, 1.0);
  float dveDropEdgeMask = smoothstep(0.32, 0.72, clamp(dveDropHeight, 0.0, 1.0));
  float dveSeamWeight = smoothstep(0.0, 0.2, 1.0 - dveOpenEdgeF);
  positionUpdated.y -= dveDropEdgeMask * dveSeamWeight * dveDropHeight * 0.18;

  // \u2500\u2500\u2500 Phase 7 \u2014 Continuous GPU height field \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Replaces CPU catmullRom grid-cell height with a smooth GPU-derived field.
  // USE_GPU_WATER = true — GPU fully drives the surface height field.
  float dveGPUBlend = 1.0;
  float dveContinuousH = dveWaterContinuousHeight(dveWorldPos, dveFlowDirection, dveFlowStrength, dve_time);
  positionUpdated.y += dveContinuousH * dveGPUBlend;
}
#endif
`,
      };
      return code;
    }

    if (shaderType === "fragment") {
      const code: { [pointName: string]: string } = {
        CUSTOM_FRAGMENT_DEFINITIONS: /* glsl */ `
#ifdef DVE_${this.name}
precision highp sampler2DArray;
uniform float dve_time;
${textures}
${varying}
${functions}
${fragmentOnlyFunctions}

float dveGetLocalFluidEventSignal(vec4 hybridDynamicMask, vec4 hybridFlowMask) {
  return clamp(
    hybridDynamicMask.b * 0.36 +
    hybridFlowMask.a * 0.34 +
    hybridFlowMask.b * 0.22 +
    hybridDynamicMask.g * 0.08,
    0.0,
    1.0
  );
}

float dveGetLocalFluidThicknessTap(vec2 hybridUV) {
  vec4 hybridBaseMask = texture(dve_water_hybrid_base, hybridUV);
  vec4 hybridDynamicMask = texture(dve_water_hybrid_dynamic, hybridUV);
  vec4 hybridFlowMask = texture(dve_water_hybrid_flow, hybridUV);
  return clamp(
    hybridFlowMask.a * 0.52 +
    hybridDynamicMask.b * 0.2 +
    hybridBaseMask.a * 0.18 +
    hybridFlowMask.b * 0.1,
    0.0,
    1.0
  );
}

float dveGetLocalFluidThickness(vec2 hybridUV) {
  vec2 texel = dve_water_hybrid_clip.zw;
  float center = dveGetLocalFluidThicknessTap(hybridUV);
  float left = dveGetLocalFluidThicknessTap(fract(hybridUV - vec2(texel.x, 0.0)));
  float right = dveGetLocalFluidThicknessTap(fract(hybridUV + vec2(texel.x, 0.0)));
  float up = dveGetLocalFluidThicknessTap(fract(hybridUV - vec2(0.0, texel.y)));
  float down = dveGetLocalFluidThicknessTap(fract(hybridUV + vec2(0.0, texel.y)));
  return clamp(center * 0.42 + (left + right + up + down) * 0.145, 0.0, 1.0);
}

vec4 dveGetLocalFluidSurfaceData(vec2 hybridUV, float heightScale) {
  vec2 texel = dve_water_hybrid_clip.zw;
  float center = dveGetLocalFluidThicknessTap(hybridUV);
  float left = dveGetLocalFluidThicknessTap(fract(hybridUV - vec2(texel.x, 0.0)));
  float right = dveGetLocalFluidThicknessTap(fract(hybridUV + vec2(texel.x, 0.0)));
  float up = dveGetLocalFluidThicknessTap(fract(hybridUV - vec2(0.0, texel.y)));
  float down = dveGetLocalFluidThicknessTap(fract(hybridUV + vec2(0.0, texel.y)));
  float thickness = clamp(center * 0.42 + (left + right + up + down) * 0.145, 0.0, 1.0);
  float gradX = right - left;
  float gradZ = down - up;
  vec3 normal = normalize(vec3(-gradX * heightScale, 1.0, -gradZ * heightScale));
  return vec4(normal, thickness);
}

vec3 dveGetLocalFluidReconstructedNormal(vec2 hybridUV, float heightScale) {
  return dveGetLocalFluidSurfaceData(hybridUV, heightScale).xyz;
}

// ════════════════════════════════════════════════════════════════════════════
// Sprint 6 — Unified Patch + SSFR Composition
// ════════════════════════════════════════════════════════════════════════════
// The composition model treats Layer C (continuous patch mesh) and Layer E
// (SSFR local-fluid reconstruction) as two additive contributors to a single
// coherent water surface. Rather than a binary crossfade, each layer carries
// a spatial weight and the final surface is an energy-conserving blend.

// ── Spatial blend: how much of each layer is "present" at this fragment ────
float dveGetPatchBaseWeight(
  float largeBodySignal,
  float calmness,
  float openWaterFactor,
  float localFluidEventSignal
) {
  // Patch layer dominates in calm, open, large-body regions.
  // As local event energy rises, patch contribution recedes gracefully.
  float patchPresence = clamp(
    largeBodySignal * 0.42 +
    calmness * 0.28 +
    smoothstep(0.24, 0.82, openWaterFactor) * 0.3,
    0.0, 1.0
  );
  float eventSuppression = 1.0 - smoothstep(0.18, 0.78, localFluidEventSignal) * 0.62;
  return clamp(patchPresence * eventSuppression, 0.08, 1.0);
}

float dveGetSSFREventWeight(
  float localFluidEventSignal,
  float localFluidThickness,
  float dropFactor,
  float openWaterFactor
) {
  // SSFR layer rises with local event energy and thickness.
  // In open water it remains responsive but does not dominate.
  float energeticPresence = clamp(
    localFluidEventSignal * 0.64 +
    localFluidThickness * 0.24 +
    dropFactor * 0.12,
    0.0, 1.0
  );
  float openWaterDamping = mix(1.0, 0.52, smoothstep(0.42, 0.94, openWaterFactor));
  return clamp(energeticPresence * openWaterDamping, 0.0, 1.0);
}

// ── Unified composition blend ──────────────────────────────────────────────
// Returns (patchWeight, ssfrWeight) normalized so they sum to ≤ 1.
// The residual (1 - sum) is the "neither" zone where only base absorption
// colours apply with no layer-specific perturbation.
vec2 dveGetCompositionBlend(
  float patchBase,
  float ssfrEvent,
  float localFluidEventSignal
) {
  float total = patchBase + ssfrEvent;
  if (total <= 0.001) return vec2(0.0, 0.0);
  // Energy-conserving normalization: both layers present simultaneously
  // but their combined influence never exceeds 1.
  float normFactor = min(1.0, 1.0 / total);
  float pw = patchBase * normFactor;
  float sw = ssfrEvent * normFactor;
  // Continuity smoothing: prevent harsh boundary between layers.
  // When event energy is moderate (0.1–0.5), increase overlap zone.
  float overlapBoost = smoothstep(0.08, 0.32, localFluidEventSignal)
                     * (1.0 - smoothstep(0.52, 0.88, localFluidEventSignal));
  pw = clamp(pw + overlapBoost * 0.12, 0.0, 1.0);
  sw = clamp(sw + overlapBoost * 0.12, 0.0, 1.0);
  // Re-normalize after overlap boost
  float totalBoosted = pw + sw;
  if (totalBoosted > 1.0) {
    float renorm = 1.0 / totalBoosted;
    pw *= renorm;
    sw *= renorm;
  }
  return vec2(pw, sw);
}

// ── Depth/refraction handoff ───────────────────────────────────────────────
// Patch base provides calm deep-water refraction.
// Local-fluid events add dynamic refraction perturbation on top.
float dveGetUnifiedRefractionDarkening(
  float baseRefractionDarkening,
  float localFluidThickness,
  float ssfrWeight,
  float localFluidEventSignal
) {
  // Event-scale thickness increases refraction darkening in active zones.
  // The contribution is proportional to SSFR weight so calm water is unaffected.
  float eventRefraction = localFluidThickness * (0.18 + localFluidEventSignal * 0.22) * ssfrWeight;
  return clamp(baseRefractionDarkening + eventRefraction, 0.0, 0.65);
}

float dveGetUnifiedThicknessFactor(
  float baseThicknessFactor,
  float localFluidThickness,
  float ssfrWeight
) {
  // Blend screen-space depth thickness with local-fluid thickness.
  // SSFR thickness adds to the base rather than replacing it.
  return clamp(baseThicknessFactor + localFluidThickness * ssfrWeight * 0.38, 0.0, 1.0);
}

// ── Foam ownership split ───────────────────────────────────────────────────
// Body-scale foam: wave crest, open-water patterns, coastal band.
// Event-scale foam: impact, shoreline break, local-fluid pressure.
// The final foam is max(body, event) with energy-aware blending at the seam.
struct DVEFoamLayers {
  float bodyFoam;
  float eventFoam;
  float unified;
};

DVEFoamLayers dveGetFoamOwnership(
  float coastalFoam,
  float crestFoam,
  float intersectionFoam,
  float dropFoam,
  float localFluidThickness,
  float localFluidEventSignal,
  float impactFoamMask,
  float ssfrWeight,
  float patchWeight
) {
  DVEFoamLayers layers;
  // Body-scale: owned by continuous patch layer
  layers.bodyFoam = clamp(
    coastalFoam * 0.28 +
    crestFoam * 0.26 +
    intersectionFoam * 0.36,
    0.0, 1.0
  ) * max(patchWeight, 0.3);

  // Event-scale: owned by SSFR local-fluid layer
  layers.eventFoam = clamp(
    dropFoam * 0.72 +
    impactFoamMask * localFluidEventSignal * 0.52 +
    localFluidThickness * 0.18 * ssfrWeight,
    0.0, 1.0
  ) * max(ssfrWeight, 0.15);

  // Unified: energy-conserving max with soft overlap
  float rawMax = max(layers.bodyFoam, layers.eventFoam);
  float overlap = min(layers.bodyFoam, layers.eventFoam);
  layers.unified = clamp(rawMax + overlap * 0.22, 0.0, 1.0);
  return layers;
}

// ── Unified colour composition ─────────────────────────────────────────────
// Replaces the simple mix() approach of Sprint 5 with a layered blend
// where patch and SSFR each contribute their characteristic colour shift.
vec3 dveComposeWaterColor(
  vec3 baseColor,
  float patchWeight,
  float ssfrWeight,
  float localFluidThickness,
  float localFluidEventSignal,
  float foamUnified,
  float refractionDarkening
) {
  // Patch layer: calm, deep-water absorption tint
  vec3 patchTint = baseColor * (1.0 - refractionDarkening);

  // SSFR layer: energetic lift + surface brightening at event sites
  vec3 ssfrLift = mix(
    baseColor,
    vec3(0.78, 0.9, 1.0),
    0.14 + localFluidThickness * 0.22 + localFluidEventSignal * 0.12
  );

  // Blend both layers using composition weights
  vec3 composed = patchTint * patchWeight + ssfrLift * ssfrWeight;
  // Add residual base colour for zones where neither layer dominates
  float residual = max(0.0, 1.0 - patchWeight - ssfrWeight);
  composed += baseColor * (1.0 - refractionDarkening * 0.5) * residual;

  // Foam whitening applied uniformly across layers
  composed = mix(composed, vec3(0.95, 0.98, 1.0), foamUnified);

  return composed;
}

// ── Unified normal composition ─────────────────────────────────────────────
vec3 dveComposeWaterNormal(
  vec3 patchDetailNormal,
  vec3 ssfrReconstructedNormal,
  float patchWeight,
  float ssfrWeight,
  float localFluidThickness
) {
  // Energy-weighted blend: SSFR normals carry more influence as thickness rises.
  float ssfrNormalInfluence = ssfrWeight * (0.52 + localFluidThickness * 0.38);
  float patchNormalInfluence = patchWeight;
  float totalInfluence = patchNormalInfluence + ssfrNormalInfluence;
  if (totalInfluence <= 0.001) return patchDetailNormal;
  float normFactor = 1.0 / totalInfluence;
  return normalize(
    patchDetailNormal * (patchNormalInfluence * normFactor) +
    ssfrReconstructedNormal * (ssfrNormalInfluence * normFactor)
  );
}

// Legacy wrapper: kept for compatibility but now delegates to the unified stack.
float dveGetLocalFluidCompositeFactor(
  float localFluidEventSignal,
  float localFluidThickness,
  float openWaterFactor,
  float dropFactor
) {
  return dveGetSSFREventWeight(localFluidEventSignal, localFluidThickness, dropFactor, openWaterFactor);
}

vec2 dveGetNormalizedScreenUV() {
  return clamp(gl_FragCoord.xy / max(dve_screenSize, vec2(1.0)), vec2(0.001), vec2(0.999));
}

float dveGetScreenSpaceGlintMask(vec2 screenUV, vec2 flowDirection, float flowMagnitude, float pressure, float time) {
  vec2 safeFlowDirection = length(flowDirection) <= 0.0001 ? vec2(0.0, 1.0) : normalize(flowDirection);
  vec2 safeScreenSize = max(dve_screenSize, vec2(1.0));
  float aspect = safeScreenSize.x / safeScreenSize.y;
  vec2 domain = (screenUV - 0.5) * vec2(aspect, 1.0);
  vec2 lateral = dveGetPerpendicular(safeFlowDirection);
  // Compute noise breakup FIRST so it can perturb the sine/cosine phases
  float breakup0 = dveValueNoise(domain * (22.0 + flowMagnitude * 8.0) + safeFlowDirection * (time * 0.24 + pressure * 1.1));
  float breakup1 = dveValueNoise(domain * (35.0 + flowMagnitude * 5.0) + lateral * (time * 0.18 - pressure * 0.7) + vec2(11.3, -7.9));
  float bandA = sin(dot(domain, safeFlowDirection * 84.0 + lateral * 31.0) + time * (0.52 + flowMagnitude * 0.18) + pressure * 1.7 + breakup0 * 6.28);
  float bandB = cos(dot(domain, lateral * 127.0 - safeFlowDirection * 43.0) - time * (0.68 + pressure * 0.16) + flowMagnitude * 2.2 + breakup1 * 6.28);
  return clamp((bandA * 0.5 + 0.5) * 0.35 + (bandB * 0.5 + 0.5) * 0.28 + breakup0 * 0.22 + breakup1 * 0.15, 0.0, 1.0);
}

vec3 dveGetDerivedWaterSurfaceNormal(vec3 fallbackNormal) {
  if (dveStableWaterSurfaceY < 0.0) {
    return normalize(fallbackNormal);
  }
  // LOD: beyond 40 m the wave surface detail is not perceptible.
  float dveLODDist = length(vEyePosition.xyz - vPositionW);
  if (dveLODDist > 40.0) {
    return vec3(0.0, 1.0, 0.0);
  }
  // Use interpolated gradient varyings (waterGradientX/Z) to reconstruct the surface
  // normal. These are bilinearly interpolated across the full quad and are C0-continuous
  // through the triangle diagonal, eliminating the "crease line" artifact that dFdx/dFdy
  // produces because screen-space derivatives are discontinuous at triangle edges.
  vec3 gradientNormal = normalize(vec3(-dveWaterGradient.x, 1.0, -dveWaterGradient.y));
  // Fallback blend: if gradients are near-zero (flat still water) use Y-up directly.
  float gradientMagnitude = length(dveWaterGradient);
  float gradientConfidence = smoothstep(0.001, 0.02, gradientMagnitude);
  return normalize(mix(vec3(0.0, 1.0, 0.0), gradientNormal, gradientConfidence));
}
#endif
`,
        CUSTOM_FRAGMENT_UPDATE_ALBEDO: /* glsl */ `
#ifdef DVE_${this.name}
// Paso 7 — Continuous world-space UVs: no per-cell reset, domain-warped
// with flow gradient so texture is directional, not grid-aligned.
vec2 dveWorldUV = vPositionW.xz * 0.05;
dveWorldUV += dveGetWaterPatternWarp(dveWorldUV * 0.6 + vec2(dve_time * 0.03, -dve_time * 0.02)) * 0.2;
{
  // Paso 3 — Flow-gradient domain distortion.
  // ROOT CAUSE FIX: dveFlowDir2 * dve_time used as advection key is per-cell.
  // Adjacent patches with opposite flow directions slide the UV domain in
  // opposite directions → visible seam. Replace with a fixed world-space
  // advection vector (matching the vertex shader's fixed golden-ratio direction).
  vec2 dveFixedAdvUV = vec2(0.6180, 0.7861) * dve_time * 0.05;
  dveWorldUV += 0.15 * (dveValueNoise(dveWorldUV * 1.3 + dveFixedAdvUV) - 0.5);
}
vec4 dveLiquidSample = texture(dve_voxel, vec3(dveWorldUV, dveTextureLayer));
if (dveOverlayTextureIndex.x > 0.) {
  vec4 oRGB = texture(dve_voxel, vec3(dveWorldUV, dveOverlayTextureIndex.x));
  if (oRGB.a > 0.5) dveLiquidSample = oRGB;
}
vec3 dveWaterNormal = dveGetDerivedWaterSurfaceNormal(vNormalW);
vec3 dveWaterViewDir = dveGetWaterViewDirection(vEyePosition.xyz, vPositionW);
float dveWaterViewDot = dveGetWaterViewDot(dveWaterNormal, dveWaterViewDir);
float dveUnderwaterFactor = dveGetUnderwaterFactor(vEyePosition.xyz, dveStableWaterSurfaceY, vPositionW.y);
vec3 dveUnderwaterNormal = normalize(mix(dveWaterNormal, vec3(0.0, -1.0, 0.0), dveUnderwaterFactor * 0.96));
dveWaterNormal = dveUnderwaterNormal;
dveWaterViewDot = dveGetWaterViewDot(dveWaterNormal, dveWaterViewDir);
dveWaterViewDot = max(dveWaterViewDot, dveUnderwaterFactor * 0.18);
float dveWaterFacing = dveGetWaterFacing(dveWaterNormal);
vec3 dveContext = dveClampWorldContextValues(dveWorldContext);
float dveFillFactor = dveContext.x;
float dveShoreFactor = dveContext.y;
float dveShoreDistanceFactor = dveGetShoreDistanceNormalized(dveShoreDistanceNormalized);
float dveShorelineBand = dveGetShorelineBand(dveShoreFactor, dveShoreDistanceFactor);
float dveOpenWaterFactor = 1.0 - dveShoreFactor;
vec2 dveFlowDirection = dveGetFlowDirection(dveWaterFlowData);
float dveFlowStrength = dveGetFlowStrength(dveWaterFlowData);
// ROOT CAUSE FIX: dveFlowDirection is a per-cell varying. At boundaries between
// patches with different flow data the UV domain for foam/patterns jumps visibly.
// Blend the per-cell direction toward a world-space fbm-derived direction so both
// sides of a cell boundary sample a common world-space offset, smoothing the seam.
{
  vec2 dveFlowSmooth = vec2(
    dveValueNoise(vPositionW.xz * 0.06 + vec2(0.0,   dve_time * 0.012)),
    dveValueNoise(vPositionW.xz * 0.06 + vec2(47.3,  dve_time * 0.012))
  ) * 2.0 - 1.0;
  float dveFlowLen = length(dveFlowDirection);
  dveFlowDirection = dveFlowLen > 0.001
    ? normalize(dveFlowDirection + dveFlowSmooth * 0.25) * dveFlowLen
    : dveFlowSmooth * 0.1;
}
float dveBoundaryFactor = dveGetApproxBoundaryFactor(dveFillFactor, dveShoreFactor, dveShoreDistanceFactor, dveFlowStrength);
float dveTurbidity = dveGetWaterTurbidity(dveWaterFlowData);
vec3 dveWaterClassWeights = dveGetWaterClassWeights(dveGetPackedWaterClassValue(dveWaterFlowData));
float dveWaveAttenuation = dveGetWaveResponse(dveShoreFactor, dveBoundaryFactor, dveShoreDistanceFactor, dveWaterClassWeights);
float dveBankWaveDamping = dveGetBankWaveDamping(dveShorelineBand, dveShoreDistanceFactor);
float dveFresnel = dveGetWaterFresnelResponse(dveWaterViewDot);
float dveUnderwaterFresnel = mix(dveFresnel, dveFresnel * 0.12, dveUnderwaterFactor);
float dveBaseMacroVariation = dveGetLargeScaleWaterVariation(vPositionW.xz);
vec2 dveBasePatternWarp = dveGetWaterPatternWarp(vPositionW.xz) * 0.38;
vec2 dveScreenUV = dveGetNormalizedScreenUV();
vec2 dveRefractOffset = vec2(dveWaterNormal.x, -dveWaterNormal.z) * 0.012 * (1.0 - dveWaterViewDot);
float dveSceneDepthRaw = texture(dve_depthTexture, clamp(dveScreenUV + dveRefractOffset, vec2(0.001), vec2(0.999))).r;
float dveWaterDepthRaw = gl_FragCoord.z;
float dveSceneDepthLinear = dveLinearizeDepth(dveSceneDepthRaw, dve_cameraNearFar);
float dveWaterDepthLinear = dveLinearizeDepth(dveWaterDepthRaw, dve_cameraNearFar);
float dveWaterThickness = max(dveSceneDepthLinear - dveWaterDepthLinear, 0.0);
float dveThicknessFactor = clamp(dveWaterThickness * 0.1, 0.0, 1.0);
float dveWaterDepthFactor = clamp(max((64.0 - vPositionW.y) * 0.024, dveThicknessFactor * 1.05), 0.0, 1.0);
float dveShallowClarity = 1.0 - smoothstep(
  DVE_SHALLOW_CLARITY_START,
  DVE_SHALLOW_CLARITY_END,
  dveThicknessFactor
);
    float dveRefractionDarkening = (1.0 - dveWaterViewDot) * (0.08 + dveThicknessFactor * 0.24 + dveTurbidity * 0.05) * mix(1.0, 0.9, dveUnderwaterFactor);
float dveDropFactor = clamp(dveDropHeight, 0.0, 1.0);
float dveWaveCrestFactor = clamp(dveVertexWaveCrest, 0.0, 1.0);
vec2 dveHybridUV = fract((vPositionW.xz - dve_water_hybrid_clip.xy) * dve_water_hybrid_clip.zw + dveBasePatternWarp * 0.0015);
vec4 dveHybridBaseMask = texture(dve_water_hybrid_base, dveHybridUV);
vec4 dveHybridDynamicMask = texture(dve_water_hybrid_dynamic, dveHybridUV);
vec4 dveHybridFlowMask = texture(dve_water_hybrid_flow, dveHybridUV);
vec4 dveHybridDebugMask = texture(dve_water_hybrid_debug, dveHybridUV);
float dveLocalFluidEventSignal = dveGetLocalFluidEventSignal(dveHybridDynamicMask, dveHybridFlowMask);
vec4 dveLocalFluidSurface = dveGetLocalFluidSurfaceData(dveHybridUV, 24.0);
float dveLocalFluidThickness = dveLocalFluidSurface.w;
vec3 dveLocalFluidNormal = dveLocalFluidSurface.xyz;
float dveLargeBodySignal = dveGetLargeBodySignal(dveOpenWaterFactor, dveHybridBaseMask);
float dvePatchFlowSignal = dveGetPatchFlowSignal(dveHybridDynamicMask);
// Sprint 6 — Unified Patch + SSFR composition weights
float dvePatchWeight = dveGetPatchBaseWeight(
  dveLargeBodySignal,
  clamp(dveHybridBaseMask.b, 0.0, 1.0),
  dveOpenWaterFactor,
  dveLocalFluidEventSignal
);
float dveSSFRWeight = dveGetSSFREventWeight(
  dveLocalFluidEventSignal,
  dveLocalFluidThickness,
  dveDropFactor,
  dveOpenWaterFactor
);
vec2 dveCompWeights = dveGetCompositionBlend(dvePatchWeight, dveSSFRWeight, dveLocalFluidEventSignal);
float dveCompPatch = dveCompWeights.x;
float dveCompSSFR = dveCompWeights.y;
float dveDebugMode = dve_water_debug_params.x;
float dveDebugOpacity = clamp(dve_water_debug_params.y, 0.0, 1.0);
float dveRawLargeBody = clamp(dveHybridDebugMask.r, 0.0, 1.0);
float dveRawShore = clamp(dveHybridDebugMask.g, 0.0, 1.0);
float dveRawInteraction = clamp(dveHybridDebugMask.b, 0.0, 1.0);
float dveRawPresence = clamp(dveHybridDebugMask.a, 0.0, 1.0);
float dveMacroVariation = dveGetLargeBodyMacroVariation(dveBaseMacroVariation, vPositionW.xz, dveLargeBodySignal);
vec2 dvePatternWarp = dveGetLargeBodyPatternWarp(dveBasePatternWarp, dveLargeBodySignal);
float dveHybridOpenWaterSuppression = 1.0 - smoothstep(0.16, 0.68, dveOpenWaterFactor);
float dveHybridInfluence = clamp(dveHybridOpenWaterSuppression + dveDropFactor * 0.9, 0.0, 1.0);
float dveHybridFoamBoost = clamp(dveHybridBaseMask.r + dveHybridDynamicMask.r * 0.9, 0.0, 1.0) * dveHybridInfluence;
float dveHybridFlowBoost = clamp(dveHybridBaseMask.g + dveHybridDynamicMask.g * 0.45, 0.0, 1.0) * dveHybridInfluence;
float dveHybridCalmness = mix(1.0, clamp(mix(dveHybridBaseMask.b, 1.0 - dveHybridDynamicMask.b, 0.2), 0.0, 1.0), dveHybridInfluence);
float dveHybridFill = mix(dveFillFactor, clamp(dveHybridBaseMask.a, 0.0, 1.0), dveHybridInfluence * 0.15);
vec2 dveHybridFlowRaw = (dveHybridFlowMask.rg * 2.0 - 1.0) * dveHybridInfluence;
vec2 dveHybridFlowVector = length(dveHybridFlowRaw) > 0.0001 ? normalize(dveHybridFlowRaw) : dveFlowDirection;
float dveHybridFlowMagnitude = clamp(dveHybridFlowMask.b, 0.0, 1.0) * dveHybridInfluence;
float dveHybridPressure = clamp(dveHybridFlowMask.a, 0.0, 1.0) * dveHybridInfluence;
float dveLargeBodySteering = dveGetPatchAwareSteering(
  dveHybridInfluence,
  dveLargeBodySignal,
  dvePatchFlowSignal,
  0.42,
  0.58
);
vec2 dveResolvedFlowDirection = dveGetPatchAwareFlowDirection(
  dveFlowDirection,
  dveHybridFlowVector,
  dveHybridInfluence,
  dveLargeBodySignal,
  dvePatchFlowSignal,
  0.42,
  0.58
);
float dveScreenGlint = dveGetScreenSpaceGlintMask(dveScreenUV, dveResolvedFlowDirection, dveHybridFlowMagnitude, dveHybridPressure, dve_time);
vec2 dveFoamVoronoiUV = (
  vPositionW.xz * mix(0.16, 0.24, dveWaveAttenuation) +
  dvePatternWarp * 0.42 +
  dveGetFoamMotion(dve_time, dveWaveAttenuation) * (3.1 + dveHybridFlowMagnitude * 2.4) +
  dveResolvedFlowDirection * (0.24 + dveHybridFlowBoost * 0.22 + dveHybridFlowMagnitude * 0.3 + dvePatchFlowSignal * 0.18) +
  dveHybridFlowRaw * 0.65
);
vec2 dveShoreFoamUV = (
  vPositionW.xz * mix(0.19, 0.27, dveWaveAttenuation) +
  dvePatternWarp * 0.58 +
  dveGetShoreFoamMotion(dve_time, dveWaveAttenuation) * (3.5 + dveHybridPressure * 2.6) +
  dveResolvedFlowDirection * (0.18 + dveHybridPressure * 0.24) +
  dveHybridFlowRaw * 0.42
);
vec2 dveImpactFoamUV = (
  vPositionW.xz * mix(0.24, 0.35, clamp(dveWaveAttenuation + dveDropFactor * 0.25, 0.0, 1.0)) +
  dvePatternWarp * 0.84 +
  dveGetImpactFoamMotion(dve_time, dveWaveAttenuation, dveDropFactor) * (4.2 + dveHybridPressure * 3.1) +
  dveResolvedFlowDirection * (0.28 + dveDropFactor * 0.16 + dveHybridFlowMagnitude * 0.22) +
  dveHybridFlowRaw * (0.58 + dveHybridPressure * 0.36)
);
vec3 dveFoamClassMask = clamp(dveFoamClassData, vec3(0.0), vec3(1.0));
vec2 dveFoamPatternDirectionRaw = mix(dveResolvedFlowDirection, dveHybridFlowVector, 0.35 + dveHybridPressure * 0.15);
vec2 dveFoamPatternDirection = length(dveFoamPatternDirectionRaw) > 0.0001 ? normalize(dveFoamPatternDirectionRaw) : vec2(0.0, 1.0);
float dveBreakerSignal = clamp(
  dveShorelineBand * 0.52 +
  dveHybridPressure * 0.18 +
  dveFoamClassMask.y * 0.18 +
  dveDropFactor * 0.12,
  0.0,
  1.0
);
float dveFoamMask = dveGetTextureFoamMask(
  dveFoamVoronoiUV,
  dveFoamPatternDirection,
  0.28 + dveWaveAttenuation * 0.24,
  0.57
);
float dveShoreFoamMask = dveGetBreakerFoamMask(
  dveShoreFoamUV,
  dveFoamPatternDirection,
  dveBreakerSignal,
  0.54
);
float dveImpactFoamMask = max(
  dveGetTextureFoamMask(
    dveImpactFoamUV,
    dveFoamPatternDirection,
    0.46 + dveDropFactor * 0.24 + dveHybridPressure * 0.18,
    0.55
  ),
  dveGetBreakerFoamMask(
    dveImpactFoamUV * 1.18 + dveHybridFlowRaw * 0.12,
    dveFoamPatternDirection,
    clamp(dveDropFactor * 0.58 + dveHybridPressure * 0.42, 0.0, 1.0),
    0.58
  ) * (0.46 + dveDropFactor * 0.34)
);
float dveScreenFoamLift = dveScreenGlint * smoothstep(0.78, 0.16, dveWaterViewDot) * (0.04 + dveHybridPressure * 0.08 + dveHybridFlowMagnitude * 0.05);
dveFoamMask = clamp(dveFoamMask + dveScreenFoamLift * (0.32 + dveWaveAttenuation * 0.08), 0.0, 1.0);
dveShoreFoamMask = clamp(dveShoreFoamMask + dveScreenFoamLift * (0.18 + dveShorelineBand * 0.12), 0.0, 1.0);
dveImpactFoamMask = clamp(dveImpactFoamMask + dveScreenFoamLift * (0.22 + dveDropFactor * 0.2), 0.0, 1.0);
dveImpactFoamMask = clamp(dveImpactFoamMask + dveCompSSFR * (0.16 + dveLocalFluidThickness * 0.28), 0.0, 1.0);
dveFoamMask = clamp(mix(dveFoamMask, max(dveFoamMask, dveHybridFoamBoost + dveHybridPressure * 0.18), 0.58), 0.0, 1.0);
dveShoreFoamMask = clamp(mix(dveShoreFoamMask, max(dveShoreFoamMask, dveHybridFoamBoost + dveHybridPressure * 0.28), 0.46), 0.0, 1.0);
dveImpactFoamMask = clamp(mix(dveImpactFoamMask, max(dveImpactFoamMask, dveHybridFoamBoost * 0.82 + dveHybridFlowBoost * 0.18 + dveHybridPressure * 0.34), 0.44), 0.0, 1.0);
float dveSoftFillFactor = dveGetSoftWaterContextValue(mix(dveFillFactor, dveHybridFill, 0.2), dveMacroVariation, max(dveFoamMask, dveImpactFoamMask), 0.16);
float dveSoftBoundaryFactor = dveGetSoftWaterContextValue(mix(dveBoundaryFactor, 1.0 - dveHybridCalmness, 0.18), dveMacroVariation, max(dveShoreFoamMask, dveImpactFoamMask), 0.24);
float dveFoamBand = smoothstep(DVE_FOAM_BAND_START, DVE_FOAM_BAND_END, dveShorelineBand) * (
  1.0 - smoothstep(DVE_FOAM_BAND_FADE_START, DVE_FOAM_BAND_FADE_END, dveShoreDistanceFactor)
);
float dveOrganicFoamBand = clamp(dveFoamBand * (0.84 + dveMacroVariation * 0.24), 0.0, 1.0);
float dveSoftShorelineBand = clamp(mix(dveShorelineBand, dveOrganicFoamBand, 0.62), 0.0, 1.0);
float dveFoamEdge = smoothstep(DVE_FOAM_EDGE_START, DVE_FOAM_EDGE_END, 1.0 - dveSoftBoundaryFactor);
float dveCoastalFoam = dveShoreFoamMask * clamp((dveOrganicFoamBand * 0.98 + dveFoamEdge * 0.28 + dveMacroVariation * 0.06 + dveFoamClassMask.y * 0.34 + dveHybridFoamBoost * 0.3) * dveGetClassFoamResponse(dveWaterClassWeights), 0.0, 1.0) * mix(1.0, 0.64, 1.0 - dveBankWaveDamping);
// Intersection foam: screen-space depth-based froth exactly where water meets terrain.
// Uses dveThicknessFactor (depth difference) to mask voxel-grid blockiness at edges.
float dveGrazingEdgeFoam = smoothstep(0.72, 0.18, dveWaterViewDot) * (1.0 - dveSoftBoundaryFactor) * (0.28 + dveOrganicFoamBand * 0.42 + dveDropFactor * 0.74 + dveImpactFoamMask * 0.35);
float dveIntersectionFoam = max(
  smoothstep(0.28, 0.0, dveThicknessFactor) * (0.48 + dveImpactFoamMask * 0.72 + dveFoamClassMask.z * 0.82 + dveDropFactor * 0.28),
  dveGrazingEdgeFoam
);
float dveCrestFoam = max(
  dveFoamClassMask.x * (0.3 + max(dveFoamMask, dveImpactFoamMask * 0.55) * 0.56 + dveHybridFlowBoost * 0.12) * (0.36 + dveWaveAttenuation * 0.64 + abs(dveVertexWaveHeight) * 2.0),
  dveWaveCrestFactor * (0.22 + dveFoamMask * 0.32 + dveImpactFoamMask * 0.18 + dveHybridFoamBoost * 0.16)
);
float dveDropFoam = dveDropFactor * (0.42 + dveFoamClassMask.z * 0.88) * (0.3 + dveImpactFoamMask * 0.84 + dveFoamMask * 0.12);
float dveOrganicShoreline = clamp(dveSoftShorelineBand * (0.82 + dveMacroVariation * 0.14) + dveShoreFoamMask * 0.08, 0.0, 1.0);
float dveShallowBreakup = clamp(dveShallowClarity * 0.36 + dveOrganicShoreline * 0.22 + dveMacroVariation * 0.18 + (1.0 - dveSoftFillFactor) * 0.035 + dveHybridPressure * 0.16 + dveHybridFlowMagnitude * 0.08, 0.0, 1.0);
vec3 dveShallowColor = vec3(0.34, 0.74, 0.95);
vec3 dveMidColor = vec3(0.1, 0.34, 0.62);
vec3 dveDeepColor = vec3(0.02, 0.09, 0.24);
  vec3 dveTurbidShallowColor = vec3(0.36, 0.66, 0.76);
  vec3 dveTurbidMidColor = vec3(0.11, 0.29, 0.41);
  vec3 dveTurbidDeepColor = vec3(0.03, 0.1, 0.19);
vec3 dveReflectionColor = vec3(0.8, 0.9, 1.0);
float dveDepthToDeep = clamp(dveWaterDepthFactor * 0.9 + dveOpenWaterFactor * 0.24 - dveShallowClarity * 0.08, 0.0, 1.0);
vec3 dveAbsorptionColor = mix(dveShallowColor, dveMidColor, smoothstep(0.0, 0.45, dveDepthToDeep));
dveAbsorptionColor = mix(dveAbsorptionColor, dveDeepColor, smoothstep(0.38, 1.0, dveDepthToDeep));
vec3 dveTurbidAbsorptionColor = mix(dveTurbidShallowColor, dveTurbidMidColor, smoothstep(0.0, 0.45, dveDepthToDeep));
dveTurbidAbsorptionColor = mix(dveTurbidAbsorptionColor, dveTurbidDeepColor, smoothstep(0.38, 1.0, dveDepthToDeep));
  float dveMurkyDepth = clamp(dveTurbidity * (0.18 + dveThicknessFactor * 0.16 + dveWaterDepthFactor * 0.08), 0.0, 0.45);
dveAbsorptionColor = mix(dveAbsorptionColor, dveTurbidAbsorptionColor, dveMurkyDepth);
vec3 dveClassTint = dveGetClassTint(dveWaterClassWeights);
float dveClassCalmness = dveGetClassCalmness(dveWaterClassWeights);
float dveLargeBodyHighlightCoherence = dveLargeBodySignal * clamp(dveHybridCalmness * 0.72 + dveWaterFacing * 0.18 + dveOpenWaterFactor * 0.1, 0.0, 1.0);
vec3 dveTransmissionColor = mix(dveAbsorptionColor, vec3(0.58, 0.89, 1.0), dveOrganicShoreline * 0.1 + dveWaterFacing * 0.06 + dveShallowClarity * (0.22 - dveTurbidity * 0.1) + dveMacroVariation * 0.06 + dveSoftFillFactor * 0.015 + dveLargeBodyHighlightCoherence * 0.035);
vec3 dveTransmissionBase = dveTransmissionColor;
  dveTransmissionColor = dveTransmissionBase * mix(dveClassTint, vec3(0.98, 1.0, 1.03), dveTurbidity * 0.2);
vec3 dveShallowBreakupTint = mix(vec3(0.8, 0.95, 1.01), vec3(1.06, 1.1, 1.15), dveFoamMask);
vec3 dveShallowBreakupColor = dveTransmissionColor * dveShallowBreakupTint;
vec3 dveReflectiveLift = mix(dveReflectionColor, vec3(0.96, 0.98, 1.0), dveUnderwaterFresnel * 0.76 + dveSoftFillFactor * 0.03 + dveWaterClassWeights.z * 0.06);
vec3 dveLiquidColor = mix(dveTransmissionColor, dveReflectiveLift, 0.11 + dveUnderwaterFresnel * 0.42 + dveWaterClassWeights.z * 0.08 - dveWaterClassWeights.x * 0.06 - dveUnderwaterFactor * 0.09);
dveLiquidColor = mix(dveLiquidColor, dveShallowBreakupColor, dveShallowBreakup * 0.22);
// Sprint 6 — Foam ownership split: body-scale vs event-scale
DVEFoamLayers dveFoamLayers = dveGetFoamOwnership(
  dveCoastalFoam,
  dveCrestFoam,
  dveIntersectionFoam,
  dveDropFoam,
  dveLocalFluidThickness,
  dveLocalFluidEventSignal,
  dveImpactFoamMask,
  dveCompSSFR,
  dveCompPatch
);
// Sprint 6 — Unified depth/refraction handoff
float dveUnifiedRefraction = dveGetUnifiedRefractionDarkening(
  dveRefractionDarkening,
  dveLocalFluidThickness,
  dveCompSSFR,
  dveLocalFluidEventSignal
);
float dveUnifiedThickness = dveGetUnifiedThicknessFactor(dveThicknessFactor, dveLocalFluidThickness, dveCompSSFR);
// Sprint 6 — Unified colour composition: layered blend instead of binary crossfade
dveLiquidColor = dveComposeWaterColor(
  dveLiquidColor,
  dveCompPatch,
  dveCompSSFR,
  dveLocalFluidThickness,
  dveLocalFluidEventSignal,
  dveFoamLayers.unified + dveHybridPressure * 0.16,
  dveUnifiedRefraction
);
dveLiquidColor = mix(dveLiquidColor, vec3(0.83, 0.93, 1.0), dveWaveCrestFactor * (0.1 + dveWaveAttenuation * 0.12));
dveLiquidColor = mix(dveLiquidColor, vec3(0.92, 0.97, 1.0), dveScreenGlint * (0.025 + dveUnderwaterFresnel * 0.055 + dveHybridPressure * 0.035 + dveLargeBodyHighlightCoherence * 0.028));
dveLiquidColor = mix(dveLiquidColor, dveLiquidColor * vec3(0.985, 0.995, 1.01), dveMacroVariation * 0.08);
dveLiquidColor = mix(dveLiquidColor, dveLiquidColor * vec3(0.978, 0.989, 1.0), (1.0 - dveSoftFillFactor) * 0.03);
dveLiquidColor = mix(dveLiquidColor, dveLiquidColor * vec3(0.98, 0.985, 0.97), dveTurbidity * (0.08 + dveWaterDepthFactor * 0.06));
dveLiquidColor = mix(dveLiquidColor, dveLiquidColor * vec3(1.015, 1.02, 1.03), max(dveWaveAttenuation * 0.04 + dveFoamMask * 0.018 - dveClassCalmness - dveTurbidity * 0.035, 0.0));
dveLiquidColor = mix(dveLiquidColor, dveLiquidColor * vec3(0.972, 0.989, 1.02), dveSoftBoundaryFactor * 0.045);
dveLiquidColor = mix(dveLiquidColor, dveLiquidColor * vec3(1.07, 1.1, 1.16), dveShallowBreakup * (0.18 + dveBankWaveDamping * 0.08));
dveLiquidColor *= mix(vec3(0.9, 0.94, 0.98), vec3(1.0), dveWaterFacing * 0.6 + dveUnderwaterFresnel * 0.2);
if (dveDebugMode > 0.5) {
  vec3 dveDebugColor = vec3(0.0);
  if (dveDebugMode < 1.5) {
    dveDebugColor = dveGetOwnershipDebugColor(
      dveRawLargeBody,
      dvePatchFlowSignal,
      dveLocalFluidEventSignal,
      dveShoreFactor,
      dveOpenWaterFactor,
      dveCompPatch,
      dveCompSSFR
    );
  } else if (dveDebugMode < 2.5) {
    dveDebugColor = vec3(dveCompPatch, dveCompSSFR, clamp(1.0 - (dveCompPatch + dveCompSSFR), 0.0, 1.0));
  } else if (dveDebugMode < 3.5) {
    dveDebugColor = clamp(dveHybridBaseMask.rgb, 0.0, 1.0);
  } else if (dveDebugMode < 4.5) {
    dveDebugColor = clamp(vec3(dveHybridDynamicMask.r, dveHybridDynamicMask.g, dveHybridDynamicMask.a), 0.0, 1.0);
  } else if (dveDebugMode < 5.5) {
    dveDebugColor = clamp(vec3(dveHybridFlowMask.rg, dveHybridFlowMask.b), 0.0, 1.0);
  } else if (dveDebugMode < 6.5) {
    dveDebugColor = vec3(dveRawLargeBody, dveRawShore, dveRawInteraction);
  } else if (dveDebugMode < 7.5) {
    dveDebugColor = vec3(dveFillFactor, dveBoundaryFactor, dveShoreFactor);
  } else {
    dveDebugColor = dveGetConflictDebugColor(
      dveRawLargeBody,
      dvePatchFlowSignal,
      dveRawShore,
      dveShoreFactor,
      dveRawInteraction,
      dveCompPatch,
      dveCompSSFR,
      dveLocalFluidEventSignal
    );
  }
  if (dveDebugMode > 2.5 && dveDebugMode < 6.5) {
    float dveDebugTexelGrid = dveGetDebugGridMask(dveHybridUV, 256.0, 0.035);
    dveDebugColor = mix(dveDebugColor, vec3(1.0), dveDebugTexelGrid * 0.06);
  }
  dveLiquidColor = mix(dveLiquidColor, dveDebugColor, dveDebugOpacity);
}
surfaceAlbedo = toLinearSpace(dveLiquidColor);
alpha = 1.0;
#endif
`,
        CUSTOM_FRAGMENT_UPDATE_MICROSURFACE: /* glsl */ `
#ifdef DVE_${this.name}
vec3 dveWaterNormal = dveGetDerivedWaterSurfaceNormal(vNormalW);
vec3 dveWaterViewDir = dveGetWaterViewDirection(vEyePosition.xyz, vPositionW);
float dveWaterViewDot = dveGetWaterViewDot(dveWaterNormal, dveWaterViewDir);
float dveUnderwaterFactor = dveGetUnderwaterFactor(vEyePosition.xyz, dveStableWaterSurfaceY, vPositionW.y);
vec3 dveUnderwaterNormal = normalize(mix(dveWaterNormal, vec3(0.0, -1.0, 0.0), dveUnderwaterFactor * 0.96));
dveWaterNormal = dveUnderwaterNormal;
dveWaterViewDot = dveGetWaterViewDot(dveWaterNormal, dveWaterViewDir);
dveWaterViewDot = max(dveWaterViewDot, dveUnderwaterFactor * 0.18);
vec3 dveContext = dveClampWorldContextValues(dveWorldContext);
float dveFillFactor = dveContext.x;
float dveShoreFactor = dveContext.y;
float dveShoreDistanceFactor = dveGetShoreDistanceNormalized(dveShoreDistanceNormalized);
float dveShorelineBand = dveGetShorelineBand(dveShoreFactor, dveShoreDistanceFactor);
float dveOpenWaterFactor = 1.0 - dveShoreFactor;
float dveFlowStrength = dveGetFlowStrength(dveWaterFlowData);
float dveBoundaryFactor = dveGetApproxBoundaryFactor(dveFillFactor, dveShoreFactor, dveShoreDistanceFactor, dveFlowStrength);
float dveTurbidity = dveGetWaterTurbidity(dveWaterFlowData);
vec3 dveWaterClassWeights = dveGetWaterClassWeights(dveGetPackedWaterClassValue(dveWaterFlowData));
vec3 dveClassSurfacePreset = dveGetClassSurfacePreset(dveWaterClassWeights);
float dveWaveAttenuation = dveGetWaveResponse(dveShoreFactor, dveBoundaryFactor, dveShoreDistanceFactor, dveWaterClassWeights);
float dveFresnel = dveGetWaterFresnelResponse(dveWaterViewDot);
float dveUnderwaterFresnel = mix(dveFresnel, dveFresnel * 0.1, dveUnderwaterFactor);
float dveBaseMacroVariation = dveGetLargeScaleWaterVariation(vPositionW.xz);
vec2 dveBaseGlossWarp = dveGetWaterPatternWarp(vPositionW.xz) * 0.25;
vec2 dveScreenUV = dveGetNormalizedScreenUV();
vec2 dveHybridUV = fract((vPositionW.xz - dve_water_hybrid_clip.xy) * dve_water_hybrid_clip.zw + dveBaseGlossWarp * 0.0012);
vec4 dveHybridBaseMask = texture(dve_water_hybrid_base, dveHybridUV);
vec4 dveHybridDynamicMask = texture(dve_water_hybrid_dynamic, dveHybridUV);
vec4 dveHybridFlowMask = texture(dve_water_hybrid_flow, dveHybridUV);
float dveLocalFluidEventSignal = dveGetLocalFluidEventSignal(dveHybridDynamicMask, dveHybridFlowMask);
float dveLocalFluidThickness = dveGetLocalFluidSurfaceData(dveHybridUV, 24.0).w;
float dveLargeBodySignal = dveGetLargeBodySignal(dveOpenWaterFactor, dveHybridBaseMask);
float dvePatchFlowSignal = dveGetPatchFlowSignal(dveHybridDynamicMask);
// Sprint 6 — Unified composition weights for microsurface
float dveMicroPatchW = dveGetPatchBaseWeight(dveLargeBodySignal, clamp(dveHybridBaseMask.b, 0.0, 1.0), dveOpenWaterFactor, dveLocalFluidEventSignal);
float dveMicroSSFRW = dveGetSSFREventWeight(dveLocalFluidEventSignal, dveLocalFluidThickness, clamp(dveDropHeight, 0.0, 1.0), dveOpenWaterFactor);
vec2 dveMicroCompW = dveGetCompositionBlend(dveMicroPatchW, dveMicroSSFRW, dveLocalFluidEventSignal);
float dveMacroVariation = dveGetLargeBodyMacroVariation(dveBaseMacroVariation, vPositionW.xz, dveLargeBodySignal);
vec2 dveGlossWarp = dveGetLargeBodyPatternWarp(dveBaseGlossWarp, dveLargeBodySignal);
float dveHybridInfluence = clamp(1.0 - smoothstep(0.16, 0.68, dveOpenWaterFactor) + clamp(dveDropHeight, 0.0, 1.0) * 0.9, 0.0, 1.0);
vec2 dveHybridFlowRaw = (dveHybridFlowMask.rg * 2.0 - 1.0) * dveHybridInfluence;
vec2 dveHybridFlowVector = length(dveHybridFlowRaw) > 0.0001 ? normalize(dveHybridFlowRaw) : vec2(0.0, 1.0);
float dveHybridFlowMagnitude = clamp(dveHybridFlowMask.b, 0.0, 1.0) * dveHybridInfluence;
float dveHybridPressure = clamp(dveHybridFlowMask.a, 0.0, 1.0) * dveHybridInfluence;
float dveScreenGlint = dveGetScreenSpaceGlintMask(dveScreenUV, dveHybridFlowVector, dveHybridFlowMagnitude, dveHybridPressure, dve_time);
// Cheap context mask: value noise instead of full voronoi (saves ~36 hash calls)
float dveContextMask = clamp(
  dveValueNoise(vPositionW.xz * 0.12 + dveGlossWarp * 0.35 + dveGetFoamMotion(dve_time, dveWaveAttenuation) * 2.1 + dveHybridFlowMask.rg * 3.2) * 0.7 +
  dveValueNoise(dveRotate2D(1.047) * vPositionW.xz * 0.22 + vec2(dve_time * 0.04, -dve_time * 0.03)) * 0.3 - 0.15,
  0.0, 1.0
);
float dveSoftFillFactor = dveGetSoftWaterContextValue(dveFillFactor, dveMacroVariation, dveContextMask, 0.14);
float dveSoftBoundaryFactor = dveGetSoftWaterContextValue(dveBoundaryFactor, dveMacroVariation, dveContextMask, 0.18);
float dveSoftShorelineBand = clamp(mix(dveShorelineBand, dveShorelineBand * (0.82 + dveMacroVariation * 0.16) + dveContextMask * 0.04, 0.58), 0.0, 1.0);
float dveMotionGloss = dveValueNoise(vPositionW.xz * 0.022 + vec2(dve_time * 0.031, -dve_time * 0.019));
float dveClassGlossBias = dveWaterClassWeights.y * 0.05 - dveWaterClassWeights.x * 0.04 + dveWaterClassWeights.z * 0.03;
float dveLocalShimmer = dveGetLocalShimmerPattern(vPositionW.xz, vec2(0.707, 0.707), dve_time);
float dveAperiodicSeed = dveHash12(vPositionW.xz * vec2(0.071, 0.123));
float dveDetailFade = dveGetDistanceStableDetailFade(vPositionW, vEyePosition.xyz, dveWaveAttenuation);
float dveAperiodicDetail = dveValueNoise(
  dveGetAperiodicDetailUV(
    vPositionW.xz + (dveHybridFlowMask.rg * 2.0 - 1.0) * mix(12.0, 24.0, dveGetPatchAwareSignal(dveLargeBodySignal, dvePatchFlowSignal)),
    mix(vec2(0.0, 1.0), dveHybridFlowVector, max(dveLargeBodySignal * 0.42, dvePatchFlowSignal * 0.62)),
    dveAperiodicSeed,
    0.041,
    dveWaveAttenuation
  ) * 3.6 + vec2(11.4, -8.2)
);
float dveStableShimmer = mix(dveLocalShimmer, dveAperiodicDetail, 0.58 * dveDetailFade);
float dveWaveCrestFactor = clamp(dveVertexWaveCrest, 0.0, 1.0);
float dveClassCalmness = dveGetClassCalmness(dveWaterClassWeights);
float dveCalmnessSuppression = clamp(dveClassCalmness + dveTurbidity * 0.1, 0.0, 0.4);
float dveLocalShimmerStrength = dveGetClassLocalShimmerScale(dveWaterClassWeights) * mix(0.34, 1.0, dveFlowStrength) * mix(0.4, 1.0, dveShoreDistanceFactor) * mix(0.65, 1.0, dveBoundaryFactor);
float dveFilteredShimmerStrength = dveLocalShimmerStrength * (0.22 + dveDetailFade * 0.5 + dveLargeBodySignal * 0.12 + dvePatchFlowSignal * 0.1) * (1.0 - dveCalmnessSuppression) * mix(0.94, 1.2, dveScreenGlint * (0.35 + dveHybridFlowMagnitude * 0.4 + dveLargeBodySignal * 0.12 + dvePatchFlowSignal * 0.08));
float dveFoamGlossFlatten = clamp(dveFoamClassData.y * 0.06 + dveFoamClassData.z * 0.18 + dveDropHeight * 0.12 + dveWaveCrestFactor * 0.08 + dveHybridPressure * 0.1, 0.0, 0.28);
microSurface = mix(0.84, 0.994, 0.35 + dveUnderwaterFresnel * 0.5 + dveSoftFillFactor * 0.03 - (1.0 - dveSoftBoundaryFactor) * 0.022 + dveMotionGloss * dveWaveAttenuation * 0.052 * (1.0 - dveUnderwaterFactor * 0.96) + dveClassGlossBias * (1.0 - dveUnderwaterFactor * 0.45) + dveClassSurfacePreset.z * (1.0 - dveUnderwaterFactor * 0.9) + dveStableShimmer * dveFilteredShimmerStrength * (1.0 - dveUnderwaterFactor * 0.97) + dveWaveCrestFactor * 0.08 * (1.0 - dveUnderwaterFactor * 0.92) + dveScreenGlint * (0.018 + dveHybridPressure * 0.02) * (1.0 - dveUnderwaterFactor * 0.97));
microSurface = mix(microSurface, min(0.996, microSurface + dveLocalFluidThickness * 0.08 + dveLocalFluidEventSignal * 0.04), dveMicroCompW.y);
microSurface = max(0.74, microSurface - dveFoamGlossFlatten);
microSurface = mix(microSurface, 0.9, dveUnderwaterFactor * 0.82);
surfaceReflectivityColor = max(
  surfaceReflectivityColor,
  mix(vec3(0.035, 0.05, 0.07), vec3(0.16, 0.2, 0.25), dveUnderwaterFresnel * 0.56 + (1.0 - dveSoftShorelineBand) * 0.1 + dveSoftFillFactor * 0.03 + dveClassSurfacePreset.z * 0.58 * (1.0 - dveUnderwaterFactor * 0.9) + dveWaterClassWeights.z * 0.03 + max(dveStableShimmer, 0.0) * dveFilteredShimmerStrength * 0.74 * (1.0 - dveUnderwaterFactor * 0.97) + dveWaveCrestFactor * 0.11 * (1.0 - dveUnderwaterFactor * 0.95) + dveScreenGlint * (0.05 + dveHybridPressure * 0.04) * (1.0 - dveUnderwaterFactor * 0.97) - dveTurbidity * 0.05)
);
surfaceReflectivityColor = mix(surfaceReflectivityColor, vec3(0.04, 0.055, 0.07), dveUnderwaterFactor * 0.86);
#endif
`,
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: /* glsl */ `
#ifdef DVE_${this.name}
{
  float dveUnderwaterFactor = dveGetUnderwaterFactor(vEyePosition.xyz, dveStableWaterSurfaceY, vPositionW.y);
  vec3 dveContext = dveClampWorldContextValues(dveWorldContext);
  float dveShoreDistanceFactor = dveGetShoreDistanceNormalized(dveShoreDistanceNormalized);
  vec2 dveFlowDirection = dveGetFlowDirection(dveWaterFlowData);
  float dveFlowStrength = dveGetFlowStrength(dveWaterFlowData);
  float dveTurbidity = dveGetWaterTurbidity(dveWaterFlowData);
  float dveBoundaryFactor = dveGetApproxBoundaryFactor(dveContext.x, dveContext.y, dveShoreDistanceFactor, dveFlowStrength);
  vec3 dveWaterClassWeights = dveGetWaterClassWeights(dveGetPackedWaterClassValue(dveWaterFlowData));
  vec3 dveClassSurfacePreset = dveGetClassSurfacePreset(dveWaterClassWeights);
  float dveWaveAttenuation = dveGetWaveResponse(dveContext.y, dveBoundaryFactor, dveShoreDistanceFactor, dveWaterClassWeights);
  float dveDetailFade = dveGetDistanceStableDetailFade(vPositionW, vEyePosition.xyz, dveWaveAttenuation);
  float dveAperiodicSeed = dveHash12(vPositionW.xz * vec2(0.063, 0.097));
  vec2 dveBasePatternWarp = dveGetWaterPatternWarp(vPositionW.xz) * 0.46;
  float dveOpenWaterFactor = 1.0 - dveContext.y;
  float dveDropLift = clamp(dveDropHeight, 0.0, 1.0);
  vec2 dveHybridUV = fract((vPositionW.xz - dve_water_hybrid_clip.xy) * dve_water_hybrid_clip.zw + dveBasePatternWarp * 0.0014);
  vec4 dveHybridBaseMask = texture(dve_water_hybrid_base, dveHybridUV);
  vec4 dveHybridDynamicMask = texture(dve_water_hybrid_dynamic, dveHybridUV);
  vec4 dveHybridFlowMask = texture(dve_water_hybrid_flow, dveHybridUV);
  float dveLocalFluidEventSignal = dveGetLocalFluidEventSignal(dveHybridDynamicMask, dveHybridFlowMask);
  vec4 dveLocalFluidSurface = dveGetLocalFluidSurfaceData(dveHybridUV, 26.0);
  float dveLocalFluidThickness = dveLocalFluidSurface.w;
  vec3 dveLocalFluidNormal = dveLocalFluidSurface.xyz;
  float dveLargeBodySignal = dveGetLargeBodySignal(dveOpenWaterFactor, dveHybridBaseMask);
  float dvePatchFlowSignal = dveGetPatchFlowSignal(dveHybridDynamicMask);
  vec2 dvePatternWarp = dveGetLargeBodyPatternWarp(dveBasePatternWarp, dveLargeBodySignal);
  float dveHybridInfluence = clamp(1.0 - smoothstep(0.16, 0.68, dveOpenWaterFactor) + dveDropLift * 0.9, 0.0, 1.0);
  vec2 dveHybridFlowRaw = (dveHybridFlowMask.rg * 2.0 - 1.0) * dveHybridInfluence;
  vec2 dveHybridFlowVector = length(dveHybridFlowRaw) > 0.0001 ? normalize(dveHybridFlowRaw) : dveFlowDirection;
  float dveHybridFlowMagnitude = clamp(dveHybridFlowMask.b, 0.0, 1.0) * dveHybridInfluence;
  float dveHybridPressure = clamp(dveHybridFlowMask.a, 0.0, 1.0) * dveHybridInfluence;
  vec2 dveLargeBodyFlowVector = dveGetPatchAwareFlowDirection(
    dveFlowDirection,
    dveHybridFlowVector,
    dveHybridInfluence,
    dveLargeBodySignal,
    dvePatchFlowSignal,
    0.44,
    0.64
  );
  vec2 dveHybridAdvection = dveLargeBodyFlowVector * (0.42 + dveHybridFlowMagnitude * 0.38 + dveLargeBodySignal * 0.12 + dvePatchFlowSignal * 0.16) + dveHybridFlowRaw * mix(0.26, 0.08, dveGetPatchAwareSignal(dveLargeBodySignal, dvePatchFlowSignal));
  vec2 dveMacroUV = (
    vPositionW.xz * 0.012 +
    vec2(0.17, 0.31) +
    dvePatternWarp * 0.05 +
    dveGetMacroMotion(dve_time, dveWaveAttenuation) +
    dveHybridAdvection * 0.7
  );
  vec2 dveMicroUV = (
    vPositionW.xz * 0.06 +
    vec2(0.53, 0.11) +
    dvePatternWarp * 0.2 +
    dveGetMicroMotion(dve_time, dveWaveAttenuation) +
    dveHybridAdvection * 1.9
  );
  vec2 dveAperiodicMacroUV = dveGetAperiodicDetailUV(vPositionW.xz + dveHybridAdvection * 11.0, dveHybridFlowVector, dveAperiodicSeed, 0.016, dveWaveAttenuation);
  vec2 dveAperiodicMicroUV = dveGetAperiodicDetailUV(vPositionW.xz + dveHybridAdvection * 13.0, dveHybridFlowVector, fract(dveAperiodicSeed + 0.37), 0.058, dveWaveAttenuation);
  vec3 dveMacroSample = mix(
    texture(dve_water_normal, dveMacroUV).xyz * 2.0 - 1.0,
    texture(dve_water_normal, dveAperiodicMacroUV).xyz * 2.0 - 1.0,
    0.56 + dveLargeBodySignal * 0.16 + dvePatchFlowSignal * 0.12
  );
  vec3 dveMicroSample = mix(
    texture(dve_water_normal, dveMicroUV).xyz * 2.0 - 1.0,
    texture(dve_water_normal, dveAperiodicMicroUV).xyz * 2.0 - 1.0,
    0.48 * dveDetailFade + dveLargeBodySignal * 0.1 + dvePatchFlowSignal * 0.08
  );
  vec3 dveMacroNormal = normalize(vec3(dveMacroSample.x * (0.35 + dveDropLift * 0.08 + dveHybridPressure * 0.07), 1.0, dveMacroSample.y * (0.35 + dveDropLift * 0.08 + dveHybridPressure * 0.07)));
  vec3 dveMicroNormal = normalize(vec3(dveMicroSample.x * (0.18 + dveHybridFlowMagnitude * 0.04), 1.0, dveMicroSample.y * (0.18 + dveHybridFlowMagnitude * 0.04)));
  vec3 dveWaterDetailNormal = normalize(mix(dveMacroNormal, dveMicroNormal, (0.18 + dveWaveAttenuation * 0.1) + dveDetailFade * 0.12));
  // Sprint 6 — Unified normal composition using composition weights
  float dveNormPatchW = dveGetPatchBaseWeight(dveLargeBodySignal, clamp(dveHybridBaseMask.b, 0.0, 1.0), dveOpenWaterFactor, dveLocalFluidEventSignal);
  float dveNormSSFRW = dveGetSSFREventWeight(dveLocalFluidEventSignal, dveLocalFluidThickness, dveDropLift, dveOpenWaterFactor);
  vec2 dveNormCompW = dveGetCompositionBlend(dveNormPatchW, dveNormSSFRW, dveLocalFluidEventSignal);
  vec3 dveResolvedFluidNormal = dveComposeWaterNormal(dveWaterDetailNormal, dveLocalFluidNormal, dveNormCompW.x, dveNormCompW.y, dveLocalFluidThickness);
  float dveUnderwaterDetailMix = (0.72 + dveWaveAttenuation * 0.24) * (1.0 - dveUnderwaterFactor * 0.985);
  vec3 dveDerivedNormal = dveGetDerivedWaterSurfaceNormal(normalW);
  vec3 dveUnderwaterBaseNormal = normalize(mix(dveDerivedNormal, vec3(0.0, -1.0, 0.0), dveUnderwaterFactor * 0.96));
  normalW = normalize(mix(dveUnderwaterBaseNormal, dveResolvedFluidNormal, dveUnderwaterDetailMix));
}
#endif
`,
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: /* glsl */ `
#ifdef DVE_${this.name}
vec3 dveWaterNormal = dveGetDerivedWaterSurfaceNormal(vNormalW);
vec3 dveWaterViewDir = dveGetWaterViewDirection(vEyePosition.xyz, vPositionW);
float dveUnderwaterFactor = dveGetUnderwaterFactor(vEyePosition.xyz, dveStableWaterSurfaceY, vPositionW.y);
dveWaterNormal = normalize(mix(dveWaterNormal, vec3(0.0, -1.0, 0.0), dveUnderwaterFactor * 0.96));
float dveWaterViewDot = dveGetWaterViewDot(dveWaterNormal, dveWaterViewDir);
float dveFresnel = dveGetWaterFresnelResponse(dveWaterViewDot);
finalDiffuse.rgb = mix(finalDiffuse.rgb, finalDiffuse.rgb * vec3(1.03, 1.05, 1.08), dveFresnel * 0.18 * (1.0 - dveUnderwaterFactor * 0.9));
#endif
`,
      };
  return code;
    }

    return null;
  }
}