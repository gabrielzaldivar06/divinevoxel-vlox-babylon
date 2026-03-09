import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { DVEBRPBRMaterial } from "./DVEBRPBRMaterial";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";

export class DVEPBRMaterialPlugin extends MaterialPluginBase {
  uniformBuffer: UniformBuffer;

  id = crypto.randomUUID();
  constructor(
    material: PBRMaterial,
    name: string,
    public dveMaterial: DVEBRPBRMaterial,
    public onUBSet: (uniformBuffer: UniformBuffer) => void
  ) {
    //  shaders.set(material.id, dveMaterial.shader);
    //  textures.set(material.id, dveMaterial.texture);

    super(material, name, 20, {
      [`DVE_${name}`]: false,
    });

    this._enable(true);
  }

  hasTexture(texture: BaseTexture): boolean {
    return true;
  }
  /*   getActiveTextures(activeTextures: BaseTexture[]) {
    const texture = textures.get(this._material.id);
    if (!texture) return [];

    for (const [key, segment] of texture.segments) {
      if (!segment.shaderTexture) continue;
      activeTextures.push(segment.shaderTexture._texture);
    }
    return activeTextures;
  } */

  prepareDefines(defines: any) {
    defines[`DVE_${this.name}`] = true;
  }

  getClassName() {
    return "DVEPBRMaterialPlugin";
  }
  /* 
  getSamplers(samplers: string[]) {
    const shader = this.dveMaterial?.shader || shaders.get(this._material.id)!;
  
    samplers.push(...shader.getTextureList());
  }

  getAttributes(attributes: string[]) {
    const shader = this.dveMaterial?.shader || shaders.get(this._material.id)!;
    for(const atr of shader.data.mesh.getAttributeList()){
      if(["position","normal"].includes(atr))continue;
    }
    attributes.push(...shader.data.mesh.getAttributeList());
  } */

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
    if (!this.uniformBuffer) this.uniformBuffer = uniformBuffer;
  }

  //@ts-ignore
  getCustomCode(shaderType: any) {
    const terrain = EngineSettings.settings.terrain;
    const isLiquid = this.name.includes("liquid");
    const isTransparent = this.name.includes("transparent");
    const isGlow = this.name.includes("glow");
    const enableVisualV2 = terrain.visualV2 && !isLiquid;
    const enableMacroVariation = terrain.macroVariation && !isLiquid && !isTransparent && !isGlow;
    const enableTriplanar = terrain.materialTriplanar && !isLiquid && !isTransparent;
    const enableWetness = terrain.materialWetness && !isLiquid && !isTransparent && !isGlow;
    const enableMicroVariation = terrain.microVariation && !isLiquid && !isTransparent;
    const textures = "";
    const varying = "";

    const attributes = "";
    const functions =
      enableVisualV2 || enableTriplanar || enableWetness
        ? /* glsl */ `
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

vec3 dveBlendWeights(vec3 normalDir) {
  vec3 weights = pow(abs(normalDir), vec3(6.0));
  return weights / max(dot(weights, vec3(1.0)), 0.0001);
}

vec4 dveProjectedColor(vec2 uv) {
  return toLinearSpace(getBaseColor(fract(uv)));
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
`
        : "";
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: /*glsl*/ `
#ifdef  DVE_${this.name}
const float lightGradient[16] = float[16]( 0.06, 0.1, 0.11, 0.14, 0.17, 0.21, 0.26, 0.31, 0.38, 0.45, 0.54, 0.64, 0.74, 0.85, 0.97, 1.);
${attributes}
${varying}

#endif
`,
        CUSTOM_VERTEX_UPDATE_NORMAL: /*glsl*/ `
#ifdef  DVE_${this.name}
#ifdef  DVE_dve_liquid
vec3 noisePOS = vec3(worldPOSNoOrigin.x/10., worldPOSNoOrigin.y, worldPOSNoOrigin.z/10.);

// Sample the noise at the current position
float noiseSample = fbm3(noisePOS  + time * 0.01) * 0.1;

// Calculate the gradient (partial derivatives) of the noise to adjust normals
vec3 dNoise_dPos;
dNoise_dPos.x = fbm3(noisePOS + vec3(0.01, 0.0, 0.0) + time * 0.01) - noiseSample;
dNoise_dPos.y = fbm3(noisePOS + vec3(0.0, 0.01, 0.0) + time * 0.01) - noiseSample;
dNoise_dPos.z = fbm3(noisePOS + vec3(0.0, 0.0, 0.01) + time * 0.01) - noiseSample;

// Adjust the normal with the gradient of the noise function
normalUpdated += dNoise_dPos * 0.1; // Adjust multiplier as needed for visual effect

// Update the position to simulate wave heights
positionUpdated = vec3(
    positionUpdated.x,
    positionUpdated.y + noiseSample, // Adding, assuming 'y' is up. Adjust as needed.
    positionUpdated.z
);

#endif
#endif

`,

        CUSTOM_VERTEX_MAIN_BEGIN: /*glsl*/ `
#ifdef  DVE_${this.name}
${varying}



#endif
        `,
      };
    }
    if (shaderType === "fragment") {
      const albedoEnhancement = !isLiquid
        ? /* glsl */ `
vec3 dveNormalW = normalize(vNormalW);
float dveSlope = 1.0 - abs(dveNormalW.y);
`
        : "";
      const visualV2Code = enableVisualV2
        ? /* glsl */ `
voxelBaseColor.rgb = pow(max(voxelBaseColor.rgb, vec3(0.0)), vec3(0.94));
`
        : "";
      const macroVariationCode = enableMacroVariation
        ? /* glsl */ `
float dveMacro = clamp(dveFbm3(vPositionW * 0.035) * 1.1, 0.0, 1.0);
float dveMacroPatch = dveFbm3(vPositionW * 0.012 + vec3(-9.7, 5.2, 11.1));
vec3 dveMacroTint = mix(vec3(0.86, 0.82, 0.78), vec3(1.08, 1.04, 0.98), clamp(dveMacro * 0.65 + dveMacroPatch * 0.35, 0.0, 1.0));
voxelBaseColor.rgb *= dveMacroTint;
`
        : "";
      const triplanarCode = enableTriplanar
        ? /* glsl */ `
vec3 dveBlend = dveBlendWeights(dveNormalW);
vec3 dveWorldUV = vPositionW * 0.12;
vec4 dveXColor = dveProjectedColor(dveWorldUV.yz);
vec4 dveYColor = dveProjectedColor(dveWorldUV.xz);
vec4 dveZColor = dveProjectedColor(dveWorldUV.xy);
vec4 dveTriplanarColor = dveXColor * dveBlend.x + dveYColor * dveBlend.y + dveZColor * dveBlend.z;
dveTriplanarColor = getAO(dveTriplanarColor);
float dveTriplanarMix = smoothstep(0.18, 0.82, dveSlope) * 0.65;
voxelBaseColor = mix(voxelBaseColor, dveTriplanarColor, dveTriplanarMix);
`
        : "";
      const wetnessAlbedoCode = enableWetness
        ? /* glsl */ `
float dveWetnessMask = dveComputeWetness(dveNormalW, vPositionW);
voxelBaseColor.rgb = mix(
  voxelBaseColor.rgb,
  voxelBaseColor.rgb * vec3(0.72, 0.76, 0.82),
  dveWetnessMask * 0.28
);
`
        : "";
      const microVariationCode = enableMicroVariation
        ? /* glsl */ `
float dveMicro = dveFbm3(vPositionW * 0.42 + dveNormalW * 1.8);
float dveMicroEdge = dveEdgeMask(fract(vPositionW.xz * 0.25 + vPositionW.y * 0.05));
voxelBaseColor.rgb = mix(
  voxelBaseColor.rgb,
  voxelBaseColor.rgb * mix(vec3(0.92, 0.9, 0.88), vec3(1.08, 1.05, 1.02), dveMicro),
  0.08
);
voxelBaseColor.rgb = mix(voxelBaseColor.rgb, voxelBaseColor.rgb * vec3(0.84, 0.82, 0.8), dveMicroEdge * 0.05);
`
        : "";
      const wetnessMicroSurfaceCode = enableWetness
        ? /* glsl */ `
#ifdef  DVE_${this.name}
vec3 dveNormalW = normalize(vNormalW);
float dveWetnessMask = dveComputeWetness(dveNormalW, vPositionW);
microSurface = mix(microSurface, 0.96, dveWetnessMask * 0.7);
surfaceReflectivityColor = mix(
  surfaceReflectivityColor,
  max(surfaceReflectivityColor, vec3(0.08, 0.08, 0.08)),
  dveWetnessMask * 0.25
);
#endif
`
        : "";
      const wetnessFinalCode = enableWetness
        ? /* glsl */ `
vec3 dveNormalW = normalize(vNormalW);
float dveWetnessMask = dveComputeWetness(dveNormalW, vPositionW);
finalDiffuse.rgb = mix(finalDiffuse.rgb, finalDiffuse.rgb * vec3(0.92, 0.94, 0.97), dveWetnessMask * 0.18);
`
        : "";
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: /*glsl*/ `
#ifdef  DVE_${this.name}
precision highp sampler2DArray;
const float lightGradient[16] = float[16]( 0.06, 0.1, 0.11, 0.14, 0.17, 0.21, 0.26, 0.31, 0.38, 0.45, 0.54, 0.64, 0.74, 0.85, 0.97, 1.);
${textures}
${varying}
${functions}
#endif
`,

        CUSTOM_FRAGMENT_UPDATE_ALBEDO: /*glsl*/ `
#ifdef  DVE_${this.name}

#ifndef  DVE_dve_liquid
vec4 voxelBaseColor = toLinearSpace(getBaseColor(vec2(0.,0.)));
voxelBaseColor = getAO(voxelBaseColor);
${albedoEnhancement}
${visualV2Code}
${macroVariationCode}
${triplanarCode}
${wetnessAlbedoCode}
${microVariationCode}
surfaceAlbedo = vec3(voxelBaseColor.r,voxelBaseColor.g,voxelBaseColor.b);
alpha = voxelBaseColor.a;
#endif

#ifdef  DVE_dve_liquid
vec4 voxelBaseColor = vec4(VOXEL[2].rgb + 1.,1.) *  vec4(.2, .58, .79,1.);
surfaceAlbedo = toLinearSpace(vec3(voxelBaseColor.r,voxelBaseColor.g,voxelBaseColor.b));
alpha = .9;

#endif


#endif
`,
  CUSTOM_FRAGMENT_UPDATE_MICROSURFACE: /*glsl*/ `
${wetnessMicroSurfaceCode}
`,
        /* "!finalIrradiance\\*\\=surfaceAlbedo.rgb;":
`finalIrradiance*=surfaceAlbedo.rgb;\nfinalIrradiance = vec3(VOXEL[2].rgb ) ;`, */
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: /*glsl*/ `
#ifdef  DVE_${this.name}

if(finalDiffuse.r * VOXEL[2].r > finalDiffuse.r) {
  finalDiffuse.r *= VOXEL[2].r;
}
if(finalDiffuse.g * VOXEL[2].g > finalDiffuse.g) {
  finalDiffuse.g *= VOXEL[2].g;
}
if(finalDiffuse.b * VOXEL[2].b > finalDiffuse.b) {
  finalDiffuse.b *= VOXEL[2].b;
}
//add base color
finalDiffuse.rgb += .01;
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
