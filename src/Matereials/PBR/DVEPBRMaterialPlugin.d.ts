import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { DVEBRPBRMaterial } from "./DVEBRPBRMaterial";
export declare class DVEPBRMaterialPlugin extends MaterialPluginBase {
    dveMaterial: DVEBRPBRMaterial;
    onUBSet: (uniformBuffer: UniformBuffer) => void;
    uniformBuffer: UniformBuffer;
    private static frameTimes;
    id: `${string}-${string}-${string}-${string}-${string}`;
    private hasImportedMaterialMapsEnabled;
    private shouldUseImportedMaterialMaps;
    constructor(material: PBRMaterial, name: string, dveMaterial: DVEBRPBRMaterial, onUBSet: (uniformBuffer: UniformBuffer) => void);
    hasTexture(texture: BaseTexture): boolean;
    getActiveTextures(activeTextures: BaseTexture[]): BaseTexture[];
    prepareDefines(defines: any): void;
    getClassName(): string;
    getSamplers(samplers: string[]): void;
    getAttributes(attributes: string[]): void;
    getUniforms(): {
        ubo: ({
            name: string;
            size?: undefined;
        } | {
            name: string;
            size: number;
        })[];
    };
    _textureBound: boolean;
    bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, engine: Engine): void;
    hardBindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, engine: Engine): void;
    isReadyForSubMesh(): boolean;
    private bindResources;
    getCustomCode(shaderType: any): {
        CUSTOM_VERTEX_DEFINITIONS: string;
        CUSTOM_VERTEX_UPDATE_NORMAL: string;
        CUSTOM_VERTEX_MAIN_BEGIN: string;
        CUSTOM_VERTEX_UPDATE_POSITION: string;
        CUSTOM_FRAGMENT_DEFINITIONS?: undefined;
        CUSTOM_FRAGMENT_UPDATE_ALBEDO?: undefined;
        CUSTOM_FRAGMENT_UPDATE_MICROSURFACE?: undefined;
        CUSTOM_FRAGMENT_BEFORE_LIGHTS?: undefined;
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION?: undefined;
        CUSTOM_FRAGMENT_MAIN_END?: undefined;
    } | {
        CUSTOM_FRAGMENT_DEFINITIONS: string;
        CUSTOM_FRAGMENT_UPDATE_ALBEDO: string;
        CUSTOM_FRAGMENT_UPDATE_MICROSURFACE: string;
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: string;
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: string;
        CUSTOM_FRAGMENT_MAIN_END: string;
        CUSTOM_VERTEX_DEFINITIONS?: undefined;
        CUSTOM_VERTEX_UPDATE_NORMAL?: undefined;
        CUSTOM_VERTEX_MAIN_BEGIN?: undefined;
        CUSTOM_VERTEX_UPDATE_POSITION?: undefined;
    } | null;
}
