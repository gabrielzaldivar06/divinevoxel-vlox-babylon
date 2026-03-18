import { DVERenderer } from "@divinevoxel/vlox/Renderer/DVERenderer";
import { Scene } from "@babylonjs/core/scene";
import { DVEBRMeshCuller } from "./DVEBRMeshCuller";
import { DVEBRFOManager } from "./DVEBRFOManger";
import { DivineVoxelEngineRender } from "@divinevoxel/vlox/Contexts/Render/DivineVoxelEngineRender.js";
import type { Engine } from "@babylonjs/core/Engines/engine";
import { DVEBRSectionMeshesSingleBuffer } from "../Scene/SingleBuffer/DVEBRSectionMeshesSingleBuffer";
import { DVEBRMaterialRegister } from "../Matereials/DVEBRNodeMaterialsManager";
import { SceneOptions } from "../Scene/SceneOptions";
import { DVEBRSectionMeshesMultiBuffer } from "../Scene/MultiBuffer/DVEBRSectionMeshesMultiBuffer";
import { SplatManager } from "../Splats/SplatManager";
import { LODSectorTracker } from "../LOD/LODSectorTracker";
export interface DVEBabylonRendererInitData {
    scene: Scene;
}
export declare class DVEBabylonRenderer extends DVERenderer {
    static instance: DVEBabylonRenderer;
    sectorMeshes: DVEBRSectionMeshesSingleBuffer | DVEBRSectionMeshesMultiBuffer;
    engine: Engine;
    scene: Scene;
    foManager: DVEBRFOManager;
    meshCuller: DVEBRMeshCuller;
    materials: DVEBRMaterialRegister;
    sceneOptions: SceneOptions;
    splatManager: SplatManager | null;
    lodTracker: LODSectorTracker | null;
    constructor(data: DVEBabylonRendererInitData);
    init(dver: DivineVoxelEngineRender): Promise<void>;
}
