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
import { DVEShallowWaterCompositeController } from "../Water/DVEShallowWaterCompositeController.js";
import { DVEShallowWaterLocalFluidCoupler } from "../Water/DVEShallowWaterLocalFluidCoupler.js";
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
  buildShallowWaterVisualSnapshot,
  buildShallowWaterEdgeFieldSectionRenderData,
  getShallowWaterDebugStageProfile,
  measureShallowWaterMass,
  placeShallowWaterSeed,
  setShallowWaterFlowHints,
  type ShallowRenderSectionSnapshot,
  type ShallowWaterExternalFlowHint,
} from "@divinevoxel/vlox/Water/Shallow/index.js";
import {
  packShallowWaterSection,
  type ShallowWaterGPUData,
} from "@divinevoxel/vlox/Water/Shallow/ShallowWaterGPUDataPacker.js";
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
  getNeighborPressures,
} from "@divinevoxel/vlox/Water/Continuous/index.js";
import {
  clearAllSpillWater,
  getActiveSpillEmitters,
  getPendingSpillEmitterCount,
  measureSpillWaterMass,
  queueSpillTransfer,
  removeSpillEmittersForSection,
  updateSpillWater,
  type SpillEmitterRuntime,
} from "@divinevoxel/vlox/Water/Spill/index.js";
import { WaterChunkRegistry } from "@divinevoxel/vlox/Water/Runtime/WaterChunkRegistry.js";
import {
  drainWaterRuntimeInputEvents,
  enqueueWaterRuntimeInputEvent,
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
  IndexedDBWaterPersistenceBackend,
  type WaterWorldPersistenceBackend,
} from "@divinevoxel/vlox/Water/Runtime/WaterPersistence.js";
import {
  resolveEvents as resolveWaterEvents,
  getRecentEvents as getRecentWaterEvents,
  type WaterEventResolverDeps,
} from "@divinevoxel/vlox/Water/Runtime/WaterEventResolver.js";
import {
  tickGates as tickWaterGates,
  setGateOpenness,
  getGateCount as getWaterGateCount,
  type WaterGateTickDeps,
} from "@divinevoxel/vlox/Water/Runtime/WaterGateRegistry.js";
import {
  processTerrainCarve,
  processTerrainFill,
  type WaterTerrainEditDeps,
} from "@divinevoxel/vlox/Water/Runtime/WaterTerrainEditResolver.js";
import {
  classifyTerrainMaterial,
  TerrainMaterialFamily,
} from "../Matereials/PBR/MaterialFamilyProfiles";
import { WorldCursor } from "@divinevoxel/vlox/World/Cursor/WorldCursor.js";

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
const WATER_HANDOFF_GRACE_TICKS = 4;
const SHALLOW_TERRAIN_SCAN_UP = 4;
const SHALLOW_TERRAIN_SCAN_DOWN = 128;
const SHALLOW_TERRAIN_SCAN_DOWN_FAR = 512;
const SHALLOW_TERRAIN_COARSE_STEP = 4;
const SHALLOW_DIRECT_PLACEMENT_MAX_FALL = 1.25;

type ShallowTerrainSupportSample = {
  bedY: number;
  foundSupport: boolean;
};

let resolveQueuedShallowTerrainSupport:
  | ((worldX: number, worldZ: number, guessY: number) => ShallowTerrainSupportSample)
  | null = null;

function getActiveShallowDebugProfile() {
  return getShallowWaterDebugStageProfile(
    (globalThis as any).__DVE_SHALLOW_DEBUG_STAGE__,
    "full",
  );
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function isTerrainSupportVoxel(voxel: ReturnType<WorldCursor["getVoxel"]>) {
  if (!voxel || voxel.isAir()) return false;
  const substance = voxel.getSubstanceData?.();
  if (substance?.dve_is_liquid) return false;
  return voxel.checkCollisions() || voxel.isOpaque();
}

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
  emitter?: SpillEmitterRuntime,
) {
  if (amount <= 0) return 0;

  const applyImpactToColumn = (
    targetX: number,
    targetZ: number,
    cellMass: number,
    bedYGuess: number,
    impulseX: number,
    impulseZ: number,
  ) => {
    if (cellMass <= 0.0001) return 0;

    const sampledSupport = resolveQueuedShallowTerrainSupport?.(
      targetX,
      targetZ,
      bedYGuess,
    );
    // Use sampled bedY when terrain is confirmed; fall back to the caller's
    // bedYGuess (e.g. impactBedY) so mass is never silently discarded for
    // cells where the terrain scan just failed to resolve (e.g. narrow scan
    // window, borderline altitude).  Void cells off the platform will have
    // no section and placeShallowWaterSeed will return 0 anyway.
    const bedY = (sampledSupport?.foundSupport) ? sampledSupport.bedY : bedYGuess;

    const accepted = placeShallowWaterSeed(
      targetX,
      targetZ,
      bedY + cellMass,
      cellMass,
      emitterId,
      undefined,
      {
        authority: "spill-handoff",
        ownershipConfidence: 1,
        ownershipTicks: WATER_HANDOFF_GRACE_TICKS,
        handoffGraceTicks: WATER_HANDOFF_GRACE_TICKS,
        bedY,
      },
    );
    if (accepted <= 0) return 0;

    const originX = getRuntimeSectionOrigin(targetX);
    const originZ = getRuntimeSectionOrigin(targetZ);
    const section = getShallowSection(originX, originZ);
    if (!section) return accepted;

    const localX = getRuntimeLocalCoord(targetX);
    const localZ = getRuntimeLocalCoord(targetZ);
    const column = section.columns[localZ * section.sizeX + localX];
    if (!column) return accepted;

    column.authority = "spill-handoff";
    column.ownershipDomain = "shallow";
    if (emitterId > 0) {
      column.emitterId = emitterId;
    }
    column.spreadVX += impulseX;
    column.spreadVZ += impulseZ;
    column.settled = 0;
    column.adhesion = Math.min(column.adhesion, 0.08);
    return accepted;
  };

  if (emitter?.fxProfile === "waterball" && emitter.fallHeight > 0.1) {
    const impactRadius = Math.min(
      2.75,
      0.95 + Math.max(0, emitter.fallHeight) * 0.11 + Math.cbrt(Math.max(0.01, amount)) * 0.45,
    );
    const impactSpeed = Math.min(
      1.8,
      0.35 + Math.max(0, emitter.fallHeight) * 0.12 + Math.sqrt(Math.max(0.01, amount)) * 0.18,
    );
    const impactBedY = surfaceY - amount;
    const radiusCeil = Math.max(1, Math.ceil(impactRadius));
    const weightedTargets: Array<{
      x: number;
      z: number;
      weight: number;
      dirX: number;
      dirZ: number;
      bedY: number;
    }> = [];
    let totalWeight = 0;

    for (let dz = -radiusCeil; dz <= radiusCeil; dz++) {
      for (let dx = -radiusCeil; dx <= radiusCeil; dx++) {
        const distance = Math.hypot(dx, dz);
        if (distance > impactRadius) continue;
        const radial = Math.max(0, 1 - distance / Math.max(0.0001, impactRadius));
        const weight = dx === 0 && dz === 0 ? 1.35 : radial * radial;
        if (weight <= 0.0001) continue;
        const sampledSupport = resolveQueuedShallowTerrainSupport?.(
          worldX + dx,
          worldZ + dz,
          impactBedY,
        );
        if (!sampledSupport?.foundSupport) continue;
        const invDistance = distance > 0.0001 ? 1 / distance : 0;
        weightedTargets.push({
          x: worldX + dx,
          z: worldZ + dz,
          weight,
          dirX: dx * invDistance,
          dirZ: dz * invDistance,
          bedY: sampledSupport.bedY,
        });
        totalWeight += weight;
      }
    }

    let acceptedMass = 0;
    for (const target of weightedTargets) {
      const weight01 = target.weight / Math.max(0.0001, totalWeight);
      const cellMass = amount * weight01;
      const impulseScale = impactSpeed * Math.max(0.18, 1 - weight01);
      acceptedMass += applyImpactToColumn(
        target.x,
        target.z,
        cellMass,
        target.bedY,
        target.dirX * impulseScale,
        target.dirZ * impulseScale,
      );
    }
    return acceptedMass;
  }

  return applyImpactToColumn(worldX, worldZ, amount, surfaceY - amount, 0, 0);
}

function addContinuousSpillMassAtColumn(
  worldX: number,
  worldZ: number,
  surfaceY: number,
  amount: number,
  _emitterId: number,
  _emitter?: SpillEmitterRuntime,
) {
  if (amount <= 0) return 0;

  const inserted = addContinuousWaterSeed(worldX, worldZ, surfaceY, amount, 1, {
    authority: "spill-handoff",
    ownershipConfidence: 1,
    ownershipTicks: WATER_HANDOFF_GRACE_TICKS,
    handoffGraceTicks: WATER_HANDOFF_GRACE_TICKS,
  });
  if (inserted <= 0) return 0;

  const originX = getRuntimeSectionOrigin(worldX);
  const originZ = getRuntimeSectionOrigin(worldZ);
  const section = getContinuousSection(originX, originZ);
  // The mass is already committed to the continuous runtime at this point.
  if (!section) return inserted;

  const localX = getRuntimeLocalCoord(worldX);
  const localZ = getRuntimeLocalCoord(worldZ);
  const column = section.columns[localZ * section.sizeX + localX];
  if (!column) return inserted;

  column.authority = "spill-handoff";
  column.ownershipDomain = "continuous";
  return inserted;
}

function processWaterRuntimeInputEvents() {
  const events = drainWaterRuntimeInputEvents();
  let handled = 0;
  let unhandled = 0;
  let sourceDelta = 0;
  let sinkDelta = 0;

  const terrainEditDeps: WaterTerrainEditDeps = {
    getContinuousSection: (ox, oz) => getContinuousSection(ox, oz),
    getShallowSection: (ox, oz) => getShallowSection(ox, oz),
    getRuntimeSectionOrigin,
    getRuntimeLocalCoord,
  };

  for (const event of events) {
    switch (event.kind) {
      case "add-mass": {
        const massDelta = Math.max(0, event.massDelta ?? 0);
        if (massDelta <= 0) {
          unhandled += 1;
          break;
        }

        const terrainSupport = resolveQueuedShallowTerrainSupport?.(
          event.worldX,
          event.worldZ,
          event.worldY,
        );
        if (!terrainSupport?.foundSupport) {
          (globalThis as any).__DVE_SHALLOW_LAST_PLACEMENT_REJECT__ = {
            worldX: event.worldX,
            worldY: event.worldY,
            worldZ: event.worldZ,
            reason: "no-terrain-support",
            source: "queued-add-mass",
          };
          unhandled += 1;
          break;
        }

        const bedY = terrainSupport.bedY;
        const fallDistance = Math.max(0, event.worldY - bedY);
        if (fallDistance > SHALLOW_DIRECT_PLACEMENT_MAX_FALL) {
          queueSpillTransfer({
            sourceDomain: "shallow",
            targetDomain: "shallow",
            worldX: event.worldX,
            worldY: event.worldY,
            worldZ: event.worldZ,
            landingSurfaceY: bedY + massDelta,
            mass: massDelta,
            fallHeight: Math.max(0, event.worldY - (bedY + massDelta)),
            fxProfile: "waterball",
          });
          sourceDelta += massDelta;
          handled += 1;
          break;
        }

        // Shallow first: editor water belongs to the shallow runtime domain.
        // That domain now owns its own terrain-conforming visual stack
        // (film + edge splats) instead of painting dve_liquid directly.
        // Continuous seeds only create runtime state without writing voxel
        // data, so the terrain mesher never produces visible geometry for them.
        // Fall back to continuous only when shallow rejects the seed.
        let addedMass = 0;
        addedMass = placeShallowWaterSeed(
          event.worldX,
          event.worldZ,
          bedY + massDelta,
          massDelta,
          0,
          undefined,
          {
            bedY,
            authority: "player",
          },
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
        } else {
          const inserted = addContinuousWaterSeed(
            event.worldX,
            event.worldZ,
            event.worldY,
            massDelta,
            1,
            {
              authority: "continuous-handoff",
              ownershipConfidence: 1,
              ownershipTicks: WATER_HANDOFF_GRACE_TICKS,
              handoffGraceTicks: WATER_HANDOFF_GRACE_TICKS,
            },
          );
          if (inserted > 0) {
            addedMass = inserted;
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

      case "gate-control": {
        if (event.gateId && event.gateOpenness !== undefined) {
          setGateOpenness(event.gateId, event.gateOpenness);
          handled += 1;
        } else {
          unhandled += 1;
        }
        break;
      }

      case "pressure-impulse": {
        const impulse = event.pressureDelta ?? 0;
        if (impulse <= 0) {
          unhandled += 1;
          break;
        }
        const originX = getRuntimeSectionOrigin(event.worldX);
        const originZ = getRuntimeSectionOrigin(event.worldZ);
        const section = getContinuousSection(originX, originZ);
        if (section) {
          const localX = getRuntimeLocalCoord(event.worldX);
          const localZ = getRuntimeLocalCoord(event.worldZ);
          const column = section.columns[localZ * section.sizeX + localX];
          if (column?.active) {
            column.pressure += impulse;
            column.turbulence = Math.min(1, column.turbulence + impulse * 0.1);
            handled += 1;
          } else {
            unhandled += 1;
          }
        } else {
          unhandled += 1;
        }
        break;
      }

      case "terrain-carve": {
        const carveResult = processTerrainCarve(
          event.worldX,
          event.worldY,
          event.worldZ,
          terrainEditDeps,
        );
        sinkDelta += carveResult.sinkDelta ?? 0;
        handled += 1;
        break;
      }

      case "terrain-fill": {
        const fillResult = processTerrainFill(
          event.worldX,
          event.worldY,
          event.worldZ,
          terrainEditDeps,
        );
        sinkDelta += fillResult.sinkDelta ?? 0;
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
  snapshot: ShallowRenderSectionSnapshot;
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
  shallowCompositeController: DVEShallowWaterCompositeController | null = null;
  shallowLocalFluidCoupler: DVEShallowWaterLocalFluidCoupler | null = null;
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
  private readonly _shallowTerrainCursor = new WorldCursor();
  private _beforeRenderObservers: Observer<Scene>[] = [];
  private _disposed = false;
  private readonly _dormantWaterSnapshotFallbackCache = new Map<string, string>();
  private readonly _dormantWaterSnapshotKeys = new Set<string>();
  private readonly _durablePersistenceBackend: WaterWorldPersistenceBackend =
    new IndexedDBWaterPersistenceBackend();
  private readonly _shallowSectionFrameCache = new Map<string, ShallowSectionRenderCache>();
  private readonly spillFxRenderer: SpillFxRenderer;

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

      // Store in synchronous fallback cache immediately for same-session reads.
      this._dormantWaterSnapshotFallbackCache.set(key, encoded);
      this._dormantWaterSnapshotKeys.add(key);

      // Fire-and-forget durable write via IndexedDB.
      this._durablePersistenceBackend
        .store(snapshot.originX, snapshot.originZ, encoded)
        .catch((err) => {
          console.warn("[DVE] Failed to persist dormant water snapshot to IndexedDB:", err);
        });

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

    // Synchronous fallback — sessionStorage may still hold legacy data.
    const storage = this.getDormantWaterStorage();
    if (storage) {
      try {
        const legacy = storage.getItem(key);
        if (legacy) return legacy;
      } catch {
        // ignore
      }
    }

    return null;
  }

  /**
   * Pre-load a specific dormant snapshot from IndexedDB into the synchronous
   * in-memory cache. Call during sector loading to warm the cache before the
   * LOD manager's synchronous restore callback fires.
   */
  async warmDormantSnapshotFromDurable(originX: number, originZ: number): Promise<void> {
    const key = this.getDormantWaterSnapshotKey(originX, originZ);
    if (this._dormantWaterSnapshotFallbackCache.has(key)) return;
    const encoded = await this._durablePersistenceBackend.load(originX, originZ);
    if (encoded) {
      this._dormantWaterSnapshotFallbackCache.set(key, encoded);
      this._dormantWaterSnapshotKeys.add(key);
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

    // Fire-and-forget durable removal.
    this._durablePersistenceBackend.remove(originX, originZ).catch((err) => {
      console.warn("[DVE] Failed to remove dormant water snapshot from IndexedDB:", err);
    });

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

  /**
   * Clears every water-domain cache needed by the shallow isolation lab.
   * This is narrower than dispose(): the renderer stays alive, but the runtime
   * and the renderer-owned shallow visual state both return to a blank slate.
   */
  resetWaterDebugState() {
    const waterHybridBridge = getSceneWaterHybridBridge(this.scene);

    for (const section of getActiveContinuousSections().values()) {
      waterHybridBridge.removeSection(section.originX, section.originZ);
    }
    for (const key of Array.from(this._shallowSectionFrameCache.keys())) {
      const [originX, originZ] = key.split("_").map((value) => Number(value));
      removeEditorShallowSurfaceSection(originX, originZ);
      this.shallowCompositeController?.removeSection(key);
      this.shallowLocalFluidCoupler?.removeSection(key);
      waterHybridBridge.clearInjectedShallowSection(originX, originZ);
    }

    this._shallowSectionFrameCache.clear();
    this.shallowCompositeController?.setLocalFluidContributions(null);
    this.spillFxRenderer.clear(waterHybridBridge.localFluidSystem);
    clearEditorShallowSurfaceRegistry();
    clearAllShallowWater();
    clearAllContinuousWater();
    clearAllSpillWater();
    this.clearDormantWaterSnapshots();
    this.waterLODManager.clear();
    this.waterChunkRegistry.clear();
    this.shallowBoundaryRegistry.clear();
    (globalThis as any).__DVE_WATER_HANDOFF_COUNTS__ = null;
  }

  constructor(data: DVEBabylonRendererInitData) {
    super();
    this.engine = data.scene.getEngine() as any;
    this.scene = data.scene;
    this.spillFxRenderer = new SpillFxRenderer(this.scene);
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
    resolveQueuedShallowTerrainSupport = (worldX, worldZ, guessY) =>
      this.resolveShallowTerrainSupport(worldX, worldZ, guessY);
    this.scene.onDisposeObservable.addOnce(() => this.dispose());
    if (!DVEBabylonRenderer.instance) DVEBabylonRenderer.instance = this;

    return DVEBabylonRenderer.instance;
  }

  async init(dver: DivineVoxelEngineRender) {
    const waterHybridBridge = getSceneWaterHybridBridge(this.scene);
    this.shallowCompositeController = new DVEShallowWaterCompositeController(this.scene, {
      autoUpdate: false,
    });
    this.shallowLocalFluidCoupler = new DVEShallowWaterLocalFluidCoupler(
      () => getSceneWaterHybridBridge(this.scene).localFluidSystem,
    );
    this.continuumController = new DVEWaterContinuumController(
      waterHybridBridge,
      null,
    );

    this.waterTransferResolver = new WaterTransferResolver({
      continuousToShallow: (worldX, worldZ, bedY, surfaceY, depth) => {
        const acceptedMass = placeShallowWaterSeed(
          worldX,
          worldZ,
          surfaceY,
          depth,
          0,
          undefined,
          {
            bedY,
            authority: "continuous-handoff",
            ownershipConfidence: 1,
            ownershipTicks: WATER_HANDOFF_GRACE_TICKS,
            handoffGraceTicks: WATER_HANDOFF_GRACE_TICKS,
          },
        );
        if (acceptedMass > 0.0001) {
          this.shallowCompositeController?.beginContinuousToShallowTransition(
            worldX,
            worldZ,
            bedY,
            surfaceY,
            acceptedMass,
            0,
          );
          if (acceptedMass >= depth - 0.0001) {
            const section = getShallowSection(
              getRuntimeSectionOrigin(worldX),
              getRuntimeSectionOrigin(worldZ),
            );
            if (section) {
              const localX = getRuntimeLocalCoord(worldX);
              const localZ = getRuntimeLocalCoord(worldZ);
              const column = section.columns[localZ * section.sizeX + localX];
              if (column?.active) {
                column.handoffGraceTicks = Math.max(
                  column.handoffGraceTicks,
                  WATER_HANDOFF_GRACE_TICKS,
                );
                column.authority = "continuous-handoff";
                column.ownershipDomain = "shallow";
              }
            }
          }
        }
        return acceptedMass;
      },
      shallowToContinuous: (worldX, worldZ, bedY, surfaceY, thickness, emitterId) => {
        const runtimeHandoffFlag = (globalThis as any)
          .__DVE_ENABLE_CONTINUOUS_RUNTIME_HANDOFF__;
        const allowLogicalContinuousHandoff = runtimeHandoffFlag !== false;
        if (!allowLogicalContinuousHandoff) {
          return {
            acceptedMass: 0,
            disposition: "rejected",
          };
        }

        if (!this.hasContinuousHandoffSupport(worldX, worldZ, bedY, surfaceY)) {
          return {
            acceptedMass: 0,
            disposition: "rejected",
          };
        }

        const handoffTarget = this.resolveContinuousHandoffTarget(
          worldX,
          worldZ,
          bedY,
          surfaceY,
        );
        if (!handoffTarget) {
          return {
            acceptedMass: 0,
            disposition: "rejected",
          };
        }

        const accepted = addContinuousWaterSeed(
          handoffTarget.worldX,
          handoffTarget.worldZ,
          Math.max(surfaceY, handoffTarget.surfaceY),
          thickness,
          Math.max(1, emitterId),
          {
            bedY: handoffTarget.bedY,
            authority: "continuous-handoff",
            ownershipConfidence: 1,
            ownershipTicks: WATER_HANDOFF_GRACE_TICKS,
            handoffGraceTicks: WATER_HANDOFF_GRACE_TICKS,
          },
        );
        if (accepted > 0.0001) {
          const section = getContinuousSection(
            getRuntimeSectionOrigin(handoffTarget.worldX),
            getRuntimeSectionOrigin(handoffTarget.worldZ),
          );
          let continuousDepth = 0;
          if (section) {
            const localX = getRuntimeLocalCoord(handoffTarget.worldX);
            const localZ = getRuntimeLocalCoord(handoffTarget.worldZ);
            const column = section.columns[localZ * section.sizeX + localX];
            if (column?.active) {
              continuousDepth = column.depth;
              column.handoffGraceTicks = Math.max(
                column.handoffGraceTicks,
                WATER_HANDOFF_GRACE_TICKS,
              );
              column.authority = "continuous-handoff";
              column.ownershipDomain = "continuous";
            }
          }
          if (continuousDepth > 0 && continuousDepth < Math.max(0.18, accepted * 1.28)) {
            this.shallowCompositeController?.beginShallowToContinuousTransition(
              worldX,
              worldZ,
              bedY,
              surfaceY,
              accepted,
              emitterId,
            );
          }
        }
        return {
          acceptedMass: accepted,
          disposition: accepted > 0.0001 ? "accepted" : "deferred",
        };
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
          const shallowDebugProfile = getActiveShallowDebugProfile();
          this.syncShallowTerrainSupport();
          return tickShallowWater(
            tickDt,
            shallowDebugProfile.runtimeConfig,
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
        finalizeOwnership: () => {
          this.waterOwnershipResolver.finalizeAll(
            getActiveShallowSections(),
            getActiveContinuousSections(),
          );
        },
        resolveEvents: (tickDt, tick) => {
          const SECTION_SIZE = WATER_RUNTIME_SECTION_SIZE;

          const eventDeps: WaterEventResolverDeps = {
            getContinuousSections: () => getActiveContinuousSections(),
            getNeighborPressures: (section, x, z) =>
              getNeighborPressures(section, x, z),
            removeContinuousMass: (originX, originZ, columnIndex, mass) => {
              const section = getContinuousSection(originX, originZ);
              if (!section) return 0;
              const col = section.columns[columnIndex];
              if (!col?.active) return 0;
              const removed = Math.min(mass, col.mass);
              col.mass -= removed;
              col.depth = col.mass;
              col.surfaceY = col.bedY + col.depth;
              col.pressure = col.depth;
              return removed;
            },
            queueSpillTransfer: (worldX, worldZ, surfaceY, mass, fallHeight) => {
              queueSpillTransfer({
                sourceDomain: "continuous",
                targetDomain: "continuous",
                worldX,
                worldY: surfaceY + fallHeight,
                worldZ,
                landingSurfaceY: surfaceY,
                mass,
                fallHeight,
              });
            },
            sectionSize: SECTION_SIZE,
          };

          const eventAccounting = resolveWaterEvents(tick, eventDeps);

          const gateDeps: WaterGateTickDeps = {
            getUpstreamPressure: (worldX, worldZ) => {
              const section = getContinuousSection(
                getRuntimeSectionOrigin(worldX),
                getRuntimeSectionOrigin(worldZ),
              );
              if (!section) return 0;
              const lx = getRuntimeLocalCoord(worldX);
              const lz = getRuntimeLocalCoord(worldZ);
              const col = section.columns[lz * section.sizeX + lx];
              return col?.active ? col.pressure : 0;
            },
            getUpstreamSurfaceY: (worldX, worldZ) => {
              const section = getContinuousSection(
                getRuntimeSectionOrigin(worldX),
                getRuntimeSectionOrigin(worldZ),
              );
              if (!section) return 0;
              const lx = getRuntimeLocalCoord(worldX);
              const lz = getRuntimeLocalCoord(worldZ);
              const col = section.columns[lz * section.sizeX + lx];
              return col?.active ? col.surfaceY : col?.bedY ?? 0;
            },
            getDownstreamSurfaceY: (worldX, worldZ) => {
              const section = getContinuousSection(
                getRuntimeSectionOrigin(worldX),
                getRuntimeSectionOrigin(worldZ),
              );
              if (!section) return 0;
              const lx = getRuntimeLocalCoord(worldX);
              const lz = getRuntimeLocalCoord(worldZ);
              const col = section.columns[lz * section.sizeX + lx];
              return col?.active ? col.surfaceY : col?.bedY ?? 0;
            },
            removeContinuousMass: (worldX, worldZ, mass) => {
              return removeContinuousMassAtColumn(worldX, worldZ, mass);
            },
            queueSpillTransfer: (worldX, worldZ, landingSurfaceY, mass, fallHeight) => {
              queueSpillTransfer({
                sourceDomain: "continuous",
                targetDomain: "continuous",
                worldX,
                worldY: landingSurfaceY + fallHeight,
                worldZ,
                landingSurfaceY,
                mass,
                fallHeight,
              });
            },
          };

          const gateAccounting = tickWaterGates(tickDt, gateDeps);

          const merged: WaterRuntimePhaseAccounting = {
            sourceDelta: (eventAccounting.sourceDelta ?? 0) + (gateAccounting.sourceDelta ?? 0),
            sinkDelta: (eventAccounting.sinkDelta ?? 0) + (gateAccounting.sinkDelta ?? 0),
            transferDelta: {
              continuousToSpill:
                (eventAccounting.transferDelta?.continuousToSpill ?? 0) +
                (gateAccounting.transferDelta?.continuousToSpill ?? 0),
            },
          };

          // Sprint 8 Phase C/D telemetry
          (globalThis as any).__DVE_WATER_EVENT_SINK_DELTA__ =
            (eventAccounting.sinkDelta ?? 0) + (gateAccounting.sinkDelta ?? 0);
          (globalThis as any).__DVE_WATER_EVENT_SPILL_DELTA__ =
            (eventAccounting.transferDelta?.continuousToSpill ?? 0) +
            (gateAccounting.transferDelta?.continuousToSpill ?? 0);
          (globalThis as any).__DVE_WATER_RECENT_EVENT_COUNT__ =
            getRecentWaterEvents().length;
          (globalThis as any).__DVE_WATER_GATE_COUNT__ = getWaterGateCount();

          return merged;
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
          const shallowDebugProfile = getActiveShallowDebugProfile();
          advanceEditorShallowSurfaceLayer(dt);
          const activeSections = getActiveShallowSections();
          activeShallowKeys.clear();
          waterHybridBridge.beginShallowInjectionFrame();
          for (const [key, grid] of activeSections) {
            const previousCache = this._shallowSectionFrameCache.get(key);
            const gpuData = packShallowWaterSection(grid, previousCache?.gpuData);
            const shallowGhosts =
              this.shallowBoundaryRegistry.getGhostColumns(grid.originX, grid.originZ) ?? null;
            const snapshot = buildShallowWaterVisualSnapshot(
              grid,
              previousCache?.snapshot,
              shallowGhosts,
            );
            this.applyContinuousIntegrationMask(snapshot.film);
            if (shallowDebugProfile.visuals.enableEdgeSplats) {
              snapshot.edgeField = buildShallowWaterEdgeFieldSectionRenderData(
                snapshot.film,
                snapshot.edgeField,
                shallowGhosts,
              );
            } else {
              snapshot.edgeField.splats.length = 0;
              snapshot.edgeField.activeSplatCount = 0;
            }
            const signature = computeShallowSectionMaterialSignature(gpuData);
            const shallowChanged = !previousCache || previousCache.signature !== signature;
            this._shallowSectionFrameCache.set(key, {
              signature,
              gpuData,
              snapshot,
            });
            if (gpuData.activeColumnCount <= 0) {
              this._shallowSectionFrameCache.delete(key);
              removeEditorShallowSurfaceSection(gpuData.originX, gpuData.originZ);
              this.shallowCompositeController?.removeSection(key);
              this.shallowLocalFluidCoupler?.removeSection(key);
              waterHybridBridge.clearInjectedShallowSection(gpuData.originX, gpuData.originZ);
              continue;
            }

            if (shallowDebugProfile.visuals.enableHybridInjection) {
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
            } else {
              waterHybridBridge.clearInjectedShallowSection(gpuData.originX, gpuData.originZ);
            }

            activeShallowKeys.add(key);
            this.shallowCompositeController?.updateSection(key, snapshot);
            if (shallowDebugProfile.visuals.enableLocalFluid) {
              this.shallowLocalFluidCoupler?.syncSection(key, gpuData);
            } else {
              this.shallowLocalFluidCoupler?.removeSection(key);
            }
            updateEditorShallowSurfaceSection(
              gpuData.originX,
              gpuData.originZ,
              gpuData.sizeX,
              gpuData.sizeZ,
              gpuData,
            );
          }
          for (const key of Array.from(previousActiveShallowKeys)) {
            if (activeShallowKeys.has(key)) continue;
            const [originX, originZ] = key.split("_").map((value) => Number(value));
            this._shallowSectionFrameCache.delete(key);
            removeEditorShallowSurfaceSection(originX, originZ);
            this.shallowCompositeController?.removeSection(key);
            this.shallowLocalFluidCoupler?.removeSection(key);
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
        massValidationEpsilon: 0.05,
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

      const shallowDebugProfile = getActiveShallowDebugProfile();
      if (shallowDebugProfile.visuals.enableLocalFluid) {
        this.shallowLocalFluidCoupler?.update(dt);
      }
      this.spillFxRenderer.sync(
        waterHybridBridge.localFluidSystem,
        getActiveSpillEmitters().values(),
      );
      waterHybridBridge.advance(dt);
      const shallowClipState = waterHybridBridge.getClipState();
      const shallowLocalFluidSystem = waterHybridBridge.localFluidSystem;
      this.shallowCompositeController?.setLocalFluidContributions(
        shallowDebugProfile.visuals.enableLocalFluid && shallowLocalFluidSystem
          ? {
              originX: shallowClipState.originX,
              originZ: shallowClipState.originZ,
              width: Math.max(1, Math.round(1 / shallowClipState.invWidth)),
              height: Math.max(1, Math.round(1 / shallowClipState.invHeight)),
              velocityXField: shallowLocalFluidSystem.velocityXField,
              velocityZField: shallowLocalFluidSystem.velocityZField,
              fillField: shallowLocalFluidSystem.fillContribField,
              foamField: shallowLocalFluidSystem.foamContribField,
              hasFreshContributions: shallowLocalFluidSystem.hasFreshContributions,
            }
          : null,
      );
      this.shallowCompositeController?.update(dt, activeShallowKeys);
      this.continuumController?.advance(dt);
      (globalThis as any).__DVE_WATER_HYBRID_BRIDGE_FRAME__ =
        waterHybridBridge.getFrameStats();
      (globalThis as any).__DVE_WATER_LOCAL_FLUID_SOLVER_ACTIVE__ =
        waterHybridBridge.localFluidSystem?.getSolver() ?? "off";
      (globalThis as any).__DVE_SHALLOW_LOCAL_FLUID_STATS__ =
        this.shallowLocalFluidCoupler?.getStats() ?? null;

      // ── Sprint 12: Expose water capability flags for validation ──
      (globalThis as any).__DVE_SHALLOW_WATER_SECTIONS__ = activeShallowKeys?.size ?? 0;
      (globalThis as any).__DVE_GPU_FLUID_ACTIVE__ = !!(waterHybridBridge as any).gpuSim?.backend?.ready;
      (globalThis as any).__DVE_SSFR_ACTIVE__ = true;
      (globalThis as any).__DVE_GRID_DISSOLUTION_ACTIVE__ = true;
      (globalThis as any).__DVE_PUDDLE_HANDOFF_WIRED__ =
        (globalThis as any).__DVE_ENABLE_CONTINUOUS_RUNTIME_HANDOFF__ !== false;
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
        // This bootstrap happens outside the orchestrator tick, so massBefore
        // already includes the hydrated state on the next tick. Do not feed it
        // into input-phase accounting or the invariant double-counts it.
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
      this.shallowCompositeController?.removeSection(sectionKey);
      this.shallowLocalFluidCoupler?.removeSection(sectionKey);
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
          // A missing waterUpdate only means the mesher did not emit water payload
          // for this section update. The water runtime remains authoritative and
          // must not be cleared outside the orchestrator tick, or editor paints
          // can produce transient cuts and flicker before the next water frame
          // rebuilds or retires the section authoritatively.
        }
        this.splatManager!.processSectionMeshes(sectorKey, meshes);
      };

      MeshManager.onSectorRemoved = (sectorKey) => {
        this.splatManager!.removeSector(sectorKey);
        const { originX, originZ } = getWaterSectionContext(sectorKey);
        clearWaterRuntimeSection(originX, originZ, true);
        this.waterLODManager.removeChunk(originX, originZ);
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

        // Notify water runtime of terrain removal
        enqueueWaterRuntimeInputEvent({
          kind: "terrain-carve",
          worldX: x,
          worldY: y,
          worldZ: z,
        });
      };

      // Notify water runtime when a voxel is placed (terrain-fill)
      MeshManager.onVoxelPainted = (
        _dimensionId: number,
        x: number,
        y: number,
        z: number,
      ) => {
        enqueueWaterRuntimeInputEvent({
          kind: "terrain-fill",
          worldX: x,
          worldY: y,
          worldZ: z,
        });
      };
    }

    if (!EngineSettings.settings.terrain.dissolutionSplats) {
      MeshManager.onSectionUpdated = (_sectorKey, _meshes, waterUpdate) => {
        if (!waterUpdate) {
          // Keep runtime water state authoritative across mesh updates that omit
          // water payload; only the orchestrator tick or sector removal should
          // retire visual water state. Clearing here causes shallow sections to
          // blink out between mesh updates, especially around editor paints and
          // section seams.
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
        this.waterLODManager.removeChunk(originX, originZ);
      };

      // When splats are off the onVoxelErased/Painted callbacks are not set
      // above, so wire water-runtime terrain notifications here.
      if (!MeshManager.onVoxelErased) {
        MeshManager.onVoxelErased = (
          _dimensionId: number,
          x: number,
          y: number,
          z: number,
          _voxelId: number,
        ) => {
          enqueueWaterRuntimeInputEvent({
            kind: "terrain-carve",
            worldX: x,
            worldY: y,
            worldZ: z,
          });
        };
      }
      if (!MeshManager.onVoxelPainted) {
        MeshManager.onVoxelPainted = (
          _dimensionId: number,
          x: number,
          y: number,
          z: number,
        ) => {
          enqueueWaterRuntimeInputEvent({
            kind: "terrain-fill",
            worldX: x,
            worldY: y,
            worldZ: z,
          });
        };
      }
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

  paintImmediateShallowWater(
    worldX: number,
    worldY: number,
    worldZ: number,
    massDelta = 0.25,
    emitterId = 0,
    bedYHint?: number,
  ) {
    const amount = Math.max(0, massDelta);
    if (amount <= 0) return 0;

    const shallowDebugProfile = getActiveShallowDebugProfile();
    const terrainSupport = this.resolveShallowTerrainSupport(
      worldX,
      worldZ,
      worldY,
      bedYHint,
    );
    if (!terrainSupport.foundSupport) {
      (globalThis as any).__DVE_SHALLOW_LAST_PLACEMENT_REJECT__ = {
        worldX,
        worldY,
        worldZ,
        reason: "no-terrain-support",
      };
      return 0;
    }
    const bedY = terrainSupport.bedY;
    const fallDistance = Math.max(0, worldY - bedY);

    if (fallDistance > SHALLOW_DIRECT_PLACEMENT_MAX_FALL) {
      queueSpillTransfer({
        sourceDomain: "shallow",
        targetDomain: "shallow",
        worldX,
        worldY,
        worldZ,
        landingSurfaceY: bedY + amount,
        mass: amount,
        fallHeight: Math.max(0, worldY - (bedY + amount)),
        fxProfile: "waterball",
      });
      return amount;
    }

    let addedMass = placeShallowWaterSeed(
      worldX,
      worldZ,
      bedY + amount,
      amount,
      emitterId,
      shallowDebugProfile.runtimeConfig,
      {
        bedY,
        authority: "player",
      },
    );

    if (addedMass > 0) {
      const section = getShallowSection(
        getRuntimeSectionOrigin(worldX),
        getRuntimeSectionOrigin(worldZ),
      );
      if (section) {
        const localX = getRuntimeLocalCoord(worldX);
        const localZ = getRuntimeLocalCoord(worldZ);
        const column = section.columns[localZ * section.sizeX + localX];
        if (column) {
          column.authority = "player";
          column.ownershipDomain = "shallow";
        }
      }
      return addedMass;
    }

    const inserted = addContinuousWaterSeed(worldX, worldZ, bedY, amount, 1, {
      authority: "continuous-handoff",
      ownershipConfidence: 1,
      ownershipTicks: WATER_HANDOFF_GRACE_TICKS,
      handoffGraceTicks: WATER_HANDOFF_GRACE_TICKS,
    });
    return inserted > 0 ? inserted : 0;
  }

  sampleImmediateShallowPlacement(
    worldX: number,
    worldY: number,
    worldZ: number,
    bedYHint?: number,
  ) {
    const section = getShallowSection(
      getRuntimeSectionOrigin(worldX),
      getRuntimeSectionOrigin(worldZ),
    );
    if (section) {
      const localX = getRuntimeLocalCoord(worldX);
      const localZ = getRuntimeLocalCoord(worldZ);
      const column = section.columns[localZ * section.sizeX + localX];
      if (column?.active && Number.isFinite(column.bedY) && Number.isFinite(column.surfaceY)) {
        return {
          bedY: column.bedY,
          surfaceY: column.surfaceY,
        };
      }
    }

    const terrainSupport = this.resolveShallowTerrainSupport(
      worldX,
      worldZ,
      worldY,
      bedYHint,
    );
    const bedY = terrainSupport.bedY;
    return {
      bedY,
      surfaceY: bedY,
    };
  }

  private resolveShallowTerrainSupport(
    worldX: number,
    worldZ: number,
    guessY: number,
    bedYHint?: number,
  ) {
    if (Number.isFinite(bedYHint)) {
      return {
        bedY: bedYHint as number,
        foundSupport: true,
      };
    }

    const cursor = this._shallowTerrainCursor;
    const baseY = Math.round(Number.isFinite(guessY) ? guessY : 0);
    cursor.setFocalPoint(0, worldX, baseY, worldZ);

    const startY = baseY + SHALLOW_TERRAIN_SCAN_UP;
    const endY = baseY - SHALLOW_TERRAIN_SCAN_DOWN;
    for (let y = startY; y >= endY; y--) {
      const voxel = cursor.getVoxel(worldX, y, worldZ);
      if (!isTerrainSupportVoxel(voxel)) continue;
      return {
        bedY: y + 1,
        foundSupport: true,
      };
    }

    const farEndY = baseY - SHALLOW_TERRAIN_SCAN_DOWN_FAR;
    for (let coarseY = endY - SHALLOW_TERRAIN_COARSE_STEP; coarseY >= farEndY; coarseY -= SHALLOW_TERRAIN_COARSE_STEP) {
      const voxel = cursor.getVoxel(worldX, coarseY, worldZ);
      if (!isTerrainSupportVoxel(voxel)) continue;
      const refineStart = Math.min(endY, coarseY + SHALLOW_TERRAIN_COARSE_STEP - 1);
      const refineEnd = coarseY;
      for (let y = refineStart; y >= refineEnd; y--) {
        const refineVoxel = cursor.getVoxel(worldX, y, worldZ);
        if (!isTerrainSupportVoxel(refineVoxel)) continue;
        return {
          bedY: y + 1,
          foundSupport: true,
        };
      }
      return {
        bedY: coarseY + 1,
        foundSupport: true,
      };
    }

    return {
      bedY: Number.isFinite(guessY) ? guessY : 0,
      foundSupport: false,
    };
  }

  private sampleTerrainBedY(worldX: number, worldZ: number, guessY: number) {
    return this.resolveShallowTerrainSupport(worldX, worldZ, guessY).bedY;
  }

  private sampleShallowBedYForHint(
    gridOriginX: number,
    gridOriginZ: number,
    localX: number,
    localZ: number,
    fallbackBedY: number,
  ) {
    const worldX = gridOriginX + localX;
    const worldZ = gridOriginZ + localZ;
    const originX = getRuntimeSectionOrigin(worldX);
    const originZ = getRuntimeSectionOrigin(worldZ);
    const grid = getShallowSection(originX, originZ);
    if (!grid) return fallbackBedY;
    const sampleX = getRuntimeLocalCoord(worldX);
    const sampleZ = getRuntimeLocalCoord(worldZ);
    const column = grid.columns[sampleZ * grid.sizeX + sampleX];
    return Number.isFinite(column?.bedY) ? column.bedY : fallbackBedY;
  }

  private hasShallowWaterAt(worldX: number, worldZ: number) {
    const section = getShallowSection(
      getRuntimeSectionOrigin(worldX),
      getRuntimeSectionOrigin(worldZ),
    );
    if (!section) return false;
    const localX = getRuntimeLocalCoord(worldX);
    const localZ = getRuntimeLocalCoord(worldZ);
    const column = section.columns[localZ * section.sizeX + localX];
    return !!column?.active && column.ownershipDomain === "shallow" && column.thickness > 0.0001;
  }

  private hasContinuousWaterAt(worldX: number, worldZ: number) {
    const section = getContinuousSection(
      getRuntimeSectionOrigin(worldX),
      getRuntimeSectionOrigin(worldZ),
    );
    if (!section) return false;
    const localX = getRuntimeLocalCoord(worldX);
    const localZ = getRuntimeLocalCoord(worldZ);
    const column = section.columns[localZ * section.sizeX + localX];
    return !!column?.active && column.ownershipDomain === "continuous" && column.depth > 0.0001;
  }

  private getContinuousColumnAt(worldX: number, worldZ: number) {
    const section = getContinuousSection(
      getRuntimeSectionOrigin(worldX),
      getRuntimeSectionOrigin(worldZ),
    );
    if (!section) return null;
    const localX = getRuntimeLocalCoord(worldX);
    const localZ = getRuntimeLocalCoord(worldZ);
    return section.columns[localZ * section.sizeX + localX] ?? null;
  }

  private isReachableContinuousSupport(
    shallowBedY: number,
    shallowSurfaceY: number,
    column: ReturnType<DVEBabylonRenderer["getContinuousColumnAt"]>,
  ) {
    if (
      !column?.active ||
      column.ownershipDomain !== "continuous" ||
      column.depth <= 0.0001
    ) {
      return false;
    }

    const floorDrop = shallowBedY - column.bedY;
    const surfaceClearance = column.surfaceY - (shallowBedY - 0.08);
    const surfaceDelta = Math.abs(column.surfaceY - shallowSurfaceY);
    const sameWaterPlane = surfaceDelta <= 0.42;
    const coastalBridge =
      column.surfaceY >= shallowBedY - 0.22 &&
      floorDrop <= 1.1 &&
      surfaceDelta <= 0.72;

    // Deep coastal receivers can be physically valid even when the large body bed is far below the shoreline lip.
    const deepBodyReceiverHeadroom = Math.max(
      0.9,
      Math.min(3, column.depth * 0.12),
    );
    const deepBodyReceiver =
      column.depth >= 2 &&
      column.surfaceY >= shallowBedY - 0.18 &&
      shallowSurfaceY - column.surfaceY <= deepBodyReceiverHeadroom;

    return (
      (surfaceClearance >= -0.02 &&
        (floorDrop <= 0.45 || sameWaterPlane || coastalBridge)) ||
      deepBodyReceiver
    );
  }

  private hasContinuousHandoffSupport(
    worldX: number,
    worldZ: number,
    shallowBedY: number,
    shallowSurfaceY: number,
  ) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const distance = Math.abs(dx) + Math.abs(dz);
        if (distance > 1) continue;
        const column = this.getContinuousColumnAt(worldX + dx, worldZ + dz);
        if (this.isReachableContinuousSupport(shallowBedY, shallowSurfaceY, column)) {
          return true;
        }
      }
    }

    return false;
  }

  private resolveContinuousHandoffTarget(
    worldX: number,
    worldZ: number,
    shallowBedY: number,
    shallowSurfaceY: number,
  ) {
    let bestTarget: {
      worldX: number;
      worldZ: number;
      depth: number;
      surfaceY: number;
      bedY: number;
      distance: number;
    } | null = null;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const distance = Math.abs(dx) + Math.abs(dz);
        if (distance > 1) continue;
        const targetX = worldX + dx;
        const targetZ = worldZ + dz;
        const column = this.getContinuousColumnAt(targetX, targetZ);
        if (!this.isReachableContinuousSupport(shallowBedY, shallowSurfaceY, column)) {
          continue;
        }
        const candidate = {
          worldX: targetX,
          worldZ: targetZ,
          depth: column!.depth,
          surfaceY: column!.surfaceY,
          bedY: column!.bedY,
          distance,
        };
        if (!bestTarget) {
          bestTarget = candidate;
          continue;
        }
        if (candidate.depth > bestTarget.depth + 0.0001) {
          bestTarget = candidate;
          continue;
        }
        if (
          Math.abs(candidate.depth - bestTarget.depth) <= 0.0001 &&
          candidate.distance < bestTarget.distance
        ) {
          bestTarget = candidate;
        }
      }
    }

    return bestTarget;
  }

  private sampleContinuousIntegrationField(
    worldX: number,
    worldZ: number,
    shallowBedY: number,
    shallowSurfaceY: number,
  ) {
    let strongestDepth = 0;
    let strongestSurfaceY = Number.NEGATIVE_INFINITY;
    let strongestWeightedDepth = 0;
    let neighborhoodDepth = 0;
    let neighborhoodWeight = 0;
    let neighborCount = 0;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const distance = Math.abs(dx) + Math.abs(dz);
        if (distance > 1) continue;
        const column = this.getContinuousColumnAt(worldX + dx, worldZ + dz);
        if (!column) continue;
        if (!this.isReachableContinuousSupport(shallowBedY, shallowSurfaceY, column)) {
          continue;
        }
        const weight = distance === 0 ? 1 : 0.42;
        neighborCount += 1;
        neighborhoodDepth += column.depth * weight;
        neighborhoodWeight += weight;
        const weightedDepth = column.depth * weight;
        if (weightedDepth > strongestWeightedDepth) {
          strongestWeightedDepth = weightedDepth;
          strongestDepth = column.depth;
          strongestSurfaceY = column.surfaceY;
        }
      }
    }

    return {
      neighborCount,
      strongestDepth,
      strongestSurfaceY: Number.isFinite(strongestSurfaceY) ? strongestSurfaceY : 0,
      averageDepth: neighborhoodWeight > 0.0001 ? neighborhoodDepth / neighborhoodWeight : 0,
    };
  }

  private applyContinuousIntegrationMask(
    film: ShallowRenderSectionSnapshot["film"],
  ) {
    let activeColumnCount = 0;
    for (let z = 0; z < film.sizeZ; z++) {
      for (let x = 0; x < film.sizeX; x++) {
        const index = z * film.sizeX + x;
        const column = film.columns[index];
        if (!column?.active || column.coverage <= 0) continue;

        const integrationField = this.sampleContinuousIntegrationField(
          film.originX + x,
          film.originZ + z,
          column.bedY,
          column.surfaceY,
        );
        if (integrationField.neighborCount <= 0) {
          activeColumnCount += 1;
          continue;
        }

        const depthDominance = clamp01(
          (
            Math.max(
              integrationField.strongestDepth,
              integrationField.averageDepth * 0.96,
            ) -
            column.thickness * 0.34 +
            0.065
          ) / 0.26,
        );
        const handoffSignal = clamp01(
          column.handoffBlend * 0.54 +
            (column.patchHandoffReady ? 0.22 : 0) +
            (column.handoffPending ? 0.12 : 0) +
            column.deepBlend * 0.12 +
            clamp01(integrationField.neighborCount / 4) * 0.1,
        );
        const coastalPull = clamp01(integrationField.neighborCount / 4);
        const integration = clamp01(
          depthDominance * 0.48 + handoffSignal * 0.28 + coastalPull * 0.18,
        );
        const integrationFade = clamp01(
          integration * (0.62 + handoffSignal * 0.18 + coastalPull * 0.08),
        );
        const handoffProtected =
          column.handoffBlend > 0.08 ||
          column.patchHandoffReady ||
          column.handoffPending ||
          coastalPull >= 0.25;

        if (integration <= 0.02) {
          activeColumnCount += 1;
          continue;
        }

        column.coverage *= 1 - integrationFade;
        column.filmOpacity *= 1 - integrationFade * 0.92;
        column.edgeStrength *= 1 - integrationFade;
        column.foam *= 1 - integrationFade * 0.9;
        column.wetness *= 1 - integrationFade * 0.58;
        column.breakup *= 1 - integrationFade * 0.84;
        column.microRipple *= 1 - integrationFade * 0.68;
        column.filmThickness = Math.max(0.006, column.filmThickness * (1 - integrationFade * 0.74));
        column.visualSurfaceY = Math.min(
          column.visualSurfaceY,
          integrationField.strongestSurfaceY || column.visualSurfaceY,
        );
        column.handoffBlend = Math.max(column.handoffBlend, integration);
        column.deepBlend = Math.max(column.deepBlend, integration * 0.72);

        if (column.coverage <= 0.035 || column.filmOpacity <= 0.03) {
          if (handoffProtected) {
            const retainedCoverage = 0.05 + coastalPull * 0.04 + handoffSignal * 0.04;
            const retainedOpacity = 0.05 + coastalPull * 0.035 + handoffSignal * 0.04;
            column.coverage = Math.max(column.coverage, retainedCoverage);
            column.filmOpacity = Math.max(column.filmOpacity, retainedOpacity);
            column.edgeStrength = Math.max(column.edgeStrength, 0.035);
            column.breakup = Math.max(column.breakup, 0.02);
            column.microRipple = Math.max(column.microRipple, 0.02);
            activeColumnCount += 1;
            continue;
          }
          column.active = false;
          column.coverage = 0;
          column.filmOpacity = 0;
          column.edgeStrength = 0;
          column.foam = 0;
          column.breakup = 0;
          column.microRipple = 0;
          continue;
        }

        activeColumnCount += 1;
      }
    }
    film.activeColumnCount = activeColumnCount;
  }

  private buildShallowTerrainFlowHints(grid: ReturnType<typeof getShallowSection> extends infer T ? Exclude<T, undefined> : never) {
    const hints = new Array<ShallowWaterExternalFlowHint>(grid.sizeX * grid.sizeZ);
    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        const index = z * grid.sizeX + x;
        const column = grid.columns[index];
        const currentBedY = Number.isFinite(column.bedY) ? column.bedY : grid.terrainY;
        const westBedY = this.sampleShallowBedYForHint(grid.originX, grid.originZ, x - 1, z, currentBedY);
        const eastBedY = this.sampleShallowBedYForHint(grid.originX, grid.originZ, x + 1, z, currentBedY);
        const northBedY = this.sampleShallowBedYForHint(grid.originX, grid.originZ, x, z - 1, currentBedY);
        const southBedY = this.sampleShallowBedYForHint(grid.originX, grid.originZ, x, z + 1, currentBedY);
        const northWestBedY = this.sampleShallowBedYForHint(grid.originX, grid.originZ, x - 1, z - 1, currentBedY);
        const northEastBedY = this.sampleShallowBedYForHint(grid.originX, grid.originZ, x + 1, z - 1, currentBedY);
        const southWestBedY = this.sampleShallowBedYForHint(grid.originX, grid.originZ, x - 1, z + 1, currentBedY);
        const southEastBedY = this.sampleShallowBedYForHint(grid.originX, grid.originZ, x + 1, z + 1, currentBedY);

        const westDrop = Math.max(0, currentBedY - westBedY);
        const eastDrop = Math.max(0, currentBedY - eastBedY);
        const northDrop = Math.max(0, currentBedY - northBedY);
        const southDrop = Math.max(0, currentBedY - southBedY);
        const northWestDrop = Math.max(0, currentBedY - northWestBedY);
        const northEastDrop = Math.max(0, currentBedY - northEastBedY);
        const southWestDrop = Math.max(0, currentBedY - southWestBedY);
        const southEastDrop = Math.max(0, currentBedY - southEastBedY);

        let flowX = eastDrop - westDrop + (northEastDrop + southEastDrop - northWestDrop - southWestDrop) * 0.38;
        let flowZ = southDrop - northDrop + (southWestDrop + southEastDrop - northWestDrop - northEastDrop) * 0.38;

        const westWorldX = grid.originX + x - 1;
        const eastWorldX = grid.originX + x + 1;
        const northWorldZ = grid.originZ + z - 1;
        const southWorldZ = grid.originZ + z + 1;
        const worldX = grid.originX + x;
        const worldZ = grid.originZ + z;

        const continuousWest = this.hasContinuousWaterAt(westWorldX, worldZ) ? 1 : 0;
        const continuousEast = this.hasContinuousWaterAt(eastWorldX, worldZ) ? 1 : 0;
        const continuousNorth = this.hasContinuousWaterAt(worldX, northWorldZ) ? 1 : 0;
        const continuousSouth = this.hasContinuousWaterAt(worldX, southWorldZ) ? 1 : 0;
        const continuousNorthWest = this.hasContinuousWaterAt(westWorldX, northWorldZ) ? 1 : 0;
        const continuousNorthEast = this.hasContinuousWaterAt(eastWorldX, northWorldZ) ? 1 : 0;
        const continuousSouthWest = this.hasContinuousWaterAt(westWorldX, southWorldZ) ? 1 : 0;
        const continuousSouthEast = this.hasContinuousWaterAt(eastWorldX, southWorldZ) ? 1 : 0;
        flowX += (continuousEast - continuousWest) * 0.35;
        flowZ += (continuousSouth - continuousNorth) * 0.35;
        flowX +=
          (continuousNorthEast + continuousSouthEast - continuousNorthWest - continuousSouthWest) *
          0.16;
        flowZ +=
          (continuousSouthWest + continuousSouthEast - continuousNorthWest - continuousNorthEast) *
          0.16;

        const slopeStrength = clamp01(
          Math.max(
            westDrop,
            eastDrop,
            northDrop,
            southDrop,
            northWestDrop * 0.72,
            northEastDrop * 0.72,
            southWestDrop * 0.72,
            southEastDrop * 0.72,
          ) / 1.2,
        );
        const length = Math.hypot(flowX, flowZ);
        if (length > 0.0001) {
          // Normalize direction but preserve capped slope magnitude so steep
          // terrain pulls harder than gentle terrain (cap at 1.5).
          const cappedMag = Math.min(length, 1.5);
          const scale = cappedMag / length;
          flowX *= scale;
          flowZ *= scale;
        } else {
          flowX = 0;
          flowZ = 0;
        }

        const shallowWetNeighbors =
          (this.hasShallowWaterAt(westWorldX, worldZ) ? 1 : 0) +
          (this.hasShallowWaterAt(eastWorldX, worldZ) ? 1 : 0) +
          (this.hasShallowWaterAt(worldX, northWorldZ) ? 1 : 0) +
          (this.hasShallowWaterAt(worldX, southWorldZ) ? 1 : 0);
        const continuousNeighbors =
          continuousWest + continuousEast + continuousNorth + continuousSouth;
        const diagonalContinuousNeighbors =
          continuousNorthWest + continuousNorthEast + continuousSouthWest + continuousSouthEast;
        const continuousPresence = continuousNeighbors + diagonalContinuousNeighbors * 0.55;
        const dryNeighbors = Math.max(0, 4 - shallowWetNeighbors - continuousNeighbors);

        const shoreFactor = clamp01(
          dryNeighbors / 4 * 0.4 +
            continuousPresence / 4 * 0.48 +
            slopeStrength * 0.12,
        );
        const drainageMultiplier = Math.max(
          0.45,
          Math.min(
            1.28,
            0.55 +
              slopeStrength * 0.66 +
              dryNeighbors * 0.08 -
              continuousNeighbors * 0.06 -
              shallowWetNeighbors * 0.04,
          ),
        );

        hints[index] = {
          flowX,
          flowZ,
          drainageMultiplier,
          shoreFactor,
        };
      }
    }
    return hints;
  }

  private syncShallowTerrainSupport() {
    for (const grid of getActiveShallowSections().values()) {
      let guessY = Number.isFinite(grid.terrainY) ? grid.terrainY : 0;

      for (const column of grid.columns) {
        if (!column.active || column.thickness <= 0.0001) continue;
        if (Number.isFinite(column.bedY) && column.bedY !== 0) {
          guessY = column.bedY;
          break;
        }
      }

      let minBedY = Number.POSITIVE_INFINITY;
      for (let z = 0; z < grid.sizeZ; z++) {
        for (let x = 0; x < grid.sizeX; x++) {
          const index = z * grid.sizeX + x;
          const column = grid.columns[index];
          const sampleGuess =
            Number.isFinite(column.bedY) && column.bedY !== 0 ? column.bedY : guessY;
          const support = this.resolveShallowTerrainSupport(
            grid.originX + x,
            grid.originZ + z,
            sampleGuess,
          );

          if (!support.foundSupport) {
            // Void column: no terrain under this cell.
            // Active columns are left as-is so freshly placed water is never
            // wiped before the player can see it; it will evaporate naturally
            // or drain via the void-edge drain pass below.
            if (!column.active || column.thickness <= 0.0001) {
              // Inactive void column: mark NaN to poison ghost data.
              column.active = false;
              column.thickness = 0;
              column.bedY = NaN;
              column.surfaceY = NaN;
            }
            continue;
          }

          const sampledBedY = support.bedY;
          minBedY = Math.min(minBedY, sampledBedY);
          if (!column.active || column.thickness <= 0.0001) {
            column.bedY = sampledBedY;
            column.surfaceY = sampledBedY;
            continue;
          }

          column.bedY = sampledBedY;
          column.surfaceY = sampledBedY + Math.max(0, column.thickness);
        }
      }

      if (Number.isFinite(minBedY)) {
        grid.terrainY = minBedY;
      }
      setShallowWaterFlowHints(
        grid.originX,
        grid.originZ,
        this.buildShallowTerrainFlowHints(grid),
      );
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    resolveQueuedShallowTerrainSupport = null;
    for (const observer of this._beforeRenderObservers) {
      this.scene.onBeforeRenderObservable.remove(observer);
    }
    this._beforeRenderObservers.length = 0;
    this.splatManager?.dispose();
    this.splatManager = null;
    this.lodTracker?.dispose();
    this.lodTracker = null;
    this.shallowCompositeController?.dispose();
    this.shallowCompositeController = null;
    this.shallowLocalFluidCoupler?.dispose();
    this.shallowLocalFluidCoupler = null;
    this.continuumController?.dispose();
    this.continuumController = null;
    this.spillFxRenderer.clear(getSceneWaterHybridBridge(this.scene).localFluidSystem);
    this._shallowSectionFrameCache.clear();
    clearEditorShallowSurfaceRegistry();
    clearAllShallowWater();
    clearAllContinuousWater();
    clearAllSpillWater();
    this.clearDormantWaterSnapshots();
    this._durablePersistenceBackend.dispose();
    this.waterLODManager.clear();
    this.waterTransferResolver = null;
    this.waterChunkRegistry.clear();
    this.shallowBoundaryRegistry.clear();
    getSceneWaterHybridBridge(this.scene).dispose();
    if (MeshManager.onSectionUpdated) MeshManager.onSectionUpdated = null;
    if (MeshManager.onSectorRemoved) MeshManager.onSectorRemoved = null;
    if (MeshManager.onVoxelErased) MeshManager.onVoxelErased = null;
    if (MeshManager.onVoxelPainted) MeshManager.onVoxelPainted = null;
    if (DVEBabylonRenderer.instance === this) {
      DVEBabylonRenderer.instance = null as any;
    }
  }
}
