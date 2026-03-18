import type { Engine } from "@babylonjs/core/Engines/engine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
export declare class DVEDissolutionPlugin extends MaterialPluginBase {
    private _scene;
    private _blueNoiseTex;
    /** Fase 5: timestamp when this sector's dissolution started (-999 = static/complete). */
    private _dissolveStartTime;
    constructor(material: PBRMaterial, name: string, _scene: Scene);
    /** Fase 5: Set the dissolution start time for temporal animation. */
    setDissolveStartTime(time: number): void;
    prepareDefines(defines: any): void;
    getClassName(): string;
    getSamplers(samplers: string[]): void;
    getAttributes(attributes: string[]): void;
    getUniforms(): {
        ubo: ({
            name: string;
            size?: undefined;
            type?: undefined;
        } | {
            name: string;
            size: number;
            type: string;
        })[];
    };
    isReadyForSubMesh(): boolean;
    bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, engine: Engine): void;
    hardBindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, engine: Engine): void;
    private _bindResources;
    getCustomCode(shaderType: any): {
        CUSTOM_VERTEX_DEFINITIONS: string;
        CUSTOM_VERTEX_MAIN_BEGIN: string;
        CUSTOM_FRAGMENT_DEFINITIONS?: undefined;
        CUSTOM_VERTEX_UPDATE_POSITION?: undefined;
        CUSTOM_FRAGMENT_UPDATE_ALBEDO?: undefined;
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION?: undefined;
        CUSTOM_FRAGMENT_UPDATE_MICROSURFACE_AND_REFLECTIVITY?: undefined;
    } | {
        CUSTOM_FRAGMENT_DEFINITIONS: string;
        CUSTOM_VERTEX_DEFINITIONS?: undefined;
        CUSTOM_VERTEX_MAIN_BEGIN?: undefined;
        CUSTOM_VERTEX_UPDATE_POSITION?: undefined;
        CUSTOM_FRAGMENT_UPDATE_ALBEDO?: undefined;
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION?: undefined;
        CUSTOM_FRAGMENT_UPDATE_MICROSURFACE_AND_REFLECTIVITY?: undefined;
    } | {
        CUSTOM_VERTEX_DEFINITIONS: string;
        CUSTOM_VERTEX_MAIN_BEGIN: string;
        CUSTOM_VERTEX_UPDATE_POSITION: string;
        CUSTOM_FRAGMENT_DEFINITIONS?: undefined;
        CUSTOM_FRAGMENT_UPDATE_ALBEDO?: undefined;
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION?: undefined;
        CUSTOM_FRAGMENT_UPDATE_MICROSURFACE_AND_REFLECTIVITY?: undefined;
    } | {
        CUSTOM_FRAGMENT_DEFINITIONS: string;
        CUSTOM_FRAGMENT_UPDATE_ALBEDO: string;
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: string;
        CUSTOM_FRAGMENT_UPDATE_MICROSURFACE_AND_REFLECTIVITY: string;
        CUSTOM_VERTEX_DEFINITIONS?: undefined;
        CUSTOM_VERTEX_MAIN_BEGIN?: undefined;
        CUSTOM_VERTEX_UPDATE_POSITION?: undefined;
    } | null;
}
