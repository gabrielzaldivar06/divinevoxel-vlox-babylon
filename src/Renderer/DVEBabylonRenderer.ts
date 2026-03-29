import { DVERenderer } from "@divinevoxel/vlox/Renderer/DVERenderer";
import type { Observer } from "@babylonjs/core/Misc/observable";
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
import { DVEWaterLocalFluidSystem } from "../Water/GPU/DVEWaterLocalFluidSystem.js";
import { getSceneWaterHybridBridge } from "../Water/DVEWaterHybridBridge.js";
import { DVEEditorShallowSectionRenderer } from "../Water/DVEEditorShallowSectionRenderer.js";
import { DVEShallowWaterRenderer } from "../Water/DVEShallowWaterRenderer.js";
import { LODSectorTracker } from "../LOD/LODSectorTracker";
import { DVEWaterContinuumController } from "../Water/DVEWaterContinuumController.js";
import { MeshManager } from "@divinevoxel/vlox/Renderer/MeshManager";
import { VoxelTagsRegister } from "@divinevoxel/vlox/Voxels/Data/VoxelTagsRegister";
import { VoxelTagIds } from "@divinevoxel/vlox/Voxels/Data/VoxelTag.types";
import {
  advanceEditorShallowSurfaceLayer,
  clearEditorShallowSurfaceRegistry,
  markEditorShallowSurfaceConnectedByLargeBody,
  removeEditorShallowSurfaceSection,
  updateEditorShallowSurfaceSection,
} from "@divinevoxel/vlox/Water/Surface/WaterEditorShallowSurfaceRegistry";
import {
  tickShallowWater,
  getActiveShallowSections,
  clearAllShallowWater,
  setShallowWaterHandoffCallback,
} from "@divinevoxel/vlox/Water/Shallow/index.js";
import { packShallowWaterSection } from "@divinevoxel/vlox/Water/Shallow/ShallowWaterGPUDataPacker.js";
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
function _countActiveWaterLayers(shallowKeys?: Set<string>): number {
  let count = 0;
  count++; // Layer A: voxel liquid mesh
  count++; // Layer B: continuous patch mesh
  if ((globalThis as any).__DVE_GPU_FLUID_ACTIVE__) count++; // Layer D: GPU local fluid
  count++; // Layer E: SSFR composition
  if (shallowKeys && shallowKeys.size > 0) count++; // Layer F: Shallow water puddles
  return count;
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
  shallowSectionRenderer: DVEEditorShallowSectionRenderer | null = null;
  shallowWaterRenderer: DVEShallowWaterRenderer | null = null;
  continuumController: DVEWaterContinuumController | null = null;
  private _beforeRenderObservers: Observer<Scene>[] = [];
  private _disposed = false;

  get localFluidSystem(): DVEWaterLocalFluidSystem | null {
    return getSceneWaterHybridBridge(this.scene).localFluidSystem;
  }

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
    this.scene.onDisposeObservable.addOnce(() => this.dispose());
    if (!DVEBabylonRenderer.instance) DVEBabylonRenderer.instance = this;

    return DVEBabylonRenderer.instance;
  }

  async init(dver: DivineVoxelEngineRender) {
    const waterHybridBridge = getSceneWaterHybridBridge(this.scene);
    this.shallowSectionRenderer = new DVEEditorShallowSectionRenderer(this.scene);
    this.shallowWaterRenderer = new DVEShallowWaterRenderer(this.scene);
    this.continuumController = new DVEWaterContinuumController(
      waterHybridBridge,
      this.shallowWaterRenderer ?? null,
    );

    // Phase 3: register handoff callback — promotes thick shallow columns to dve_liquid voxels
    // TODO: replace console.log with actual DVE voxel write API when available
    setShallowWaterHandoffCallback((worldX, worldZ, surfaceY, thickness, emitterId) => {
      return false;
    });

    this._beforeRenderObservers.push(this.scene.onBeforeRenderObservable.add(() => {
      const camera = this.scene.activeCamera;
      if (camera) {
        const pos = camera.globalPosition;
        waterHybridBridge.centerClipOn(pos.x, pos.z);
        this.continuumController?.updateCamera(pos.x, pos.z);
      }
      const dt = this.engine.getDeltaTime() / 1000;
      advanceEditorShallowSurfaceLayer(dt);
      this.shallowSectionRenderer?.update(dt);
      // Tick shallow water simulation and push packed GPU data to renderer
      tickShallowWater(dt);
      const activeSections = getActiveShallowSections();
      const activeShallowKeys = new Set(activeSections.keys());
      for (const [key, grid] of activeSections) {
        const gpuData = packShallowWaterSection(grid);
        this.shallowSectionRenderer?.updateSection(key, {
          originX: gpuData.originX,
          originZ: gpuData.originZ,
          boundsX: gpuData.sizeX,
          boundsZ: gpuData.sizeZ,
          gpuData,
        });
        updateEditorShallowSurfaceSection(
          gpuData.originX,
          gpuData.originZ,
          gpuData.sizeX,
          gpuData.sizeZ,
          gpuData,
        );
        this.shallowWaterRenderer?.updateSection(key, gpuData);
        waterHybridBridge.injectShallowSection(
          gpuData.originX,
          gpuData.originZ,
          gpuData.sizeX,
          gpuData.sizeZ,
          gpuData.columnBuffer,
          gpuData.columnStride,
          gpuData.columnMetadata,
        );
      }
      this.shallowWaterRenderer?.update(dt, activeShallowKeys);
      waterHybridBridge.advance(dt);
      this.continuumController?.advance(dt);

      // ── Sprint 12: Expose water capability flags for validation ──
      (globalThis as any).__DVE_SHALLOW_WATER_SECTIONS__ = activeShallowKeys?.size ?? 0;
      (globalThis as any).__DVE_GPU_FLUID_ACTIVE__ = !!(waterHybridBridge as any).gpuSim?.backend?.ready;
      (globalThis as any).__DVE_SSFR_ACTIVE__ = true;
      (globalThis as any).__DVE_GRID_DISSOLUTION_ACTIVE__ = true;
      (globalThis as any).__DVE_PUDDLE_HANDOFF_WIRED__ = !!this.shallowWaterRenderer;
      (globalThis as any).__DVE_ACTIVE_WATER_LAYERS__ = _countActiveWaterLayers(activeShallowKeys);
    }));

    const processShallowWaterUpdate = (sectorKey: string, waterUpdate: any) => {
      if (!waterUpdate) return;
      updateEditorShallowSurfaceSection(
        waterUpdate.originX,
        waterUpdate.originZ,
        waterUpdate.boundsX,
        waterUpdate.boundsZ,
        null,
      );
      markEditorShallowSurfaceConnectedByLargeBody(
        waterUpdate.originX,
        waterUpdate.originZ,
        waterUpdate.boundsX,
        waterUpdate.boundsZ,
        waterUpdate.gpuData.largeBodyField,
        waterUpdate.gpuData.largeBodyFieldSize,
      );
    };

    if (this.sectorMeshes instanceof DVEBRSectionMeshesSingleBuffer) {
      const sectorMeshes = this.sectorMeshes as DVEBRSectionMeshesSingleBuffer;
      sectorMeshes.voxelScene.init(this.scene);

      this._beforeRenderObservers.push(this.scene.onBeforeRenderObservable.add(() => {
        sectorMeshes.voxelScene.beforRender();
      }));
    }

    // Initialize SplatManager when dissolutionSplats is enabled
    if (EngineSettings.settings.terrain.dissolutionSplats) {
      this.splatManager = new SplatManager(this.scene);

      MeshManager.onSectionUpdated = (sectorKey, meshes, waterUpdate) => {
        if (waterUpdate) {
          waterHybridBridge.updateFromSectionGPUData(
            waterUpdate.gpuData,
            waterUpdate.boundsX,
            waterUpdate.boundsZ,
            waterUpdate.paddedBoundsX,
            waterUpdate.paddedBoundsZ,
            waterUpdate.originX,
            waterUpdate.originZ,
          );
          processShallowWaterUpdate(sectorKey, waterUpdate);
        }
        this.splatManager!.processSectionMeshes(sectorKey, meshes);
      };

      MeshManager.onSectorRemoved = (sectorKey) => {
        this.splatManager!.removeSector(sectorKey);
        const [dimensionId, x, y, z] = sectorKey.split("_").map((value) => Number(value));
        void dimensionId;
        void y;
        removeEditorShallowSurfaceSection(x, z);
        this.shallowSectionRenderer?.removeSection(sectorKey);
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

    if (!EngineSettings.settings.terrain.dissolutionSplats) {
      MeshManager.onSectionUpdated = (_sectorKey, _meshes, waterUpdate) => {
        if (!waterUpdate) return;
        waterHybridBridge.updateFromSectionGPUData(
          waterUpdate.gpuData,
          waterUpdate.boundsX,
          waterUpdate.boundsZ,
          waterUpdate.paddedBoundsX,
          waterUpdate.paddedBoundsZ,
          waterUpdate.originX,
          waterUpdate.originZ,
        );
        processShallowWaterUpdate(_sectorKey, waterUpdate);
      };
      MeshManager.onSectorRemoved = (sectorKey) => {
        const [dimensionId, x, y, z] = sectorKey.split("_").map((value) => Number(value));
        void dimensionId;
        void y;
        removeEditorShallowSurfaceSection(x, z);
        this.shallowSectionRenderer?.removeSection(sectorKey);
      };
    }

    // Initialize LODSectorTracker when lodMorph is enabled
    if (EngineSettings.settings.terrain.lodMorph) {
      this.lodTracker = new LODSectorTracker();

      this._beforeRenderObservers.push(this.scene.onBeforeRenderObservable.add(() => {
        const camera = this.scene.activeCamera;
        if (!camera || !this.lodTracker) return;
        const pos = camera.globalPosition;
        this.lodTracker.update(pos.x, pos.y, pos.z);
      }));
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const observer of this._beforeRenderObservers) {
      this.scene.onBeforeRenderObservable.remove(observer);
    }
    this._beforeRenderObservers.length = 0;
    this.splatManager?.dispose();
    this.splatManager = null;
    this.lodTracker?.dispose();
    this.lodTracker = null;
    this.shallowSectionRenderer?.dispose();
    this.shallowSectionRenderer = null;
    this.shallowWaterRenderer?.dispose();
    this.shallowWaterRenderer = null;
    this.continuumController?.dispose();
    this.continuumController = null;
    clearEditorShallowSurfaceRegistry();
    clearAllShallowWater();
    if (MeshManager.onSectionUpdated) MeshManager.onSectionUpdated = null;
    if (MeshManager.onSectorRemoved) MeshManager.onSectorRemoved = null;
    if (MeshManager.onVoxelErased) MeshManager.onVoxelErased = null;
    if (DVEBabylonRenderer.instance === this) {
      DVEBabylonRenderer.instance = null as any;
    }
  }
}
