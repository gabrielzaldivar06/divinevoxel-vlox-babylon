/**
 * DVELODMorphPlugin — Fase 4
 *
 * MaterialPluginBase (priority 22) that handles:
 *  - Vertex morph: in transition bands, interpolate between pulled
 *    position and flat position using pullStrength.
 *  - Far-band vertex warp: subtle displacement in Far band.
 *  - Fragment dissolve fade: fade dissolution effects based on morph factor.
 *
 * Uniform: dve_morphFactor (0 = full detail, 1 = fully flattened/LOD)
 *
 * Priority chain: PBR(20) → Dissolution(21) → LODMorph(22)
 */

import type { Engine } from "@babylonjs/core/Engines/engine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";
import { classifyTerrainMaterial } from "./MaterialFamilyProfiles";
import { SharedVoxelAttributes } from "./SharedVoxelAttributes";

export class DVELODMorphPlugin extends MaterialPluginBase {
  /** Current morph factor — set by the LOD system each frame. */
  private _morphFactor = 0;

  constructor(
    material: PBRMaterial,
    name: string,
    private _scene: Scene
  ) {
    super(material, name, 22, {
      DVE_LOD_MORPH: false,
    });
    this._enable(true);
  }

  /** Update the morph factor (0 = full detail, 1 = fully flat). */
  setMorphFactor(value: number) {
    this._morphFactor = value;
  }

  prepareDefines(defines: any) {
    const terrain = EngineSettings.settings.terrain;
    if (!terrain.lodMorph) {
      defines.DVE_LOD_MORPH = false;
      return;
    }

    const mc = classifyTerrainMaterial(this.name);
    const isOrganic =
      mc.isSoil || mc.isFlora || mc.isWood || mc.isRock ||
      mc.isCultivated || mc.isExotic;
    if (!isOrganic || mc.isLiquid) {
      defines.DVE_LOD_MORPH = false;
      return;
    }

    defines.DVE_LOD_MORPH = true;
  }

  getClassName() {
    return "DVELODMorphPlugin";
  }

  getAttributes(attributes: string[]) {
    // Declare explicitly so this plugin works regardless of whether
    // DVEDissolutionPlugin is also present. BabylonJS deduplicates attributes.
    attributes.push(
      SharedVoxelAttributes.PullStrength,
      SharedVoxelAttributes.SubdivLevel
    );
  }

  getUniforms() {
    return {
      ubo: [{ name: "dve_morphFactor" }],
    };
  }

  isReadyForSubMesh(): boolean {
    return true;
  }

  bindForSubMesh(
    uniformBuffer: UniformBuffer,
    scene: Scene,
    engine: Engine
  ) {
    this._bindResources();
  }

  hardBindForSubMesh(
    uniformBuffer: UniformBuffer,
    scene: Scene,
    engine: Engine
  ) {
    this._bindResources();
  }

  private _bindResources() {
    const effect = this._material.getEffect();
    if (!effect) return;
    effect.setFloat("dve_morphFactor", this._morphFactor);
  }

  //@ts-ignore
  getCustomCode(shaderType: any) {
    const terrain = EngineSettings.settings.terrain;
    if (!terrain.lodMorph) return null;

    const mc = classifyTerrainMaterial(this.name);
    const isOrganic =
      mc.isSoil || mc.isFlora || mc.isWood || mc.isRock ||
      mc.isCultivated || mc.isExotic;
    if (!isOrganic || mc.isLiquid) return null;

    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: /*glsl*/ `
#ifdef DVE_LOD_MORPH
uniform float dve_morphFactor;
varying float vLodMorphFactor;
#endif
`,
        CUSTOM_VERTEX_MAIN_BEGIN: /*glsl*/ `
#ifdef DVE_LOD_MORPH
vLodMorphFactor = dve_morphFactor;
#endif
`,
        // Runs after liquid waves (same injection point, appended)
        CUSTOM_VERTEX_UPDATE_POSITION: /*glsl*/ `
#ifdef DVE_LOD_MORPH
{
  // pullStrength is already declared by DVEDissolutionPlugin attribute
  // Reconstruct the "flat" (un-pulled) position
  float dve_ps = pullStrength;  // 0 = no pull, 1 = max pull
  float maxPullDist = 0.25;     // matches SubdivisionBuilder MAX_PULL_DISTANCE
  vec3 flatPosition = positionUpdated - normalUpdated * dve_ps * maxPullDist;

  // In transition band, morph from pulled → flat
  positionUpdated = mix(positionUpdated, flatPosition, dve_morphFactor);

  // Far-band subtle warp: gentle vertex noise when fully morphed
  if (dve_morphFactor > 0.95) {
    float warpAmt = dve_ps * 0.02;
    positionUpdated += normalUpdated * warpAmt;
  }
}
#endif
`,
      };
    }

    if (shaderType === "fragment") {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: /*glsl*/ `
#ifdef DVE_LOD_MORPH
uniform float dve_morphFactor;
varying float vLodMorphFactor;
#endif
`,
        // Fade dissolution visual effects as we morph away
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: /*glsl*/ `
#ifdef DVE_LOD_MORPH
{
  // Scale down dissolution visual intensity as morph increases
  // At morphFactor=1 dissolution effects are invisible
  float dissolveFade = 1.0 - vLodMorphFactor;
  finalDiffuse.rgb = mix(
    finalDiffuse.rgb,
    surfaceAlbedo.rgb,
    vLodMorphFactor * 0.5
  );
}
#endif
`,
      };
    }

    return null;
  }
}
