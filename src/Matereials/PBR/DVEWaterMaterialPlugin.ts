import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { DVEBRPBRMaterial } from "./DVEBRPBRMaterial";
import { getDepthTextureBinding } from "./DepthTextureBinding";

export class DVEWaterMaterialPlugin extends MaterialPluginBase {
  uniformBuffer: UniformBuffer;
  private static frameTimes = new WeakMap<Scene, { frameId: number; time: number }>();

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
      "dve_water_foam",
      "dve_depthTexture"
    );
  }

  getAttributes(attributes: string[]) {
    attributes.push("textureIndex", "uv", "worldContext", "metadata", "phNormalized", "subdivAO");
  }

  getUniforms() {
    return {
      ubo: [
        { name: "dve_voxel_animation_size" },
        { name: "dve_time" },
        { name: "dve_cameraNearFar", size: 2 },
        { name: "dve_screenSize", size: 2 },
      ],
    };
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
    for (const [uniformId, size] of this.dveMaterial.animationSizes) {
      effect.setInt(uniformId, size);
    }
    if (scene) {
      const frameId = scene.getFrameId();
      let frameTime = DVEWaterMaterialPlugin.frameTimes.get(scene);
      if (!frameTime || frameTime.frameId !== frameId) {
        frameTime = { frameId, time: performance.now() * 0.001 };
        DVEWaterMaterialPlugin.frameTimes.set(scene, frameTime);
      }
      effect.setFloat("dve_time", frameTime.time);
    } else {
      effect.setFloat("dve_time", performance.now() * 0.001);
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
uniform sampler2D dve_water_foam;
uniform sampler2D dve_depthTexture;
uniform vec2 dve_cameraNearFar;
uniform vec2 dve_screenSize;
`;
    const varying = /* glsl */ `
varying vec2 dveBaseUV;
varying float dveTextureLayer;
varying vec4 dveOverlayTextureIndex;
varying vec3 dveWorldContext;
varying vec4 dveWaterFlowData;
varying float dveShoreDistanceNormalized;
varying float dveStableWaterSurfaceY;
`;
    const attributes = /* glsl */ `
attribute vec3 textureIndex;
attribute vec3 worldContext;
attribute vec4 metadata;
attribute float phNormalized;
attribute float subdivAO;
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

float dveGetLargeScaleWaterVariation(vec2 positionXZ) {
  float primary = sin(dot(positionXZ, vec2(0.031, 0.021)) + sin(positionXZ.x * 0.009 - positionXZ.y * 0.013) * 1.4);
  float secondary = cos(dot(positionXZ, vec2(-0.018, 0.027)) - cos(positionXZ.x * 0.006 + positionXZ.y * 0.01) * 1.1);
  float tertiary = sin(dot(positionXZ, vec2(0.011, -0.008)) + 1.7);
  return clamp(primary * 0.28 + secondary * 0.22 + tertiary * 0.14 + 0.5, 0.0, 1.0);
}

vec2 dveGetWaterPatternWarp(vec2 positionXZ) {
  float warpX = sin(dot(positionXZ, vec2(0.014, 0.019)) + 0.7) + cos(dot(positionXZ, vec2(-0.009, 0.013)) - 1.1);
  float warpY = cos(dot(positionXZ, vec2(0.012, -0.016)) - 0.5) - sin(dot(positionXZ, vec2(0.01, 0.007)) + 1.3);
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

float dveGetUnderwaterFactor(vec3 eyePosition, float stableSurfaceY) {
  if (stableSurfaceY < 0.0) return 0.0;
  return smoothstep(0.12, 1.75, max(stableSurfaceY - eyePosition.y, 0.0));
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
  return dveGetWaveAttenuation(shoreFactor, boundaryFactor) * mix(0.12, 1.0, shoreMotionDamping) * bankWaveDamping * classWaveScale;
}

vec2 dveGetMacroMotion(float time, float waveAttenuation) {
  return vec2(0.006, 0.003) * time * mix(0.12, 0.45, waveAttenuation);
}

vec2 dveGetMicroMotion(float time, float waveAttenuation) {
  return vec2(-0.024, 0.017) * time * mix(0.18, 0.78, waveAttenuation);
}

vec2 dveGetFoamMotion(float time, float waveAttenuation) {
  return vec2(0.012, -0.007) * time * mix(0.12, 0.48, waveAttenuation);
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
  vec2 lateral = dveGetPerpendicular(flowDirection);
  float primary = sin(dot(positionXZ, flowDirection * 8.0 + lateral * 3.0) + time * 0.9);
  float secondary = cos(dot(positionXZ, lateral * 10.0 - flowDirection * 2.0) - time * 0.65);
  return (primary * 0.6 + secondary * 0.4) * 0.5 + 0.5;
}
`;

    if (shaderType === "vertex") {
      const code: { [pointName: string]: string } = {
        CUSTOM_VERTEX_DEFINITIONS: /* glsl */ `
#ifdef DVE_${this.name}
uniform highp usampler2D dve_voxel_animation;
uniform highp int dve_voxel_animation_size;
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
#endif
`,
        CUSTOM_FRAGMENT_UPDATE_ALBEDO: /* glsl */ `
#ifdef DVE_${this.name}
vec4 dveLiquidSample = texture(dve_voxel, vec3(dveBaseUV, dveTextureLayer));
if (dveOverlayTextureIndex.x > 0.) {
  vec4 oRGB = texture(dve_voxel, vec3(dveBaseUV, dveOverlayTextureIndex.x));
  if (oRGB.a > 0.5) dveLiquidSample = oRGB;
}
vec3 dveWaterNormal = dveGetWaterNormal(vNormalW);
vec3 dveWaterViewDir = dveGetWaterViewDirection(vEyePosition.xyz, vPositionW);
float dveWaterViewDot = dveGetWaterViewDot(dveWaterNormal, dveWaterViewDir);
float dveUnderwaterFactor = dveGetUnderwaterFactor(vEyePosition.xyz, dveStableWaterSurfaceY);
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
float dveBoundaryFactor = dveContext.z;
vec2 dveFlowDirection = dveGetFlowDirection(dveWaterFlowData);
float dveFlowStrength = dveGetFlowStrength(dveWaterFlowData);
vec3 dveWaterClassWeights = dveGetWaterClassWeights(clamp(dveWaterFlowData.w, 0.0, 1.0));
float dveWaveAttenuation = dveGetWaveResponse(dveShoreFactor, dveBoundaryFactor, dveShoreDistanceFactor, dveWaterClassWeights);
float dveBankWaveDamping = dveGetBankWaveDamping(dveShorelineBand, dveShoreDistanceFactor);
float dveFresnel = dveGetWaterFresnelResponse(dveWaterViewDot);
float dveUnderwaterFresnel = mix(dveFresnel, dveFresnel * 0.12, dveUnderwaterFactor);
float dveMacroVariation = dveGetLargeScaleWaterVariation(vPositionW.xz);
vec2 dvePatternWarp = dveGetWaterPatternWarp(vPositionW.xz) * mix(0.2, 0.55, dveWaveAttenuation);
vec2 dveStaticWaterUV = (
  vPositionW.xz * 0.035 +
  dvePatternWarp * 0.12 +
  dveGetFoamMotion(dve_time, dveWaveAttenuation) +
  dveGetDirectionalMotion(dveFlowDirection, dveFlowStrength, dveWaterClassWeights, dve_time, 0.016, 0.35, dveWaveAttenuation)
);
vec2 dveScreenUV = clamp(gl_FragCoord.xy / max(dve_screenSize, vec2(1.0)), vec2(0.001), vec2(0.999));
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
float dveRefractionDarkening = (1.0 - dveWaterViewDot) * (0.14 + dveThicknessFactor * 0.42) * mix(1.0, 0.82, dveUnderwaterFactor);
float dveFoamMask = texture(dve_water_foam, dveStaticWaterUV * mix(1.4, 2.2, dveWaveAttenuation)).r;
float dveSoftFillFactor = dveGetSoftWaterContextValue(dveFillFactor, dveMacroVariation, dveFoamMask, 0.16);
float dveSoftBoundaryFactor = dveGetSoftWaterContextValue(dveBoundaryFactor, dveMacroVariation, dveFoamMask, 0.22);
float dveFoamBand = smoothstep(DVE_FOAM_BAND_START, DVE_FOAM_BAND_END, dveShorelineBand) * (
  1.0 - smoothstep(DVE_FOAM_BAND_FADE_START, DVE_FOAM_BAND_FADE_END, dveShoreDistanceFactor)
);
float dveOrganicFoamBand = clamp(dveFoamBand * (0.84 + dveMacroVariation * 0.24), 0.0, 1.0);
float dveSoftShorelineBand = clamp(mix(dveShorelineBand, dveOrganicFoamBand, 0.62), 0.0, 1.0);
float dveFoamEdge = smoothstep(DVE_FOAM_EDGE_START, DVE_FOAM_EDGE_END, 1.0 - dveSoftBoundaryFactor);
float dveCoastalFoam = dveFoamMask * clamp((dveOrganicFoamBand * 0.9 + dveFoamEdge * 0.22 + dveMacroVariation * 0.08) * dveGetClassFoamResponse(dveWaterClassWeights), 0.0, 1.0) * mix(1.0, 0.68, 1.0 - dveBankWaveDamping);
float dveOrganicShoreline = clamp(dveSoftShorelineBand * (0.8 + dveMacroVariation * 0.16) + dveFoamMask * 0.05, 0.0, 1.0);
float dveShallowBreakup = clamp(dveShallowClarity * 0.36 + dveOrganicShoreline * 0.22 + dveMacroVariation * 0.18 + (1.0 - dveSoftFillFactor) * 0.035, 0.0, 1.0);
vec3 dveShallowColor = vec3(0.34, 0.74, 0.95);
vec3 dveMidColor = vec3(0.1, 0.34, 0.62);
vec3 dveDeepColor = vec3(0.02, 0.09, 0.24);
vec3 dveReflectionColor = vec3(0.8, 0.9, 1.0);
float dveDepthToDeep = clamp(dveWaterDepthFactor * 0.9 + dveOpenWaterFactor * 0.24 - dveShallowClarity * 0.08, 0.0, 1.0);
vec3 dveAbsorptionColor = mix(dveShallowColor, dveMidColor, smoothstep(0.0, 0.45, dveDepthToDeep));
dveAbsorptionColor = mix(dveAbsorptionColor, dveDeepColor, smoothstep(0.38, 1.0, dveDepthToDeep));
vec3 dveClassTint = dveGetClassTint(dveWaterClassWeights);
float dveClassCalmness = dveGetClassCalmness(dveWaterClassWeights);
vec3 dveTransmissionColor = mix(dveAbsorptionColor, vec3(0.58, 0.89, 1.0), dveOrganicShoreline * 0.12 + dveWaterFacing * 0.06 + dveShallowClarity * 0.22 + dveMacroVariation * 0.09 + dveSoftFillFactor * 0.015);
vec3 dveTransmissionBase = dveTransmissionColor;
dveTransmissionColor = dveTransmissionBase * dveClassTint;
vec3 dveShallowBreakupTint = mix(vec3(0.8, 0.95, 1.01), vec3(1.06, 1.1, 1.15), dveFoamMask);
vec3 dveShallowBreakupColor = dveTransmissionColor * dveShallowBreakupTint;
vec3 dveReflectiveLift = mix(dveReflectionColor, vec3(0.96, 0.98, 1.0), dveUnderwaterFresnel * 0.76 + dveSoftFillFactor * 0.03 + dveWaterClassWeights.z * 0.06);
vec3 dveLiquidColor = mix(dveTransmissionColor, dveReflectiveLift, 0.11 + dveUnderwaterFresnel * 0.42 + dveWaterClassWeights.z * 0.08 - dveWaterClassWeights.x * 0.06 - dveUnderwaterFactor * 0.09);
dveLiquidColor = mix(dveLiquidColor, dveShallowBreakupColor, dveShallowBreakup * 0.22);
dveLiquidColor = mix(dveLiquidColor, vec3(0.95, 0.98, 1.0), dveCoastalFoam * 0.32);
dveLiquidColor = mix(dveLiquidColor, dveLiquidColor * vec3(0.985, 0.995, 1.01), dveMacroVariation * 0.08);
dveLiquidColor = mix(dveLiquidColor, dveLiquidColor * vec3(0.978, 0.989, 1.0), (1.0 - dveSoftFillFactor) * 0.03);
dveLiquidColor = mix(dveLiquidColor, dveLiquidColor * vec3(1.015, 1.02, 1.03), max(dveWaveAttenuation * 0.05 + dveFoamMask * 0.028 - dveClassCalmness, 0.0));
dveLiquidColor *= 1.0 - dveRefractionDarkening;
dveLiquidColor = mix(dveLiquidColor, dveLiquidColor * vec3(0.972, 0.989, 1.02), dveSoftBoundaryFactor * 0.045);
dveLiquidColor = mix(dveLiquidColor, dveLiquidColor * vec3(1.07, 1.1, 1.16), dveShallowBreakup * (0.18 + dveBankWaveDamping * 0.08));
dveLiquidColor *= mix(vec3(0.9, 0.94, 0.98), vec3(1.0), dveWaterFacing * 0.6 + dveUnderwaterFresnel * 0.2);
surfaceAlbedo = toLinearSpace(dveLiquidColor);
alpha = 1.0;
#endif
`,
        CUSTOM_FRAGMENT_UPDATE_MICROSURFACE: /* glsl */ `
#ifdef DVE_${this.name}
vec3 dveWaterNormal = dveGetWaterNormal(vNormalW);
vec3 dveWaterViewDir = dveGetWaterViewDirection(vEyePosition.xyz, vPositionW);
float dveWaterViewDot = dveGetWaterViewDot(dveWaterNormal, dveWaterViewDir);
float dveUnderwaterFactor = dveGetUnderwaterFactor(vEyePosition.xyz, dveStableWaterSurfaceY);
vec3 dveUnderwaterNormal = normalize(mix(dveWaterNormal, vec3(0.0, -1.0, 0.0), dveUnderwaterFactor * 0.96));
dveWaterNormal = dveUnderwaterNormal;
dveWaterViewDot = dveGetWaterViewDot(dveWaterNormal, dveWaterViewDir);
dveWaterViewDot = max(dveWaterViewDot, dveUnderwaterFactor * 0.18);
vec3 dveContext = dveClampWorldContextValues(dveWorldContext);
float dveFillFactor = dveContext.x;
float dveShoreFactor = dveContext.y;
float dveShoreDistanceFactor = dveGetShoreDistanceNormalized(dveShoreDistanceNormalized);
float dveShorelineBand = dveGetShorelineBand(dveShoreFactor, dveShoreDistanceFactor);
float dveBoundaryFactor = dveContext.z;
vec3 dveWaterClassWeights = dveGetWaterClassWeights(clamp(dveWaterFlowData.w, 0.0, 1.0));
vec3 dveClassSurfacePreset = dveGetClassSurfacePreset(dveWaterClassWeights);
float dveWaveAttenuation = dveGetWaveResponse(dveShoreFactor, dveBoundaryFactor, dveShoreDistanceFactor, dveWaterClassWeights);
float dveFresnel = dveGetWaterFresnelResponse(dveWaterViewDot);
float dveUnderwaterFresnel = mix(dveFresnel, dveFresnel * 0.1, dveUnderwaterFactor);
float dveMacroVariation = dveGetLargeScaleWaterVariation(vPositionW.xz);
vec2 dveGlossWarp = dveGetWaterPatternWarp(vPositionW.xz) * mix(0.12, 0.38, dveWaveAttenuation);
float dveContextMask = texture(dve_water_foam, vPositionW.xz * 0.028 + dveGlossWarp * 0.08).r;
float dveSoftFillFactor = dveGetSoftWaterContextValue(dveFillFactor, dveMacroVariation, dveContextMask, 0.14);
float dveSoftBoundaryFactor = dveGetSoftWaterContextValue(dveBoundaryFactor, dveMacroVariation, dveContextMask, 0.18);
float dveSoftShorelineBand = clamp(mix(dveShorelineBand, dveShorelineBand * (0.82 + dveMacroVariation * 0.16) + dveContextMask * 0.04, 0.58), 0.0, 1.0);
float dveMotionGloss = sin(dve_time * 0.65 + vPositionW.x * 0.035 + vPositionW.z * 0.028) * 0.5 + 0.5;
float dveClassGlossBias = dveWaterClassWeights.y * 0.05 - dveWaterClassWeights.x * 0.04 + dveWaterClassWeights.z * 0.03;
float dveLocalShimmer = dveGetLocalShimmerPattern(vPositionW.xz, dveGetFlowDirection(dveWaterFlowData), dve_time);
float dveLocalShimmerStrength = dveGetClassLocalShimmerScale(dveWaterClassWeights) * mix(0.38, 1.0, dveGetFlowStrength(dveWaterFlowData)) * mix(0.42, 1.0, dveShoreDistanceFactor) * mix(0.65, 1.0, dveBoundaryFactor);
microSurface = mix(0.88, 0.996, 0.33 + dveUnderwaterFresnel * 0.52 + dveSoftFillFactor * 0.04 - (1.0 - dveSoftBoundaryFactor) * 0.025 + dveMotionGloss * dveWaveAttenuation * 0.065 * (1.0 - dveUnderwaterFactor * 0.96) + dveClassGlossBias * (1.0 - dveUnderwaterFactor * 0.45) + dveClassSurfacePreset.z * (1.0 - dveUnderwaterFactor * 0.9) + dveLocalShimmer * dveLocalShimmerStrength * (1.0 - dveUnderwaterFactor * 0.97));
microSurface = mix(microSurface, 0.9, dveUnderwaterFactor * 0.82);
surfaceReflectivityColor = max(
  surfaceReflectivityColor,
  mix(vec3(0.035, 0.05, 0.07), vec3(0.16, 0.2, 0.25), dveUnderwaterFresnel * 0.56 + (1.0 - dveSoftShorelineBand) * 0.1 + dveSoftFillFactor * 0.03 + dveClassSurfacePreset.z * 0.58 * (1.0 - dveUnderwaterFactor * 0.9) + dveWaterClassWeights.z * 0.03 + max(dveLocalShimmer, 0.0) * dveLocalShimmerStrength * 0.92 * (1.0 - dveUnderwaterFactor * 0.97))
);
surfaceReflectivityColor = mix(surfaceReflectivityColor, vec3(0.04, 0.055, 0.07), dveUnderwaterFactor * 0.86);
#endif
`,
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: /* glsl */ `
#ifdef DVE_${this.name}
{
  float dveUnderwaterFactor = dveGetUnderwaterFactor(vEyePosition.xyz, dveStableWaterSurfaceY);
  vec3 dveContext = dveClampWorldContextValues(dveWorldContext);
  float dveShoreDistanceFactor = dveGetShoreDistanceNormalized(dveShoreDistanceNormalized);
  vec2 dveFlowDirection = dveGetFlowDirection(dveWaterFlowData);
  float dveFlowStrength = dveGetFlowStrength(dveWaterFlowData);
  vec3 dveWaterClassWeights = dveGetWaterClassWeights(clamp(dveWaterFlowData.w, 0.0, 1.0));
  vec3 dveClassSurfacePreset = dveGetClassSurfacePreset(dveWaterClassWeights);
  float dveWaveAttenuation = dveGetWaveResponse(dveContext.y, dveContext.z, dveShoreDistanceFactor, dveWaterClassWeights);
  vec2 dvePatternWarp = dveGetWaterPatternWarp(vPositionW.xz) * mix(0.22, 0.7, dveWaveAttenuation);
  vec2 dveMacroUV = (
    vPositionW.xz * 0.012 +
    vec2(0.17, 0.31) +
    dvePatternWarp * 0.05 +
    dveGetMacroMotion(dve_time, dveWaveAttenuation) +
    dveGetDirectionalMotion(dveFlowDirection, dveFlowStrength, dveWaterClassWeights, dve_time, 0.006, 0.28, dveWaveAttenuation)
  );
  vec2 dveMicroUV = (
    vPositionW.xz * 0.085 +
    vec2(0.53, 0.11) +
    dvePatternWarp * 0.2 +
    dveGetMicroMotion(dve_time, dveWaveAttenuation) +
    dveGetDirectionalMotion(dveFlowDirection, dveFlowStrength, dveWaterClassWeights, dve_time, 0.018, 0.12, dveWaveAttenuation)
  );
  vec3 dveMacroSample = texture(dve_water_normal, dveMacroUV).xyz * 2.0 - 1.0;
  vec3 dveMicroSample = texture(dve_water_normal, dveMicroUV).xyz * 2.0 - 1.0;
  vec3 dveMacroNormal = normalize(vec3(dveMacroSample.x * dveClassSurfacePreset.x, 1.0, dveMacroSample.y * dveClassSurfacePreset.x));
  vec3 dveMicroNormal = normalize(vec3(dveMicroSample.x * dveClassSurfacePreset.y, 1.0, dveMicroSample.y * dveClassSurfacePreset.y));
  vec3 dveWaterDetailNormal = normalize(mix(dveMacroNormal, dveMicroNormal, 0.38 + dveWaveAttenuation * 0.12));
  float dveUnderwaterDetailMix = (0.24 + dveWaveAttenuation * 0.24) * (1.0 - dveUnderwaterFactor * 0.985);
  vec3 dveUnderwaterBaseNormal = normalize(mix(normalW, vec3(0.0, -1.0, 0.0), dveUnderwaterFactor * 0.96));
  normalW = normalize(mix(dveUnderwaterBaseNormal, dveWaterDetailNormal, dveUnderwaterDetailMix));
}
#endif
`,
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: /* glsl */ `
#ifdef DVE_${this.name}
vec3 dveWaterNormal = dveGetWaterNormal(vNormalW);
vec3 dveWaterViewDir = dveGetWaterViewDirection(vEyePosition.xyz, vPositionW);
float dveUnderwaterFactor = dveGetUnderwaterFactor(vEyePosition.xyz, dveStableWaterSurfaceY);
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