import { DVEBRDefaultMaterialBaseData } from "../../Matereials/Types/DVEBRDefaultMaterial.types";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent";
import "@babylonjs/core/Rendering/prePassRendererSceneComponent";
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent";
import { WorkItemProgress } from "@divinevoxel/vlox/Util/WorkItemProgress";
export type DVEBRPBRData = DVEBRDefaultMaterialBaseData & {
    getProgress?: (progress: WorkItemProgress) => void;
};
export default function InitDVEPBR(initData: DVEBRPBRData): Promise<import("../../Renderer/DVEBabylonRenderer").DVEBabylonRenderer>;
