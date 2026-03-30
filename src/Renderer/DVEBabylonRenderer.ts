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
import { SpillFxRenderer } from "../Water/SpillFxRenderer.js";
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
  ShallowBoundaryFluxRegistry,
  tickShallowWater,
  getActiveShallowSections,
  getShallowSection,
  removeShallowSection,
  clearAllShallowWater,
  createEmptyShallowColumn,
  measureShallowWaterMass,
  placeShallowWaterSeed,
} from "@divinevoxel/vlox/Water/Shallow/index.js";
import {
  packShallowWaterSection,
  type ShallowWaterGPUData,
} from "@divinevoxel/vlox/Water/Shallow/ShallowWaterGPUDataPacker.js";
import type { ShallowHandoffResult } from "@divinevoxel/vlox/Water/Contracts/WaterSemanticContract.js";
import {
  addContinuousWaterSeed,
  clearAllContinuousWater,
  getActiveContinuousSections,
  getOrCreateContinuousSection,
  getContinuousSection,
  createEmptyContinuousColumn,
  measureContinuousWaterMass,
  removeContinuousSection,
  syncContinuousSectionFromGPUData,
  tickContinuousWater,
} from "@divinevoxel/vlox/Water/Continuous/index.js";
import {
  clearAllSpillWater,
  getActiveSpillEmitters,
  getPendingSpillEmitterCount,
  measureSpillWaterMass,
  removeSpillEmittersForSection,
  updateSpillWater,
} from "@divinevoxel/vlox/Water/Spill/index.js";
import { WaterChunkRegistry } from "@divinevoxel/vlox/Water/Runtime/WaterChunkRegistry.js";
import {
  drainWaterRuntimeInputEvents,
  getPendingWaterRuntimeInputEventCount,
} from "@divinevoxel/vlox/Water/Runtime/WaterInputQueue.js";
import { WaterOwnershipResolver } from "@divinevoxel/vlox/Water/Runtime/WaterOwnershipResolver.js";
import {
  WaterRuntimeOrchestrator,
  type WaterRuntimePhaseAccounting,
} from "@divinevoxel/vlox/Water/Runtime/WaterRuntimeOrchestrator.js";
import { WaterTransferResolver } from "@divinevoxel/vlox/Water/Runtime/WaterTransferResolver.js";
import {
  WaterLODManager,
  WaterPhysicalLOD,
  type WaterLODChunkSnapshot,
  type WaterLODTransitionSummary,
} from "@divinevoxel/vlox/Water/Runtime/WaterLODManager.js";
import {
  JsonWaterPersistenceCodec,
  WaterPersistence,
} from "@divinevoxel/vlox/Water/Runtime/WaterPersistence.js";
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

const WATER_RUNTIME_SECTION_SIZE = 16;

function getRuntimeSectionOrigin(world: number) {
  return Math.floor(world / WATER_RUNTIME_SECTION_SIZE) * WATER_RUNTIME_SECTION_SIZE;
}

function getRuntimeLocalCoord(world: number) {
  return ((world % WATER_RUNTIME_SECTION_SIZE) + WATER_RUNTIME_SECTION_SIZE) % WATER_RUNTIME_SECTION_SIZE;
}

function removeShallowMassAtColumn(worldX: number, worldZ: number, amount: number) {
  if (amount <= 0) return 0;

  const originX = getRuntimeSectionOrigin(worldX);
  const originZ = getRuntimeSectionOrigin(worldZ);
  const section = getShallowSection(originX, originZ);
  if (!section) return 0;

  const localX = getRuntimeLocalCoord(worldX);
  const localZ = getRuntimeLocalCoord(worldZ);
  const column = section.columns[localZ * section.sizeX + localX];
  if (!column?.active) return 0;

  const removed = Math.min(amount, column.thickness);
  const nextThickness = Math.max(0, column.thickness - removed);
  if (nextThickness <= 0.0001) {
    const bedY = column.bedY;
    Object.assign(column, createEmptyShallowColumn());
    column.bedY = bedY;
    column.surfaceY = bedY;
    return removed;
  }

  column.thickness = nextThickness;
  column.surfaceY = column.bedY + column.thickness;
  column.handoffPending = false;
  column.ownershipDomain = "shallow";
  column.authority = "player";
  return removed;
}

function removeContinuousMassAtColumn(worldX: number, worldZ: number, amount: number) {
  if (amount <= 0) return 0;

  const originX = getRuntimeSectionOrigin(worldX);
  const originZ = getRuntimeSectionOrigin(worldZ);
  const section = getContinuousSection(originX, originZ);
  if (!section) return 0;

  const localX = getRuntimeLocalCoord(worldX);
  const localZ = getRuntimeLocalCoord(worldZ);
  const column = section.columns[localZ * section.sizeX + localX];
  if (!column?.active) return 0;

  const removed = Math.min(amount, column.mass);
  const nextMass = Math.max(0, column.mass - removed);
  if (nextMass <= 0.0001) {
    const bedY = column.bedY;
    Object.assign(column, createEmptyContinuousColumn());
    column.bedY = bedY;
    column.surfaceY = bedY;
    return removed;
  }

  column.mass = nextMass;
  column.depth = nextMass;
  column.surfaceY = column.bedY + column.depth;
  column.pressure = column.depth;
  column.handoffPending = false;
  column.ownershipDomain = "continuous";
  column.authority = "player";
  return removed;
}

function addShallowSpillMassAtColumn(
  worldX: number,
  worldZ: number,
  surfaceY: number,
  amount: number,
  emitterId: number,
) {
  if (amount <= 0) return 0;

  const accepted = placeShallowWaterSeed(worldX, worldZ, surfaceY, amount, emitterId);
  if (accepted <= 0) return 0;

  const originX = getRuntimeSectionOrigin(worldX);
  const originZ = getRuntimeSectionOrigin(worldZ);
  const section = getShallowSection(originX, originZ);
  if (!section) return accepted;

  const localX = getRuntimeLocalCoord(worldX);
  const localZ = getRuntimeLocalCoord(worldZ);
  const column = section.columns[localZ * section.sizeX + localX];
  if (!column) return accepted;

  column.authority = "spill-handoff";
  column.ownershipDomain = "shallow";
  if (emitterId > 0) {
    column.emitterId = emitterId;
  }
  return accepted;
}

function addContinuousSpillMassAtColumn(
  worldX: number,
  worldZ: number,
  surfaceY: number,
  amount: number,
  _emitterId: number,
) {
  if (amount <= 0) return 0;

  const inserted = addContinuousWaterSeed(worldX, worldZ, surfaceY, amount, 1);
  if (!inserted) return 0;

  const originX = getRuntimeSectionOrigin(worldX);
  const originZ = getRuntimeSectionOrigin(worldZ);
  const section = getContinuousSection(originX, originZ);
  // The mass is already committed to the continuous runtime at this point.
  if (!section) return amount;

  const localX = getRuntimeLocalCoord(worldX);
  const localZ = getRuntimeLocalCoord(worldZ);
  const column = section.columns[localZ * section.sizeX + localX];
  if (!column) return amount;

  column.authority = "spill-handoff";
  column.ownershipDomain = "continuous";
  return amount;
}

function processWaterRuntimeInputEvents() {
  const events = drainWaterRuntimeInputEvents();
  let handled = 0;
  let unhandled = 0;
  let sourceDelta = 0;
  let sinkDelta = 0;

  for (const event of events) {
    switch (event.kind) {
      case "add-mass": {
        const massDelta = Math.max(0, event.massDelta ?? 0);
        if (massDelta <= 0) {
          unhandled += 1;
          break;
        }

        const addedMass = placeShallowWaterSeed(
          event.worldX,
          event.worldZ,
          event.worldY + massDelta,
          massDelta,
          0,
        );

        if (addedMass > 0) {
          const section = getShallowSection(
            getRuntimeSectionOrigin(event.worldX),
            getRuntimeSectionOrigin(event.worldZ),
          );
          if (section) {
            const localX = getRuntimeLocalCoord(event.worldX);
            const localZ = getRuntimeLocalCoord(event.worldZ);
            const column = section.columns[localZ * section.sizeX + localX];
            if (column) {
              column.authority = "player";
              column.ownershipDomain = "shallow";
            }
          }
        }

        sourceDelta += addedMass;
        handled += 1;
        break;
      }

      case "remove-mass": {
        const requested = Math.max(0, Math.abs(event.massDelta ?? 0));
        let remaining = requested;
        if (remaining <= 0) {
          unhandled += 1;
          break;
        }

        remaining -= removeShallowMassAtColumn(event.worldX, event.worldZ, remaining);
        if (remaining > 0) {
          remaining -= removeContinuousMassAtColumn(event.worldX, event.worldZ, remaining);
        }
        sinkDelta += requested - remaining;
        handled += 1;
        break;
      }

      default:
        unhandled += 1;
        break;
    }
  }

  (globalThis as any).__DVE_LAST_WATER_INPUT_EVENT_COUNT__ = events.length;
  (globalThis as any).__DVE_LAST_WATER_INPUT_HANDLED__ = handled;
  (globalThis as any).__DVE_LAST_WATER_INPUT_UNHANDLED__ = unhandled;
  (globalThis as any).__DVE_PENDING_WATER_INPUT_EVENTS__ = getPendingWaterRuntimeInputEventCount();

  const accounting: WaterRuntimePhaseAccounting = {
    sourceDelta,
    sinkDelta,
  };
  return accounting;
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

function isWaterRuntimeLODEnabled() {
  return (globalThis as any).__DVE_ENABLE_WATER_RUNTIME_LOD__ === true;
}

function getWaterRuntimeLOD0Radius() {
  const value = Number((globalThis as any).__DVE_WATER_RUNTIME_LOD0_RADIUS__);
  if (!Number.isFinite(value) || value <= WATER_RUNTIME_SECTION_SIZE) {
    return WATER_RUNTIME_SECTION_SIZE * 4;
  }
  return value;
}

type ShallowSectionRenderCache = {
  signature: number;
  gpuData: ShallowWaterGPUData;
};

function foldShallowSignature(signature: number, value: number) {
  return Math.imul(signature ^ (value >>> 0), 16777619) >>> 0;
}

function quantizeSigned(value: number, scale: number, limit: number) {
  const quantized = Math.round(value * scale);
  const clamped = Math.max(-limit, Math.min(limit, quantized));
  return clamped & 0xffff;
}

function quantizeUnsigned(value: number, scale: number, limit: number) {
  const quantized = Math.round(value * scale);
  return Math.max(0, Math.min(limit, quantized)) >>> 0;
}

function computeShallowSectionMaterialSignature(gpuData: ShallowWaterGPUData) {
  let signature = 2166136261 >>> 0;
  signature = foldShallowSignature(signature, gpuData.activeColumnCount);
  const columnCount = gpuData.sizeX * gpuData.sizeZ;
  for (let index = 0; index < columnCount; index++) {
    const base = index * gpuData.columnStride;
    const active = (gpuData.columnMetadata[index] ?? 0) & 0x1;
    signature = foldShallowSignature(signature, active);
    signature = foldShallowSignature(
      signature,
      quantizeUnsigned(gpuData.columnBuffer[base + 0] ?? 0, 1024, 0xffff),
    );
    signature = foldShallowSignature(
      signature,
      quantizeSigned(gpuData.columnBuffer[base + 3] ?? 0, 128, 0x7fff),
    );
    signature = foldShallowSignature(
      signature,
      quantizeSigned(gpuData.columnBuffer[base + 4] ?? 0, 128, 0x7fff),
    );
    signature = foldShallowSignature(
      signature,
      quantizeUnsigned(gpuData.columnBuffer[base + 9] ?? 0, 64, 0xffff),
    );
  }
  return signature;
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
  waterRuntime = new WaterRuntimeOrchestrator();
  waterChunkRegistry = new WaterChunkRegistry();
  shallowBoundaryRegistry = new ShallowBoundaryFluxRegistry();
  waterOwnershipResolver = new WaterOwnershipResolver();
  waterPersistence = new WaterPersistence();
  waterPersistenceCodec = new JsonWaterPersistenceCodec();
  waterLODManager = new WaterLODManager({
    sectionSize: WATER_RUNTIME_SECTION_SIZE,
    lod0Radius: WATER_RUNTIME_SECTION_SIZE * 4,
    lod1Radius: WATER_RUNTIME_SECTION_SIZE * 8,
    lod2Radius: WATER_RUNTIME_SECTION_SIZE * 16,
    allowPersistedDormancy: true,
    coarseFactors: {
      lod1: 2,
      lod2: 4,
    },
    maxSupportedLOD: WaterPhysicalLOD.LOD3_DORMANT,
  });
  waterTransferResolver: WaterTransferResolver | null = null;
  private _beforeRenderObservers: Observer<Scene>[] = [];
  private _disposed = false;
  private readonly _dormantWaterSnapshotFallbackCache = new Map<string, string>();
  private readonly _dormantWaterSnapshotKeys = new Set<string>();
  private readonly _shallowSectionFrameCache = new Map<string, ShallowSectionRenderCache>();
  private readonly spillFxRenderer = new SpillFxRenderer();

  get localFluidSystem(): DVEWaterLocalFluidSystem | null {
    return getSceneWaterHybridBridge(this.scene).localFluidSystem;
  }

  private getDormantWaterSnapshotKey(originX: number, originZ: number) {
    return `dve-water-dormant:${originX}_${originZ}`;
  }

  private getDormantWaterStorage() {
    try {
      return typeof sessionStorage === "undefined" ? null : sessionStorage;
    } catch {
      return null;
    }
  }

  private persistDormantWaterSnapshot(snapshot: WaterLODChunkSnapshot) {
    try {
      const persisted = this.waterPersistence.serializeLODChunkSnapshot(snapshot);
      const validation = this.waterPersistence.validatePersistedMass(persisted);
      if (!validation.valid) {
        return false;
      }

      const encoded = this.waterPersistenceCodec.encode(persisted);
      const key = this.getDormantWaterSnapshotKey(snapshot.originX, snapshot.originZ);
      const storage = this.getDormantWaterStorage();

      if (storage) {
        try {
          storage.setItem(key, encoded);
          this._dormantWaterSnapshotFallbackCache.delete(key);
        } catch {
          this._dormantWaterSnapshotFallbackCache.set(key, encoded);
        }
      } else {
        this._dormantWaterSnapshotFallbackCache.set(key, encoded);
      }

      this._dormantWaterSnapshotKeys.add(key);
      return true;
    } catch {
      return false;
    }
  }

  private readDormantWaterSnapshot(originX: number, originZ: number) {
    const key = this.getDormantWaterSnapshotKey(originX, originZ);
    const cached = this._dormantWaterSnapshotFallbackCache.get(key);
    if (cached) {
      return cached;
    }

    const storage = this.getDormantWaterStorage();
    if (!storage) {
      return null;
    }

    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }

  private deleteDormantWaterSnapshot(originX: number, originZ: number) {
    const key = this.getDormantWaterSnapshotKey(originX, originZ);
    this._dormantWaterSnapshotFallbackCache.delete(key);

    const storage = this.getDormantWaterStorage();
    if (storage) {
      try {
        storage.removeItem(key);
      } catch {
      }
    }

    this._dormantWaterSnapshotKeys.delete(key);
  }

  private restoreDormantWaterSnapshot(originX: number, originZ: number) {
    const encoded = this.readDormantWaterSnapshot(originX, originZ);
    if (!encoded) {
      return null;
    }

    try {
      const decoded = this.waterPersistenceCodec.decode(encoded);
      if (decoded.kind !== "lod_snapshot") {
        this.deleteDormantWaterSnapshot(originX, originZ);
        return null;
      }

      const validation = this.waterPersistence.validatePersistedMass(decoded);
      if (!validation.valid) {
        this.deleteDormantWaterSnapshot(originX, originZ);
        return null;
      }

      const restored = this.waterPersistence.hydrateLODChunkSnapshot(decoded);
      this.deleteDormantWaterSnapshot(originX, originZ);
      return restored;
    } catch {
      return null;
    }
  }

  private clearDormantWaterSnapshots() {
    const storage = this.getDormantWaterStorage();
    for (const key of this._dormantWaterSnapshotKeys) {
      if (storage) {
        try {
          storage.removeItem(key);
        } catch {
        }
      }
    }

    this._dormantWaterSnapshotFallbackCache.clear();
    this._dormantWaterSnapshotKeys.clear();
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
    this.shallowSectionRenderer = new DVEEditorShallowSectionRenderer(this.scene, {
      autoUpdate: false,
    });
    this.shallowWaterRenderer = new DVEShallowWaterRenderer(this.scene);
    this.continuumController = new DVEWaterContinuumController(
      waterHybridBridge,
      this.shallowWaterRenderer ?? null,
    );

    this.waterTransferResolver = new WaterTransferResolver({
      continuousToShallow: (worldX, worldZ, _bedY, surfaceY, depth) => {
        return placeShallowWaterSeed(worldX, worldZ, surfaceY, depth, 0);
      },
      shallowToContinuous: (worldX, worldZ, surfaceY, thickness, emitterId) => {
        const allowLogicalContinuousHandoff =
          (globalThis as any).__DVE_ENABLE_CONTINUOUS_RUNTIME_HANDOFF__ === true;
        if (!allowLogicalContinuousHandoff) {
          return "rejected";
        }

        const accepted = addContinuousWaterSeed(
          worldX,
          worldZ,
          surfaceY,
          thickness,
          Math.max(1, emitterId),
        );
        const result: ShallowHandoffResult = accepted ? "accepted" : "deferred";
        return result;
      },
    });

    const previousActiveShallowKeys = new Set<string>();
    const waterLODTransitionDeps = {
      getContinuousSection,
      getShallowSection,
      removeContinuousSection,
      removeShallowSection,
      getOrCreateContinuousSection: (originX: number, originZ: number) =>
        getOrCreateContinuousSection(
          originX,
          originZ,
          WATER_RUNTIME_SECTION_SIZE,
          WATER_RUNTIME_SECTION_SIZE,
        ),
      createEmptyContinuousColumn,
      sectionSize: WATER_RUNTIME_SECTION_SIZE,
      hasPendingContinuousBoundaryState: (originX: number, originZ: number) =>
        this.waterChunkRegistry.hasPendingBoundaryState(originX, originZ),
      hasPendingShallowBoundaryState: (originX: number, originZ: number) =>
        this.shallowBoundaryRegistry.hasPendingTransfers(originX, originZ),
      retireContinuousBoundaryState: (originX: number, originZ: number) =>
        this.waterChunkRegistry.retireSection(originX, originZ),
      retireShallowBoundaryState: (originX: number, originZ: number) =>
        this.shallowBoundaryRegistry.retireSection(originX, originZ),
      persistDormantSnapshot: (snapshot: WaterLODChunkSnapshot) =>
        this.persistDormantWaterSnapshot(snapshot),
      restoreDormantSnapshot: (originX: number, originZ: number) =>
        this.restoreDormantWaterSnapshot(originX, originZ),
    };

    this._beforeRenderObservers.push(this.scene.onBeforeRenderObservable.add(() => {
      waterHybridBridge.beginFrame();
      const camera = this.scene.activeCamera;
      let waterLODTransitionSummary: WaterLODTransitionSummary | null = null;
      if (camera) {
        const pos = camera.globalPosition;
        waterHybridBridge.centerClipOn(pos.x, pos.z);
        this.continuumController?.updateCamera(pos.x, pos.z);
        this.waterLODManager.updateOptions({
          lod0Radius: getWaterRuntimeLOD0Radius(),
        });
        if (isWaterRuntimeLODEnabled()) {
          this.waterLODManager.updateTargets(
            getActiveContinuousSections(),
            getActiveShallowSections(),
            {
              playerWorldX: pos.x,
              playerWorldZ: pos.z,
            },
          );
          waterLODTransitionSummary = this.waterLODManager.applyTransitions(
            waterLODTransitionDeps,
          );
        } else if (this.waterLODManager.getStats().managedMass > 0) {
          waterLODTransitionSummary = this.waterLODManager.restoreAllFine(
            waterLODTransitionDeps,
          );
        }
      }
      const dt = this.engine.getDeltaTime() / 1000;
      const activeShallowKeys = new Set<string>();
      let ownershipPreviewSummary: ReturnType<WaterOwnershipResolver["previewAll"]> | null = null;
      let ownershipResolutionSummary: ReturnType<WaterOwnershipResolver["resolveAll"]> | null = null;
      const runtimeTick = this.waterRuntime.tick(dt, {
        inputPhase: () => {
          return processWaterRuntimeInputEvents();
        },
        previewOwnership: (tick) => {
          ownershipPreviewSummary = this.waterOwnershipResolver.previewAll(
            getActiveShallowSections(),
            getActiveContinuousSections(),
            tick,
          );
        },
        tickContinuous: (tickDt) => {
          return tickContinuousWater(
            tickDt,
            this.waterChunkRegistry,
            undefined,
            ownershipPreviewSummary?.preview,
          ).accounting;
        },
        tickShallow: (tickDt) => {
          return tickShallowWater(
            tickDt,
            undefined,
            this.shallowBoundaryRegistry,
            ownershipPreviewSummary?.preview,
          ).accounting;
        },
        resolveOwnership: (tick) => {
          ownershipResolutionSummary = this.waterOwnershipResolver.resolveAll(
            getActiveShallowSections(),
            getActiveContinuousSections(),
            tick,
            ownershipPreviewSummary ?? undefined,
          );
        },
        performHandoff: () => {
          const transferSummary = this.waterTransferResolver?.resolve(this.shallowBoundaryRegistry);
          if (!transferSummary) {
            return {
              transferDelta: {
                shallowToContinuous: 0,
                continuousToShallow: 0,
              },
            } satisfies WaterRuntimePhaseAccounting;
          }

          (globalThis as any).__DVE_WATER_HANDOFF_COUNTS__ = {
            shallowAccepted: transferSummary.shallow.acceptedCount,
            shallowDeferred: transferSummary.shallow.deferredCount,
            shallowRejected: transferSummary.shallow.rejectedCount,
            continuousAccepted: transferSummary.continuous.acceptedCount,
            continuousRejected: transferSummary.continuous.rejectedCount,
          };

          return transferSummary.accounting;
        },
        updateSpill: (tickDt) => {
          const spillSummary = updateSpillWater(tickDt, {
            landToShallow: addShallowSpillMassAtColumn,
            landToContinuous: addContinuousSpillMassAtColumn,
          });

          (globalThis as any).__DVE_SPILL_RUNTIME_COUNTS__ = {
            activeEmitters: spillSummary.activeEmitterCount,
            pendingEmitters: spillSummary.pendingEmitterCount,
            activatedEmitters: spillSummary.activatedEmitterCount,
            completedEmitters: spillSummary.completedEmitterCount,
          };

          return spillSummary.accounting;
        },
        extractRenderData: () => {
          advanceEditorShallowSurfaceLayer(dt);
          const activeSections = getActiveShallowSections();
          activeShallowKeys.clear();
          waterHybridBridge.beginShallowInjectionFrame();
          for (const [key, grid] of activeSections) {
            const previousCache = this._shallowSectionFrameCache.get(key);
            const gpuData = packShallowWaterSection(grid, previousCache?.gpuData);
            const signature = computeShallowSectionMaterialSignature(gpuData);
            const shallowChanged = !previousCache || previousCache.signature !== signature;
            this._shallowSectionFrameCache.set(key, {
              signature,
              gpuData,
            });
            if (gpuData.activeColumnCount <= 0) {
              this._shallowSectionFrameCache.delete(key);
              removeEditorShallowSurfaceSection(gpuData.originX, gpuData.originZ);
              this.shallowSectionRenderer?.removeSection(key);
              this.shallowWaterRenderer?.removeSection(key);
              waterHybridBridge.clearInjectedShallowSection(gpuData.originX, gpuData.originZ);
              continue;
            }

            const retainedByBridge =
              !shallowChanged &&
              waterHybridBridge.retainInjectedShallowSection(
                gpuData.originX,
                gpuData.originZ,
              );
            if (!retainedByBridge) {
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

            activeShallowKeys.add(key);
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
          }
          for (const key of Array.from(previousActiveShallowKeys)) {
            if (activeShallowKeys.has(key)) continue;
            const [originX, originZ] = key.split("_").map((value) => Number(value));
            this._shallowSectionFrameCache.delete(key);
            removeEditorShallowSurfaceSection(originX, originZ);
            this.shallowSectionRenderer?.removeSection(key);
            this.shallowWaterRenderer?.removeSection(key);
            waterHybridBridge.clearInjectedShallowSection(originX, originZ);
          }
          previousActiveShallowKeys.clear();
          for (const key of activeShallowKeys) {
            previousActiveShallowKeys.add(key);
          }
          waterHybridBridge.finishShallowInjectionFrame();
        },
        measureMass: () => ({
          shallow:
            measureShallowWaterMass() + this.shallowBoundaryRegistry.measureBufferedMass(),
          continuous:
            measureContinuousWaterMass() +
            this.waterChunkRegistry.measureBufferedMass() +
            this.waterLODManager.measureManagedMass(),
          spill: measureSpillWaterMass(),
        }),
        massValidationEpsilon: 0.001,
        onMassValidationFailure: (result) => {
          (globalThis as any).__DVE_WATER_RUNTIME_EXPECTED_MASS_DELTA__ =
            result.expectedMassDelta ?? 0;
          (globalThis as any).__DVE_WATER_RUNTIME_MASS_ERROR__ =
            result.massConservationError ?? 0;
          (globalThis as any).__DVE_WATER_RUNTIME_MASS_VALID__ = false;
          (globalThis as any).__DVE_WATER_RUNTIME_MASS_FAILURE__ = {
            tick: result.tick,
            massBefore: result.massBefore ?? null,
            massAfter: result.massAfter ?? null,
            phaseMasses: result.phaseMasses ?? null,
            totalMassDelta: result.totalMassDelta ?? 0,
            expectedMassDelta: result.expectedMassDelta ?? 0,
            massConservationError: result.massConservationError ?? 0,
            sourceDelta: result.sourceDelta,
            sinkDelta: result.sinkDelta,
            transferDelta: result.transferDelta,
            lodSummary: waterLODTransitionSummary ?? null,
            handoffs: (globalThis as any).__DVE_WATER_HANDOFF_COUNTS__ ?? null,
          };
        },
      });

      this.shallowSectionRenderer?.update(dt);
      this.shallowWaterRenderer?.update(dt, activeShallowKeys);
      this.spillFxRenderer.sync(
        waterHybridBridge.localFluidSystem,
        getActiveSpillEmitters().values(),
      );
      waterHybridBridge.advance(dt);
      this.continuumController?.advance(dt);
      (globalThis as any).__DVE_WATER_HYBRID_BRIDGE_FRAME__ =
        waterHybridBridge.getFrameStats();
      (globalThis as any).__DVE_WATER_LOCAL_FLUID_SOLVER_ACTIVE__ =
        waterHybridBridge.localFluidSystem?.getSolver() ?? "off";

      // ── Sprint 12: Expose water capability flags for validation ──
      (globalThis as any).__DVE_SHALLOW_WATER_SECTIONS__ = activeShallowKeys?.size ?? 0;
      (globalThis as any).__DVE_GPU_FLUID_ACTIVE__ = !!(waterHybridBridge as any).gpuSim?.backend?.ready;
      (globalThis as any).__DVE_SSFR_ACTIVE__ = true;
      (globalThis as any).__DVE_GRID_DISSOLUTION_ACTIVE__ = true;
      (globalThis as any).__DVE_PUDDLE_HANDOFF_WIRED__ =
        (globalThis as any).__DVE_ENABLE_CONTINUOUS_RUNTIME_HANDOFF__ === true;
      (globalThis as any).__DVE_ACTIVE_WATER_LAYERS__ = _countActiveWaterLayers(activeShallowKeys);
      (globalThis as any).__DVE_CONTINUOUS_RUNTIME_SECTIONS__ = getActiveContinuousSections().size;
      (globalThis as any).__DVE_WATER_RUNTIME_LOD_ENABLED__ = isWaterRuntimeLODEnabled();
      (globalThis as any).__DVE_WATER_RUNTIME_LOD0_RADIUS__ = getWaterRuntimeLOD0Radius();
      (globalThis as any).__DVE_WATER_RUNTIME_LOD_RECORDS__ =
        this.waterLODManager.getStats().totalRecords;
      (globalThis as any).__DVE_WATER_RUNTIME_LOD_COARSE_RECORDS__ =
        this.waterLODManager.getStats().coarseRecords;
      (globalThis as any).__DVE_WATER_RUNTIME_LOD_MANAGED_MASS__ =
        this.waterLODManager.getStats().managedMass;
      (globalThis as any).__DVE_WATER_RUNTIME_LOD_LAST_SUMMARY__ = waterLODTransitionSummary;
      (globalThis as any).__DVE_WATER_SURFACE_MODE__ =
        EngineSettings.settings.water.largeWaterVisibleMode;
      (globalThis as any).__DVE_SPILL_RUNTIME_EMITTERS__ = getActiveSpillEmitters().size;
      (globalThis as any).__DVE_SPILL_RUNTIME_PENDING__ = getPendingSpillEmitterCount();
      (globalThis as any).__DVE_SPILL_RUNTIME_MASS__ = measureSpillWaterMass();
      (globalThis as any).__DVE_SPILL_FX_EMITTERS__ =
        this.spillFxRenderer.getStats().activeEmitterCount;
      (globalThis as any).__DVE_WATER_RUNTIME_MASS_DELTA__ = runtimeTick.totalMassDelta ?? 0;
      (globalThis as any).__DVE_WATER_RUNTIME_EXPECTED_MASS_DELTA__ =
        runtimeTick.expectedMassDelta ?? 0;
      (globalThis as any).__DVE_WATER_RUNTIME_MASS_ERROR__ =
        runtimeTick.massConservationError ?? 0;
      (globalThis as any).__DVE_WATER_RUNTIME_MASS_VALID__ =
        runtimeTick.massConservationValid ?? true;
      (globalThis as any).__DVE_WATER_RUNTIME_SOURCE_DELTA__ = runtimeTick.sourceDelta;
      (globalThis as any).__DVE_WATER_RUNTIME_SINK_DELTA__ = runtimeTick.sinkDelta;
      (globalThis as any).__DVE_WATER_RUNTIME_TRANSFER_DELTA__ = runtimeTick.transferDelta;
      (globalThis as any).__DVE_PENDING_WATER_INPUT_EVENTS__ = getPendingWaterRuntimeInputEventCount();
    }));

    const processShallowWaterUpdate = (sectorKey: string, waterUpdate: any) => {
      if (!waterUpdate) return;
      const existingContinuousSection = getContinuousSection(
        waterUpdate.originX,
        waterUpdate.originZ,
      );
      const lodChunkRecord = this.waterLODManager.getChunkRecord(
        waterUpdate.originX,
        waterUpdate.originZ,
      );
      const canBootstrapContinuousRuntime =
        !lodChunkRecord?.currentSnapshot &&
        !lodChunkRecord?.isPersistedDormant &&
        (lodChunkRecord?.isResidentFine ?? true) &&
        (!existingContinuousSection ||
          !existingContinuousSection.columns.some((column) => column.active));
      if (canBootstrapContinuousRuntime) {
        syncContinuousSectionFromGPUData(waterUpdate);
      }
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

    const getWaterSectionContext = (sectorKey: string) => {
      const [, x, , z] = sectorKey.split("_").map((value) => Number(value));
      return {
        originX: x,
        originZ: z,
        sectionKey: `${x}_${z}`,
      };
    };

    const clearWaterVisualSection = (originX: number, originZ: number) => {
      const sectionKey = `${originX}_${originZ}`;
      this._shallowSectionFrameCache.delete(sectionKey);
      waterHybridBridge.removeSection(originX, originZ);
      waterHybridBridge.clearInjectedShallowSection(originX, originZ);
      removeEditorShallowSurfaceSection(originX, originZ);
      this.shallowSectionRenderer?.removeSection(sectionKey);
      this.shallowWaterRenderer?.removeSection(sectionKey);
    };

    const clearWaterRuntimeSection = (
      originX: number,
      originZ: number,
      preservePersistedDormant = false,
    ) => {
      const record = this.waterLODManager.getChunkRecord(originX, originZ);
      if (
        preservePersistedDormant &&
        record?.activeLOD === WaterPhysicalLOD.LOD3_DORMANT &&
        !record.isPersistedDormant &&
        record.currentSnapshot
      ) {
        const dormantSnapshot = record.currentSnapshot;
        if (this.persistDormantWaterSnapshot(dormantSnapshot)) {
          record.currentSnapshot = null;
          record.isResidentFine = false;
          record.isPersistedDormant = true;
          record.lastMass = dormantSnapshot.totalMass;
        }
      }

      clearWaterVisualSection(originX, originZ);
      removeShallowSection(originX, originZ);
      removeContinuousSection(originX, originZ);
      removeSpillEmittersForSection(`${originX}_${originZ}`);
      this.waterChunkRegistry.removeSection(originX, originZ);
      this.shallowBoundaryRegistry.removeSection(originX, originZ);

      if (preservePersistedDormant && record?.isPersistedDormant) {
        return;
      }

      this.deleteDormantWaterSnapshot(originX, originZ);
      this.waterLODManager.removeChunk(originX, originZ);
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
        } else {
          const { originX, originZ } = getWaterSectionContext(sectorKey);
          // A missing waterUpdate only means the mesher did not emit water payload
          // for this section update. The water runtime remains authoritative and
          // must not be cleared outside the orchestrator tick, or mass disappears
          // with expectedMassDelta=0 during editor terrain edits.
          clearWaterVisualSection(originX, originZ);
        }
        this.splatManager!.processSectionMeshes(sectorKey, meshes);
      };

      MeshManager.onSectorRemoved = (sectorKey) => {
        this.splatManager!.removeSector(sectorKey);
        const { originX, originZ } = getWaterSectionContext(sectorKey);
        clearWaterRuntimeSection(originX, originZ, true);
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
        if (!waterUpdate) {
          const { originX, originZ } = getWaterSectionContext(_sectorKey);
          // Keep runtime water state authoritative across mesh updates that omit
          // water payload; only sector removal should destroy logical water state.
          clearWaterVisualSection(originX, originZ);
          return;
        }
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
        const { originX, originZ } = getWaterSectionContext(sectorKey);
        clearWaterRuntimeSection(originX, originZ, true);
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
    this.spillFxRenderer.clear(getSceneWaterHybridBridge(this.scene).localFluidSystem);
    this._shallowSectionFrameCache.clear();
    clearEditorShallowSurfaceRegistry();
    clearAllShallowWater();
    clearAllContinuousWater();
    clearAllSpillWater();
    this.clearDormantWaterSnapshots();
    this.waterLODManager.clear();
    this.waterTransferResolver = null;
    this.waterChunkRegistry.clear();
    this.shallowBoundaryRegistry.clear();
    getSceneWaterHybridBridge(this.scene).dispose();
    if (MeshManager.onSectionUpdated) MeshManager.onSectionUpdated = null;
    if (MeshManager.onSectorRemoved) MeshManager.onSectorRemoved = null;
    if (MeshManager.onVoxelErased) MeshManager.onVoxelErased = null;
    if (DVEBabylonRenderer.instance === this) {
      DVEBabylonRenderer.instance = null as any;
    }
  }
}
