import { DVEBabylonRenderer } from "../../Renderer/DVEBabylonRenderer.js";
import { DVEBRDefaultMaterialBaseData } from "../../Matereials/Types/DVEBRDefaultMaterial.types.js";
import type { Scene } from "@babylonjs/core/scene";
import { NodeMaterialData } from "@divinevoxel/vlox/Renderer/DVERenderNode.types";
import { TextureData } from "@divinevoxel/vlox/Textures/Texture.types.js";
import { MaterialInterface } from "../../Matereials/MaterialInterface.js";
import { WorkItemProgress } from "@divinevoxel/vlox/Util/WorkItemProgress.js";
import "@babylonjs/core/Animations/animatable";
export declare function CreateTextures(scene: Scene, textureData: TextureData[], progress: WorkItemProgress): Promise<void>;
export declare function CreateDefaultRenderer(initData: DVEBRDefaultMaterialBaseData & {
    scene: Scene;
    createMaterial: (renderer: DVEBabylonRenderer, scene: Scene, matData: NodeMaterialData) => MaterialInterface;
    afterCreate?: (renderer: DVEBabylonRenderer, materials: MaterialInterface[]) => Promise<void>;
    progress: WorkItemProgress;
}): Promise<DVEBabylonRenderer>;
