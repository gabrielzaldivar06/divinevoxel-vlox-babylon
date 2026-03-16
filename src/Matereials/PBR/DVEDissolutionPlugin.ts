import type { Engine } from "@babylonjs/core/Engines/engine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { classifyTerrainMaterial } from "./MaterialFamilyProfiles";
import { SharedVoxelAttributes } from "./SharedVoxelAttributes";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";

// 64×64 procedural noise texture.
// NOTE: This is stratified uniform noise (Fisher-Yates shuffle over a uniform
// grid), NOT true blue noise. Acceptable for dissolution grain effects.
// Before using for TAA reprojection or transparency dithering, replace with a
// pre-baked Void-and-Cluster blue noise texture (64×64 R8).
let _blueNoiseTexture: Texture | null = null;

function getOrCreateBlueNoiseTexture(scene: Scene): Texture {
  if (_blueNoiseTexture) return _blueNoiseTexture;

  const size = 64;
  const total = size * size; // 4096 pixels
  const data = new Uint8Array(total * 4);

  // Build a properly normalized 0–255 range distributed over all 4096 pixels.
  // Using Math.round(i * 255 / (total-1)) gives exactly one copy of 0 and 255
  // and proportional distribution in between (avoids the ×16 duplication of i%256).
  const values = new Uint8Array(total);
  for (let i = 0; i < total; i++) values[i] = Math.round((i * 255) / (total - 1));

  // Fisher-Yates shuffle with xorshift32 PRNG (deterministic, period 2^32-1).
  let seed = 0x9e3779b9 >>> 0;
  const xorshift32 = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let i = total - 1; i > 0; i--) {
    const j = xorshift32() % (i + 1);
    const tmp = values[i];
    values[i] = values[j];
    values[j] = tmp;
  }

  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    data[idx]     = values[i];
    data[idx + 1] = values[i];
    data[idx + 2] = values[i];
    data[idx + 3] = 255;
  }

  _blueNoiseTexture = RawTexture.CreateRGBATexture(
    data, size, size, scene,
    false, false, Texture.NEAREST_NEAREST_MIPLINEAR
  );
  _blueNoiseTexture.wrapU = Texture.WRAP_ADDRESSMODE;
  _blueNoiseTexture.wrapV = Texture.WRAP_ADDRESSMODE;
  return _blueNoiseTexture;
}

export class DVEDissolutionPlugin extends MaterialPluginBase {
  private _blueNoiseTex: Texture | null = null;
  /** Fase 5: timestamp when this sector's dissolution started (-999 = static/complete). */
  private _dissolveStartTime = -999.0;

  constructor(
    material: PBRMaterial,
    name: string,
    private _scene: Scene
  ) {
    super(material, name, 21, {
      DVE_DISSOLUTION: true,
      DVE_SUBDIV_AO: false,
    });
    this._enable(true);
  }

  /** Fase 5: Set the dissolution start time for temporal animation. */
  setDissolveStartTime(time: number) {
    this._dissolveStartTime = time;
  }

  prepareDefines(defines: any) {
    const terrain = EngineSettings.settings.terrain;
    if (!terrain.dissolution) {
      defines.DVE_DISSOLUTION = false;
      defines.DVE_SUBDIV_AO = false;
      return;
    }

    const mc = classifyTerrainMaterial(this.name);
    const isOrganic =
      mc.isSoil || mc.isFlora || mc.isWood || mc.isRock ||
      mc.isCultivated || mc.isExotic;
    if (!isOrganic || mc.isLiquid) {
      defines.DVE_DISSOLUTION = false;
      // DVE_SUBDIV_AO: dve_solid renders ALL terrain including organic/subdivision voxels.
      // Pass the subdivAO varying through so dveMicroAO (T3) can modulate micro contrast
      // without enabling the untested full dissolution fragment code.
      defines.DVE_SUBDIV_AO = this.name === "dissolution_dve_solid";
      return;
    }

    defines.DVE_DISSOLUTION = true;
    if (terrain.dissolutionTemporal) defines.DVE_DISSOLUTION_TEMPORAL = true;
    if (mc.isSoil || mc.isCultivated) defines.DVE_FAMILY_SOIL = true;
    if (mc.isSoil && this.name.toLowerCase().includes("sand")) defines.DVE_FAMILY_SAND = true;
    if (mc.isRock) defines.DVE_FAMILY_ROCK = true;
    if (mc.isFlora) defines.DVE_FAMILY_FLORA = true;
    if (mc.isWood) defines.DVE_FAMILY_WOOD = true;
    if (mc.isExotic) defines.DVE_FAMILY_EXOTIC = true;
  }

  getClassName() {
    return "DVEDissolutionPlugin";
  }

  getSamplers(samplers: string[]) {
    samplers.push("dve_blueNoise");
  }

  getAttributes(attributes: string[]) {
    attributes.push(
      SharedVoxelAttributes.DissolutionProximity,
      SharedVoxelAttributes.PullStrength,
      SharedVoxelAttributes.SubdivLevel,
      SharedVoxelAttributes.PullDirectionBias,
      SharedVoxelAttributes.PhNormalized,
      SharedVoxelAttributes.SubdivAO
    );
  }

  getUniforms() {
    return {
      ubo: [
        { name: "dve_dissolutionIntensity" },
        { name: "dve_dissolveStartTime" },
        { name: "dve_sunDir", size: 3, type: "vec3" },
        { name: "dve_seaLevel" },     // R02: shore zone sea-level height
        { name: "dve_weatherState" }, // R17: weather state (0=clear, 1=rain)
        { name: "dve_time" },         // F01: dissolution edge glow flicker + rain cycle animation
      ],
    };
  }

  isReadyForSubMesh(): boolean {
    return true;
  }

  bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, engine: Engine) {
    this._bindResources();
  }

  hardBindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, engine: Engine) {
    this._bindResources();
  }

  private _bindResources() {
    const effect = this._material.getEffect();
    if (!effect) return;

    if (!this._blueNoiseTex) {
      this._blueNoiseTex = getOrCreateBlueNoiseTexture(this._scene);
    }
    effect.setTexture("dve_blueNoise", this._blueNoiseTex);
    effect.setFloat(
      "dve_dissolutionIntensity",
      EngineSettings.settings.terrain.dissolution
        ? ((EngineSettings.settings.terrain as any).dissolutionIntensity ?? 1.0)
        : 0.0
    );
    effect.setFloat("dve_dissolveStartTime", this._dissolveStartTime);
    effect.setFloat("dve_time", performance.now() * 0.001); // F01: live clock for glow flicker + rain cycle

    // R03: Bind real sun direction from scene's directional light
    const lights = this._scene.lights;
    let sx = -1, sy = -1, sz = -0.5;
    for (let i = 0; i < lights.length; i++) {
      if (lights[i] instanceof DirectionalLight) {
        const dir = (lights[i] as DirectionalLight).direction;
        sx = dir.x; sy = dir.y; sz = dir.z;
        break;
      }
    }
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
    effect.setFloat3("dve_sunDir", sx / len, sy / len, sz / len);
    // R02: Shore zone sea-level height — game can override via (terrain as any).seaLevel
    effect.setFloat("dve_seaLevel", (EngineSettings.settings.terrain as any).seaLevel ?? 32.0);
    // R17: Weather state — 0=clear sky, 1=full rain
    effect.setFloat("dve_weatherState", (EngineSettings.settings.terrain as any).weatherState ?? 0.0);
  }

  //@ts-ignore
  getCustomCode(shaderType: any) {
    const terrain = EngineSettings.settings.terrain;
    if (!terrain.dissolution) return null;

    const mc = classifyTerrainMaterial(this.name);
    const isOrganic =
      mc.isSoil || mc.isFlora || mc.isWood || mc.isRock ||
      mc.isCultivated || mc.isExotic;
    if (!isOrganic || mc.isLiquid) {
      // For dve_solid: inject only the subdivAO pass-through for T3 dveMicroAO.
      if (this.name !== "dissolution_dve_solid") return null;
      if (shaderType === "vertex") {
        return {
          CUSTOM_VERTEX_DEFINITIONS: /*glsl*/ `
#ifdef DVE_SUBDIV_AO
attribute float subdivAO;
varying float vSubdivAO;
#endif
`,
          CUSTOM_VERTEX_MAIN_BEGIN: /*glsl*/ `
#ifdef DVE_SUBDIV_AO
vSubdivAO = subdivAO;
#endif
`,
        };
      }
      if (shaderType === "fragment") {
        return {
          CUSTOM_FRAGMENT_DEFINITIONS: /*glsl*/ `
#ifdef DVE_SUBDIV_AO
varying float vSubdivAO;
#endif
`,
        };
      }
      return null;
    }

    const isSoil = mc.isSoil || mc.isCultivated;
    const isRock = mc.isRock;
    const isFlora = mc.isFlora;

    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: /*glsl*/ `
#ifdef DVE_DISSOLUTION
attribute float dissolutionProximity;
attribute float pullStrength;
attribute float subdivLevel;
attribute float pullDirectionBias;
attribute float phNormalized;
attribute float subdivAO;

varying float vDissolutionProximity;
varying float vPullStrength;
varying float vSubdivLevel;
varying float vPullDirectionBias;
varying float vPhNormalized;
varying float vSubdivAO;
#endif
`,
        CUSTOM_VERTEX_MAIN_BEGIN: /*glsl*/ `
#ifdef DVE_DISSOLUTION
vDissolutionProximity = dissolutionProximity;
vPullStrength = pullStrength;
vSubdivLevel = subdivLevel;
vPullDirectionBias = pullDirectionBias;
vPhNormalized = phNormalized;
vSubdivAO = subdivAO;
#endif
`,
        CUSTOM_VERTEX_UPDATE_POSITION: /*glsl*/ `
#ifdef DVE_DISSOLUTION
  // Idea 3 — Smooth LOD morph: as camera distance approaches the CPU LOD threshold
  // (48–96 m), blend displaced positions back to the undisplaced flat base so the
  // mesher's N-drop from 5→1 becomes invisible rather than a visual pop.
  if (subdivLevel > 0.01 && pullStrength > 0.001) {
    vec3 dve_wpos    = (world * vec4(positionUpdated.xyz, 1.0)).xyz;
    float dve_lodDist = length(dve_wpos - vEyePosition.xyz);
    float dve_morphT  = smoothstep(44.0, 76.0, dve_lodDist) * subdivLevel;
    // Reverse the CPU pull (pull ≈ normal * pullStrength * MAX_PULL=0.45)
    vec3 dve_flatPos  = positionUpdated.xyz - normalUpdated * pullStrength * 0.45;
    positionUpdated.xyz = mix(positionUpdated.xyz, dve_flatPos, dve_morphT);
  }
#endif
`,
      };
    }

    if (shaderType === "fragment") {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: /*glsl*/ `
#ifdef DVE_DISSOLUTION
uniform sampler2D dve_blueNoise;
uniform float dve_dissolutionIntensity;
uniform float dve_time;
uniform float dve_dissolveStartTime;
uniform vec3 dve_sunDir;
uniform float dve_seaLevel;     // R02: shore zone sea-level height
uniform float dve_weatherState; // R17: weather state (0=clear, 1=rain)

varying float vDissolutionProximity;
varying float vPullStrength;
varying float vSubdivLevel;
varying float vPullDirectionBias;
varying float vPhNormalized;
varying float vSubdivAO;
#endif
`,
        CUSTOM_FRAGMENT_UPDATE_ALBEDO: /*glsl*/ `
#ifdef DVE_DISSOLUTION
// Guard: only apply dissolution effects when a dissolution event is actually active.
// dissolveStartTime = -999 means static/never-dissolving. Without this guard,
// dissolutionProximity (which encodes edge proximity geometry) would permanently
// darken all organic rock/soil faces even with no dissolution in progress.
if (vDissolutionProximity > 0.01 && dve_dissolveStartTime > -900.0) {
  // --- Temporal Dissolution Modulation (Fase 5.9) ---
  float dve_temporalFactor = 1.0;
  #ifdef DVE_DISSOLUTION_TEMPORAL
  if (dve_dissolveStartTime > -900.0) {
    float timeSinceExpose = dve_time - dve_dissolveStartTime;
    dve_temporalFactor = smoothstep(0.0, 0.8, timeSinceExpose);
  }
  #endif
  float animatedProximity = vDissolutionProximity * dve_temporalFactor;
  // Adhesion dampening: higher adhesion = material resists dissolution
  float adhesionDampen = 1.0 - vPullDirectionBias * 0.3;

  // --- Blue Noise Dissolution Discard (VERY AGGRESSIVE) ---
  float noiseVal = texture2D(dve_blueNoise, gl_FragCoord.xy / 64.0).r;
  // Second noise layer at different scale for more organic breakup
  float noiseVal2 = texture2D(dve_blueNoise, gl_FragCoord.xy / 37.0 + vec2(0.37, 0.73)).r;
  // Third layer for micro-detail
  float noiseVal3 = texture2D(dve_blueNoise, gl_FragCoord.xy / 23.0 + vec2(0.61, 0.19)).r;
  float combinedNoise = mix(mix(noiseVal, noiseVal2, 0.35), noiseVal3, 0.2);
  float dissolveThreshold = animatedProximity * dve_dissolutionIntensity * 2.2 * adhesionDampen;
  // R09: Anti-aliased dissolution edges — fwidth-based smooth discard replaces hard step.
  // fwidth gives the screen-space derivative, widening the transition band proportionally
  // to the rate of change across adjacent fragments → no more 1-pixel hard edge.
  float dve_aaWidth = max(fwidth(dissolveThreshold) * 1.5, 0.002);
  float dve_dissolveEdge = smoothstep(dissolveThreshold - dve_aaWidth, dissolveThreshold + dve_aaWidth, combinedNoise);
  if (dve_dissolveEdge < 0.004) discard;

  // --- Granular Normal Perturbation (VERY AGGRESSIVE) ---
  float grainScale = 25.0 * (1.0 - clamp(vPullStrength * 1.2, 0.0, 1.0));
  vec2 grainUV = vPositionW.xz * grainScale * 0.01;
  float grainNoise = texture2D(dve_blueNoise, grainUV).r - 0.5;
  float grainNoise2 = texture2D(dve_blueNoise, vPositionW.yz * grainScale * 0.007).r - 0.5;
  float grainNoise3 = texture2D(dve_blueNoise, vPositionW.xy * grainScale * 0.012).r - 0.5;
  vec3 grainPerturb = vec3(grainNoise + grainNoise3 * 0.4, grainNoise2, grainNoise * 0.7 + grainNoise3 * 0.3) * animatedProximity * 1.3;
  // Scale perturbation by dissolveEdge so edge fragments fade gracefully (R09)
  vNormalW = normalize(vNormalW + grainPerturb * smoothstep(0.02, 0.15, animatedProximity) * dve_dissolveEdge);
}
#endif
`,
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: /*glsl*/ `
#ifdef DVE_DISSOLUTION
// Same guard as UPDATE_ALBEDO: skip coloration/SSS/fresnel on non-dissolving blocks.
if (vDissolutionProximity > 0.01 && dve_dissolveStartTime > -900.0) {
  // Re-compute temporal factor for this injection point
  float dve_temporalFactor2 = 1.0;
  #ifdef DVE_DISSOLUTION_TEMPORAL
  if (dve_dissolveStartTime > -900.0) {
    float timeSinceExpose2 = dve_time - dve_dissolveStartTime;
    dve_temporalFactor2 = smoothstep(0.0, 0.8, timeSinceExpose2);
  }
  #endif
  float animProx = vDissolutionProximity * dve_temporalFactor2;
  float adhesionDampen2 = 1.0 - vPullDirectionBias * 0.3;

  // --- Contact Shadow Micro (AGGRESSIVE) ---
  float microOcclusion = 1.0 - vPullStrength * 0.35;
  finalDiffuse.rgb *= microOcclusion;
  // F04: Specular occlusion — pulled crevice geometry is self-shadowed; suppress specular in deep pockets.
  #ifdef SPECULARTERM
  finalSpecular.rgb *= (1.0 - vPullStrength * 0.55);
  #endif

  // --- Dissolution Color Shift (VERY AGGRESSIVE) ---
  vec3 edgeTint = vec3(0.0);
  ${isSoil ? "edgeTint = vec3(0.35, 0.25, 0.14);" : ""}
  ${isRock ? "edgeTint = vec3(-0.18, -0.12, 0.04);" : ""}
  ${isFlora ? "edgeTint = vec3(0.28, 0.16, -0.24);" : ""}
  // F03: Multiplicative tint — avoids additive luminance blowout on dissolution edges.
  // Stains surface hue toward soil/rock/flora tone without adding raw brightness.
  finalDiffuse.rgb = mix(finalDiffuse.rgb, finalDiffuse.rgb * max(vec3(0.0), vec3(1.0) + edgeTint * 1.8), clamp(animProx * 0.85, 0.0, 1.0));

  // --- Capillary Band (Darcy's Law, WIDER + DARKER) ---
  float capillaryZone = smoothstep(0.05, 0.25, animProx)
                      * (1.0 - smoothstep(0.25, 0.55, animProx));
  float wetDarkening = capillaryZone * vSubdivLevel * 0.45 * adhesionDampen2;
  finalDiffuse.rgb *= (1.0 - wetDarkening);

  // --- Fake Subsurface Scattering (uses curvature, not density) ---
  float sssThickness = animProx;
  // SSS is strongest where curvature is high (pullStrength high = more curved surface)
  float sssIntensity = smoothstep(0.05, 0.4, vPullStrength);
  vec3 sssColor = finalDiffuse.rgb * vec3(1.4, 0.9, 0.8);
  // View-independent SSS: wrapping term + backlight
  vec3 viewDir = normalize(vEyePosition.xyz - vPositionW);
  vec3 lightDir = normalize(-dve_sunDir);
  float wrapDiffuse = max(0.0, dot(normalize(vNormalW), lightDir) * 0.5 + 0.5);
  float backlight = max(0.0, dot(viewDir, lightDir));
  float sssFactor = max(wrapDiffuse * 0.5, backlight);
  finalDiffuse.rgb = mix(finalDiffuse.rgb, sssColor, sssThickness * sssIntensity * sssFactor * 1.1);

  // --- Fresnel on Dissolution Edges (curvature-enhanced) ---
  vec3 dveDissolveNormal = normalize(vNormalW);
  vec3 dveDissolveView = normalize(vEyePosition.xyz - vPositionW);
  float fresnel = pow(1.0 - max(dot(dveDissolveNormal, dveDissolveView), 0.0), 2.5);
  // Fresnel is STRONGER on curved surfaces (high pullStrength = more curvature)
  float curvatureBoost = 0.5 + vPullStrength * 0.5;
  float edgeFresnel = fresnel * animProx * curvatureBoost;
  finalDiffuse.rgb += edgeFresnel * 0.45;

  // --- Glitter de Grano Journey (STRONGER) ---
  if (animProx > 0.03) {
    float grainDensity = 25.0 + vSubdivLevel * 40.0;
    vec3 cellId = floor(vPositionW * grainDensity);
    vec3 grainNormal = normalize(fract(sin(dot(cellId, vec3(127.1, 311.7, 74.7))) * 43758.5453) * 2.0 - 1.0);
    vec3 halfVec = normalize(dveDissolveView + normalize(-dve_sunDir));
    float glitter = pow(max(dot(grainNormal, halfVec), 0.0), 128.0);
    finalDiffuse.rgb += glitter * animProx * 0.8;
  }

  // F01: Dissolution edge hot glow — narrow emissive band at the active dissolution front.
  // Band peaks around animProx ≈ 0.42; feeds DefaultRenderingPipeline bloom (threshold ≈ 0.52).
  float dve_glowBand = max(0.0, 1.0 - abs(animProx - 0.42) * 3.6);
  dve_glowBand = pow(dve_glowBand, 2.4) * smoothstep(0.08, 0.25, animProx);
  // Per-cell flicker: position hash gives organic, non-uniform glow variation.
  float dve_glowFlicker = 0.82 + 0.18 * fract(sin(dot(floor(vPositionW.xz * 8.0), vec2(127.1, 311.7))) * 43758.5);
  dve_glowFlicker *= 0.9 + 0.1 * sin(dve_time * 3.1 + vPositionW.x * 1.7 + vPositionW.z * 2.3);
  vec3 dve_hotGlowColor = vec3(1.5, 0.68, 0.08);
  ${isRock ? "dve_hotGlowColor = vec3(1.1, 0.86, 0.32);" : ""}
  ${isFlora ? "dve_hotGlowColor = vec3(0.6, 1.3, 0.15);" : ""}
  finalEmissive.rgb += dve_hotGlowColor * dve_glowBand * dve_glowFlicker * 0.6;

  // --- pH-Driven Weathering Color Shift (STRONGER) ---
  float acidShift = smoothstep(0.357, 0.1, vPhNormalized);
  finalDiffuse.rgb = mix(finalDiffuse.rgb, finalDiffuse.rgb * vec3(0.70, 0.58, 0.42), acidShift * 0.35);
  float alkaliShift = smoothstep(0.643, 0.9, vPhNormalized);
  finalDiffuse.rgb = mix(finalDiffuse.rgb, finalDiffuse.rgb * vec3(0.75, 0.88, 0.70), alkaliShift * 0.3);

  // --- Wet Film Dynamic (STRONGER, ALL materials) ---
  float wfSunExposure = clamp(animProx, 0.0, 1.0);
  float wfEnclosure = clamp(1.0 - animProx, 0.0, 1.0);
  float baseWetness = (1.0 - wfSunExposure) * wfEnclosure * vSubdivLevel * adhesionDampen2;
  // R17: Weather-driven wetness — dve_weatherState (0=clear, 1=rain) replaces
  // the purely periodic sin cycle with an externally-controlled weather ramp.
  float dve_rAmt = clamp((dve_weatherState - 0.3) / 0.55, 0.0, 1.0);
  float dve_rRamp = dve_rAmt * dve_rAmt * (3.0 - 2.0 * dve_rAmt); // smoothstep
  float rainCycle = smoothstep(0.4, 0.6, sin(dve_time * 0.01 + vPositionW.x * 0.1)) * (1.0 - dve_rRamp * 0.35);
  float wetness = min(baseWetness * (1.0 + (rainCycle + dve_rRamp) * 0.55), 1.0);
  finalDiffuse.rgb *= (1.0 - wetness * 0.4);

  // --- R07: Atmospheric Perspective / Altitude Fog ---
  // Distance-based aerial perspective: distant surfaces shift toward fog color
  float dveCamDist = length(vPositionW - vEyePosition.xyz);
  float aerialFactor = 1.0 - exp(-dveCamDist * 0.0035);
  aerialFactor = clamp(aerialFactor, 0.0, 0.6);
  vec3 aerialColor = vec3(0.62, 0.71, 0.84); // sky-blue aerial haze
  finalDiffuse.rgb = mix(finalDiffuse.rgb, aerialColor, aerialFactor * 0.35);
  // Altitude desaturation: higher = more washed out (mountain haze)
  float altFactor = smoothstep(40.0, 120.0, vPositionW.y);
  float saturation = 1.0 - altFactor * 0.25;
  float lum = dot(finalDiffuse.rgb, vec3(0.299, 0.587, 0.114));
  finalDiffuse.rgb = mix(vec3(lum), finalDiffuse.rgb, saturation);

  // R06: Vertex-baked AO — darken concave crevices between pulled vertices.
  // vSubdivAO = 0 (fully occluded, deep crevice) → 1 (open sky above).
  // Applied after all color modifiers so it correctly darkens the final surface.
  float dve_aoFactor = mix(0.52, 1.0, vSubdivAO);
  finalDiffuse.rgb *= dve_aoFactor;

  // R16: Rock strata crack lines — darken fracture networks during dissolution.
  // FBM-perturbed horizontal banding simulates sedimentary layering breakup.
  #ifdef DVE_FAMILY_ROCK
  {
    float dve_strataT = fract(vPositionW.y * 0.65);
    float dve_strataLine = 1.0 - smoothstep(0.0, 0.12, abs(dve_strataT - 0.5) * 2.0);
    float dve_crackNoise = texture2D(dve_blueNoise, vPositionW.xz * 0.07 + vec2(0.3, 0.5)).r;
    float dve_crackMask = dve_strataLine * smoothstep(0.35, 0.65, dve_crackNoise);
    finalDiffuse.rgb = mix(finalDiffuse.rgb, finalDiffuse.rgb * 0.45, dve_crackMask * animProx * 0.65);
  }
  #endif
}
// R16: Sedimentary strata tinting — warm/cool alternating Y-bands always visible on rock.
// Simulates mineral layer colour variation without UV distortion.
#ifdef DVE_FAMILY_ROCK
{
  float dve_bandT = sin(vPositionW.y * 1.15) * 0.5 + 0.5;
  vec3 dve_warmBand = vec3(1.04, 0.98, 0.93);
  vec3 dve_coolBand = vec3(0.95, 0.98, 1.04);
  finalDiffuse.rgb *= mix(dve_coolBand, dve_warmBand, dve_bandT * 0.16 + 0.84);
}
#endif
// R02: Shore transition zone — wet sand darkening + foam ring at waterline.
// Uses world-Y vs dve_seaLevel as water-adjacency proxy (no extra vertex attribute needed).
#if defined(DVE_FAMILY_SAND) || defined(DVE_FAMILY_ROCK)
{
  float dve_shoreProx = clamp(1.0 - smoothstep(dve_seaLevel, dve_seaLevel + 3.5, vPositionW.y), 0.0, 1.0);
  if (dve_shoreProx > 0.02) {
    // Wet sand progressively darkens toward waterline
    finalDiffuse.rgb *= mix(1.0, 0.62, dve_shoreProx * 0.75);
    // Foam crescent at the waterline transition
    float dve_foamLine = smoothstep(0.0, 0.1, dve_shoreProx) * (1.0 - smoothstep(0.12, 0.28, dve_shoreProx));
    finalDiffuse.rgb = mix(finalDiffuse.rgb, vec3(0.95, 0.96, 0.98), dve_foamLine * 0.50);
  }
}
#endif
#endif
`,
        // R08: Roughness/metallic micro-variation driven by dissolution state
        CUSTOM_FRAGMENT_UPDATE_MICROSURFACE_AND_REFLECTIVITY: /*glsl*/ `
#ifdef DVE_DISSOLUTION
if (vDissolutionProximity > 0.01) {
  // Dissolution-edge vertices are rougher (exposed grain/fracture surface)
  float dve_roughnessNoise = fract(sin(dot(vPositionW.xyz, vec3(17.03, 31.27, 7.51))) * 43758.5453);
  float dve_roughnessBoost = vDissolutionProximity * 0.25 * (0.7 + dve_roughnessNoise * 0.6);
  // Pull strength = more deformed = rougher surface
  dve_roughnessBoost += vPullStrength * 0.12;
  // Reduce microsurface (=increase roughness in PBR terms)
  microSurface = clamp(microSurface - dve_roughnessBoost, 0.04, 1.0);
  // Slight reflectivity increase for wet/exposed mineral surfaces
  reflectivityOut *= (1.0 + vDissolutionProximity * 0.15);
}
// R02: Shore zone microSurface gloss — sand and rock near sea level is always glossy (wet surface).
#if defined(DVE_FAMILY_SAND) || defined(DVE_FAMILY_ROCK)
{
  float dve_shoreGloss = clamp(1.0 - smoothstep(dve_seaLevel, dve_seaLevel + 3.5, vPositionW.y), 0.0, 1.0);
  microSurface = mix(microSurface, 0.89, dve_shoreGloss * 0.65);
}
#endif
#endif
`,
      };
    }

    return null;
  }
}
