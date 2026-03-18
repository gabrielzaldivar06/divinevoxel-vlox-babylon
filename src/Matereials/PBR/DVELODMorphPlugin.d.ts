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
export declare class DVELODMorphPlugin extends MaterialPluginBase {
    private _scene;
    /** Current morph factor — set by the LOD system each frame. */
    private _morphFactor;
    constructor(material: PBRMaterial, name: string, _scene: Scene);
    /** Update the morph factor (0 = full detail, 1 = fully flat). */
    setMorphFactor(value: number): void;
    prepareDefines(defines: any): void;
    getClassName(): string;
    getAttributes(attributes: string[]): void;
    getUniforms(): {
        ubo: {
            name: string;
        }[];
    };
    isReadyForSubMesh(): boolean;
    bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, engine: Engine): void;
    hardBindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, engine: Engine): void;
    private _bindResources;
    getCustomCode(shaderType: any): {
        CUSTOM_VERTEX_DEFINITIONS: string;
        CUSTOM_VERTEX_MAIN_BEGIN: string;
        CUSTOM_VERTEX_UPDATE_POSITION: string;
        CUSTOM_FRAGMENT_DEFINITIONS?: undefined;
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION?: undefined;
    } | {
        CUSTOM_FRAGMENT_DEFINITIONS: string;
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: string;
        CUSTOM_VERTEX_DEFINITIONS?: undefined;
        CUSTOM_VERTEX_MAIN_BEGIN?: undefined;
        CUSTOM_VERTEX_UPDATE_POSITION?: undefined;
    } | null;
}
