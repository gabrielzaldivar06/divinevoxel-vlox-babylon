import { DVERenderer } from "@divinevoxel/vlox/Renderer/DVERenderer";
import { Scene } from "@babylonjs/core/scene";
import { DVEBRMeshCuller } from "./DVEBRMeshCuller";
import { DVEBRFOManager } from "./DVEBRFOManger";
import { DivineVoxelEngineRender } from "@divinevoxel/vlox/Contexts/Render/DivineVoxelEngineRender.js";
import type { Engine } from "@babylonjs/core/Engines/engine";
import { DVEBRSectionMeshesSingleBuffer } from "../Scene/SingleBuffer/DVEBRSectionMeshesSingleBuffer";
import { DVEBRMaterialRegister } from "../Matereials/DVEBRNodeMaterialsManager";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";
import { SingleBufferVoxelScene } from "../Scene/SingleBuffer/SingleBufferVoxelScene";
import { SceneOptions } from "../Scene/SceneOptions";
import { DVEBRSectionMeshesMultiBuffer } from "../Scene/MultiBuffer/DVEBRSectionMeshesMultiBuffer";
import { SplatManager } from "../Splats/SplatManager";
import { LODSectorTracker } from "../LOD/LODSectorTracker";
import { MeshManager } from "@divinevoxel/vlox/Renderer/MeshManager";
import { VoxelTagsRegister } from "@divinevoxel/vlox/Voxels/Data/VoxelTagsRegister";
import { VoxelTagIds } from "@divinevoxel/vlox/Voxels/Data/VoxelTag.types";
import {
  classifyTerrainMaterial,
  TerrainMaterialFamily,
} from "../Matereials/PBR/MaterialFamilyProfiles";

/** Neutral base color per material family for fracture splats. */
function familyDefaultColor(family: string): [number, number, number] {
  switch (family) {
    case TerrainMaterialFamily.Soil:
      return [120, 90, 60];
    case TerrainMaterialFamily.Flora:
      return [80, 130, 55];
    case TerrainMaterialFamily.Wood:
      return [140, 100, 60];
    case TerrainMaterialFamily.Rock:
      return [140, 140, 135];
    case TerrainMaterialFamily.Cultivated:
      return [110, 95, 55];
    case TerrainMaterialFamily.Exotic:
      return [160, 80, 180];
    default:
      return [130, 120, 110];
  }
}
export interface DVEBabylonRendererInitData {
  scene: Scene;
}
export class DVEBabylonRenderer extends DVERenderer {
  static instance: DVEBabylonRenderer;
  sectorMeshes: DVEBRSectionMeshesSingleBuffer | DVEBRSectionMeshesMultiBuffer;
  engine: Engine;
  scene: Scene;
  foManager: DVEBRFOManager;
  meshCuller: DVEBRMeshCuller;

  materials = new DVEBRMaterialRegister();

  sceneOptions: SceneOptions;
  splatManager: SplatManager | null = null;
  lodTracker: LODSectorTracker | null = null;

  constructor(data: DVEBabylonRendererInitData) {
    super();
    this.engine = data.scene.getEngine() as any;
    this.scene = data.scene;
    this.foManager = new DVEBRFOManager();
    this.meshCuller = new DVEBRMeshCuller();

    this.sceneOptions = new SceneOptions(this.scene);
    if (EngineSettings.settings.rendererSettings.bufferMode == "single") {
      this.sectorMeshes = new DVEBRSectionMeshesSingleBuffer(
        data.scene,
        this.engine,
        this,
        new SingleBufferVoxelScene(this, this.sceneOptions)
      );
    } else {
      this.sectorMeshes = new DVEBRSectionMeshesMultiBuffer(
        data.scene,
        this.engine,
        this
      );
    }

    this.meshCuller.init(
      this.scene,
      EngineSettings.settings.rendererSettings.bufferMode
    );
    if (!DVEBabylonRenderer.instance) DVEBabylonRenderer.instance = this;

    return DVEBabylonRenderer.instance;
  }

  async init(dver: DivineVoxelEngineRender) {
    if (this.sectorMeshes instanceof DVEBRSectionMeshesSingleBuffer) {
      const sectorMeshes = this.sectorMeshes as DVEBRSectionMeshesSingleBuffer;
      sectorMeshes.voxelScene.init(this.scene);

      this.scene.registerBeforeRender(() => {
        sectorMeshes.voxelScene.beforRender();
      });
    }

    // Initialize SplatManager when dissolutionSplats is enabled
    if (EngineSettings.settings.terrain.dissolutionSplats) {
      this.splatManager = new SplatManager(this.scene);

      MeshManager.onSectionUpdated = (sectorKey, meshes) => {
        this.splatManager!.processSectionMeshes(sectorKey, meshes);
      };

      MeshManager.onSectorRemoved = (sectorKey) => {
        this.splatManager!.removeSector(sectorKey);
      };

      // Wire fracture splats: when a voxel is erased, emit dynamic splats
      MeshManager.onVoxelErased = (
        _dimensionId: number,
        x: number,
        y: number,
        z: number,
        voxelId: number
      ) => {
        if (!this.splatManager) return;
        const tags = VoxelTagsRegister.VoxelTags[voxelId];
        if (!tags) return;

        const materialName =
          tags[VoxelTagIds.renderedMaterial] ||
          tags[VoxelTagIds.voxelMaterial] ||
          "";
        const mc = classifyTerrainMaterial(materialName);
        const shearStrength =
          (tags[VoxelTagIds.shearStrength] as number) || 100;
        // Derive a neutral color from the material family
        const color = familyDefaultColor(mc.family);
        this.splatManager.handleVoxelErased(
          x,
          y,
          z,
          mc.family,
          shearStrength,
          color
        );
      };
    }

    // Initialize LODSectorTracker when lodMorph is enabled
    if (EngineSettings.settings.terrain.lodMorph) {
      this.lodTracker = new LODSectorTracker();

      this.scene.registerBeforeRender(() => {
        const camera = this.scene.activeCamera;
        if (!camera || !this.lodTracker) return;
        const pos = camera.globalPosition;
        this.lodTracker.update(pos.x, pos.y, pos.z);
      });
    }
  }
}
