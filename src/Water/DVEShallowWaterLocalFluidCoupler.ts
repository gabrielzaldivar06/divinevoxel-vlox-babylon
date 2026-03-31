import type { ShallowWaterGPUData } from "@divinevoxel/vlox/Water/Shallow/ShallowWaterGPUDataPacker.js";
import { SHALLOW_COLUMN_STRIDE } from "@divinevoxel/vlox/Water/Shallow/ShallowWaterGPUDataPacker.js";
import { DEFAULT_SHALLOW_WATER_CONFIG } from "@divinevoxel/vlox/Water/Shallow/ShallowWaterTypes.js";
import { DVEWaterLocalFluidSystem } from "./GPU/DVEWaterLocalFluidSystem.js";
import type {
  WaterDisturbanceEvent,
  WaterLocalFluidBudget,
  WaterLocalFluidSectionRecord,
  WaterLocalFluidSolver,
} from "./GPU/DVEWaterLocalFluidTypes.js";

export interface DVEShallowWaterLocalFluidSectionSnapshot {
  key?: string;
  originX: number;
  originZ: number;
  sizeX: number;
  sizeZ: number;
  columnBuffer: Float32Array;
  columnStride: number;
  columnMetadata: Uint32Array;
  activeColumnCount?: number;
}

export interface DVEShallowWaterLocalFluidCouplerStats {
  solver: WaterLocalFluidSolver | "none";
  systemReady: boolean;
  trackedSections: number;
  registeredSections: number;
  activeSections: number;
  pendingDisturbances: number;
  emitterCount: number;
  skippedForUnavailableSystem: number;
  skippedForOffSolver: number;
  removedSections: number;
  registeredSectionsThisFrame: number;
}

export type DVEShallowWaterLocalFluidSystemSource =
  | DVEWaterLocalFluidSystem
  | (() => DVEWaterLocalFluidSystem | null)
  | null;

interface SectionSummary {
  activeCount: number;
  totalThickness: number;
  averageThickness: number;
  averageFlowSpeed: number;
  averageFlowVX: number;
  averageFlowVZ: number;
  averageSettled: number;
  averageAdhesion: number;
  averageEdgeSignal: number;
  maxThickness: number;
  maxFlowSpeed: number;
  centroidX: number;
  centroidZ: number;
  signature: number;
}

interface SectionRuntimeState {
  key: string;
  snapshot: DVEShallowWaterLocalFluidSectionSnapshot;
  record: WaterLocalFluidSectionRecord;
  particleSeedBuffer: Float32Array;
  interactionField: Float32Array;
  summary: SectionSummary;
  lastSignature: number;
  dirty: boolean;
  removed: boolean;
  registered: boolean;
  emitterId: string;
  disturbanceCooldown: number;
}

const PARTICLE_SEED_STRIDE = 8;
const DEFAULT_MAX_SEEDS_PER_SECTION = 256;
const DEFAULT_DISTURBANCE_COOLDOWN = 0.12;
const DEFAULT_MIN_SEED_THICKNESS = 0.02;
const DEFAULT_MIN_DISTURBANCE_FLOW = 0.12;
const DEFAULT_MIN_EDGE_SIGNAL = 0.25;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function mixHash(hash: number, value: number) {
  return Math.imul(hash ^ (value | 0), 16777619) >>> 0;
}

function quantize(value: number, scale = 1000) {
  return Math.round(Number.isFinite(value) ? value * scale : 0);
}

function getSectionKey(originX: number, originZ: number) {
  return `${originX}_${originZ}`;
}

function ensureFloat32ArrayLength(array: Float32Array, length: number) {
  if (array.length >= length) {
    return array;
  }
  return new Float32Array(length);
}

export class DVEShallowWaterLocalFluidCoupler {
  private readonly sections = new Map<string, SectionRuntimeState>();
  private readonly pendingDisturbances: WaterDisturbanceEvent[] = [];
  private systemSource: DVEShallowWaterLocalFluidSystemSource;
  private disposed = false;
  private maxSeedsPerSection = DEFAULT_MAX_SEEDS_PER_SECTION;
  private disturbanceCooldownSeconds = DEFAULT_DISTURBANCE_COOLDOWN;
  private minSeedThickness = DEFAULT_MIN_SEED_THICKNESS;
  private minDisturbanceFlow = DEFAULT_MIN_DISTURBANCE_FLOW;
  private minEdgeSignal = DEFAULT_MIN_EDGE_SIGNAL;
  private stats: DVEShallowWaterLocalFluidCouplerStats = this.createEmptyStats();

  constructor(
    systemOrResolver: DVEShallowWaterLocalFluidSystemSource = null,
    options?: {
      maxSeedsPerSection?: number;
      disturbanceCooldownSeconds?: number;
      minSeedThickness?: number;
      minDisturbanceFlow?: number;
      minEdgeSignal?: number;
    },
  ) {
    this.systemSource = systemOrResolver;
    if (options?.maxSeedsPerSection !== undefined) {
      this.maxSeedsPerSection = Math.max(1, options.maxSeedsPerSection);
    }
    if (options?.disturbanceCooldownSeconds !== undefined) {
      this.disturbanceCooldownSeconds = Math.max(0, options.disturbanceCooldownSeconds);
    }
    if (options?.minSeedThickness !== undefined) {
      this.minSeedThickness = Math.max(0, options.minSeedThickness);
    }
    if (options?.minDisturbanceFlow !== undefined) {
      this.minDisturbanceFlow = Math.max(0, options.minDisturbanceFlow);
    }
    if (options?.minEdgeSignal !== undefined) {
      this.minEdgeSignal = clamp01(options.minEdgeSignal);
    }
  }

  getSystem(): DVEWaterLocalFluidSystem | null {
    return this.resolveSystem();
  }

  getSolver(): WaterLocalFluidSolver | "none" {
    return this.resolveSystem()?.getSolver() ?? "none";
  }

  get isReady() {
    return this.resolveSystem()?.ready ?? false;
  }

  setSystem(systemOrResolver: DVEShallowWaterLocalFluidSystemSource) {
    this.systemSource = systemOrResolver;
  }

  setBudget(budget: Partial<WaterLocalFluidBudget>) {
    this.resolveSystem()?.setBudget(budget);
  }

  getBudget(): WaterLocalFluidBudget | null {
    return this.resolveSystem()?.getBudget() ?? null;
  }

  queueDisturbance(event: WaterDisturbanceEvent) {
    if (this.disposed) return;
    this.pendingDisturbances.push(event);
  }

  queueDisturbances(events: Iterable<WaterDisturbanceEvent>) {
    if (this.disposed) return;
    for (const event of events) {
      this.pendingDisturbances.push(event);
    }
  }

  /**
   * Non-authoritative sync from shallow runtime/render snapshots.
   * The coupler only converts section state into local fluid records and
   * disturbances. It never mutates shallow mass, ownership, or handoff.
   */
  syncSection(sectionKey: string, snapshot: DVEShallowWaterLocalFluidSectionSnapshot | ShallowWaterGPUData) {
    if (this.disposed) return;
    const key = sectionKey || getSectionKey(snapshot.originX, snapshot.originZ);
    const sizeX = Math.max(0, Math.floor(snapshot.sizeX));
    const sizeZ = Math.max(0, Math.floor(snapshot.sizeZ));
    if (sizeX <= 0 || sizeZ <= 0) {
      this.removeSection(key);
      return;
    }

    let state = this.sections.get(key);
    if (!state) {
      state = this.createSectionState(key, snapshot);
      this.sections.set(key, state);
    } else {
      state.snapshot = snapshot;
      state.record.originX = snapshot.originX;
      state.record.originZ = snapshot.originZ;
      state.record.boundsX = sizeX;
      state.record.boundsZ = sizeZ;
      state.dirty = true;
      state.removed = false;
    }
  }

  syncSectionSnapshot(sectionKey: string, snapshot: DVEShallowWaterLocalFluidSectionSnapshot | ShallowWaterGPUData) {
    this.syncSection(sectionKey, snapshot);
  }

  syncSections(
    sections: Iterable<[string, DVEShallowWaterLocalFluidSectionSnapshot | ShallowWaterGPUData]>,
  ) {
    for (const [sectionKey, snapshot] of sections) {
      this.syncSection(sectionKey, snapshot);
    }
  }

  removeSection(sectionKey: string) {
    if (this.disposed) {
      return;
    }
    const state = this.sections.get(sectionKey);
    if (!state) {
      return;
    }

    const system = this.resolveSystem();
    if (system) {
      system.removeSection(state.record.originX, state.record.originZ);
      system.unregisterDisturbanceEmitter(state.emitterId);
    }

    state.removed = true;
    this.sections.delete(sectionKey);
    this.stats.removedSections += 1;
  }

  clear() {
    if (this.disposed) {
      return;
    }
    const system = this.resolveSystem();
    if (system) {
      for (const state of this.sections.values()) {
        system.removeSection(state.record.originX, state.record.originZ);
        system.unregisterDisturbanceEmitter(state.emitterId);
      }
    }
    this.sections.clear();
    this.pendingDisturbances.length = 0;
    this.stats = this.createEmptyStats();
  }

  async ensureReady(): Promise<boolean> {
    const system = this.resolveSystem();
    if (!system) {
      return false;
    }
    if (system.ready) {
      return true;
    }
    if (system.getSolver() === "off") {
      return false;
    }
    try {
      return await system.init();
    } catch {
      return false;
    }
  }

  update(deltaSeconds = 0): void {
    this.advance(deltaSeconds);
  }

  advance(deltaSeconds = 0): void {
    if (this.disposed) {
      return;
    }

    const system = this.resolveSystem();
    const solver = system?.getSolver() ?? "none";
    this.stats.solver = solver;
    this.stats.systemReady = system?.ready ?? false;
    this.stats.trackedSections = this.sections.size;
    this.stats.registeredSections = 0;
    this.stats.activeSections = 0;
    this.stats.pendingDisturbances = this.pendingDisturbances.length;
    this.stats.emitterCount = system?.getEmitterCount() ?? 0;
    this.stats.registeredSectionsThisFrame = 0;

    if (!system || !system.ready) {
      this.stats.skippedForUnavailableSystem += 1;
      if (solver === "off") {
        this.stats.skippedForOffSolver += 1;
      }
      return;
    }

    for (const [key, state] of Array.from(this.sections)) {
      if (state.removed) {
        this.sections.delete(key);
        continue;
      }

      state.disturbanceCooldown -= deltaSeconds;

      if (!state.dirty && state.registered) {
        this.stats.registeredSections += 1;
        this.stats.activeSections += state.summary.activeCount > 0 ? 1 : 0;
        if (state.summary.activeCount > 0 && state.disturbanceCooldown <= 0) {
          const radius = clamp(
            0.9 +
              Math.sqrt(state.summary.activeCount) * 0.14 +
              state.summary.averageEdgeSignal * 0.8,
            0.9,
            4.5,
          );
          this.emitDisturbance(
            system,
            state.summary,
            state.summary.centroidX,
            state.summary.centroidZ,
            radius,
          );
          state.disturbanceCooldown = this.disturbanceCooldownSeconds;
        }
        continue;
      }

      const summary = this.buildSummaryAndRecord(state);
      state.summary = summary;
      state.dirty = false;
      const signatureChanged = summary.signature !== state.lastSignature;
      state.lastSignature = summary.signature;

      if (summary.activeCount <= 0) {
        if (state.registered) {
          system.removeSection(state.record.originX, state.record.originZ);
          system.unregisterDisturbanceEmitter(state.emitterId);
          state.registered = false;
        }
        this.sections.delete(key);
        this.stats.removedSections += 1;
        continue;
      }

      this.stats.registeredSections += 1;
      this.stats.activeSections += 1;
      if (!state.registered || signatureChanged) {
        system.registerSection(state.record);
        state.registered = true;
        this.stats.registeredSectionsThisFrame += 1;

        const radius = clamp(0.9 + Math.sqrt(summary.activeCount) * 0.14 + summary.averageEdgeSignal * 0.8, 0.9, 4.5);
        const flowRate = clamp01(
          summary.averageThickness * 0.55 +
          summary.averageFlowSpeed * 0.45 +
          summary.averageEdgeSignal * 0.35,
        );
        const centerX = summary.centroidX;
        const centerZ = summary.centroidZ;
        system.registerDisturbanceEmitter(state.emitterId, centerX, centerZ, flowRate, radius);

        if (state.disturbanceCooldown <= 0) {
          this.emitDisturbance(system, summary, centerX, centerZ, radius);
          state.disturbanceCooldown = this.disturbanceCooldownSeconds;
        }
      }
    }

    if (this.pendingDisturbances.length > 0) {
      this.flushQueuedDisturbances(system);
      this.pendingDisturbances.length = 0;
    }

    system.flushDisturbances();

    this.stats.pendingDisturbances = 0;
    this.stats.emitterCount = system.getEmitterCount();
  }

  getStats(): DVEShallowWaterLocalFluidCouplerStats {
    return { ...this.stats };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.clear();
    this.disposed = true;
  }

  private resolveSystem(): DVEWaterLocalFluidSystem | null {
    if (this.systemSource instanceof DVEWaterLocalFluidSystem) {
      return this.systemSource;
    }
    if (typeof this.systemSource === "function") {
      return this.systemSource();
    }
    return null;
  }

  private createEmptyStats(): DVEShallowWaterLocalFluidCouplerStats {
    return {
      solver: "none",
      systemReady: false,
      trackedSections: 0,
      registeredSections: 0,
      activeSections: 0,
      pendingDisturbances: 0,
      emitterCount: 0,
      skippedForUnavailableSystem: 0,
      skippedForOffSolver: 0,
      removedSections: 0,
      registeredSectionsThisFrame: 0,
    };
  }

  private createSectionState(
    key: string,
    snapshot: DVEShallowWaterLocalFluidSectionSnapshot | ShallowWaterGPUData,
  ): SectionRuntimeState {
    const sizeX = Math.max(0, Math.floor(snapshot.sizeX));
    const sizeZ = Math.max(0, Math.floor(snapshot.sizeZ));
    const seedBuffer = new Float32Array(Math.max(1, sizeX * sizeZ * PARTICLE_SEED_STRIDE));
    const interactionField = new Float32Array(Math.max(1, sizeX * sizeZ));
    const emitterId = `shallow:${key}`;
    return {
      key,
      snapshot,
      record: {
        originX: snapshot.originX,
        originZ: snapshot.originZ,
        boundsX: sizeX,
        boundsZ: sizeZ,
        particleSeedBuffer: seedBuffer,
        particleSeedStride: PARTICLE_SEED_STRIDE,
        particleSeedCount: 0,
        interactionField,
        interactionFieldSize: sizeX,
      },
      particleSeedBuffer: seedBuffer,
      interactionField,
      summary: {
        activeCount: 0,
        totalThickness: 0,
        averageThickness: 0,
        averageFlowSpeed: 0,
        averageFlowVX: 0,
        averageFlowVZ: 0,
        averageSettled: 0,
        averageAdhesion: 0,
        averageEdgeSignal: 0,
        maxThickness: 0,
        maxFlowSpeed: 0,
        centroidX: snapshot.originX + sizeX * 0.5,
        centroidZ: snapshot.originZ + sizeZ * 0.5,
        signature: 0,
      },
      lastSignature: 0,
      dirty: true,
      removed: false,
      registered: false,
      emitterId,
      disturbanceCooldown: 0,
    };
  }

  private buildSummaryAndRecord(state: SectionRuntimeState): SectionSummary {
    const snapshot = state.snapshot;
    const sizeX = Math.max(0, Math.floor(snapshot.sizeX));
    const sizeZ = Math.max(0, Math.floor(snapshot.sizeZ));
    const columnCount = sizeX * sizeZ;
    const stride = Math.max(SHALLOW_COLUMN_STRIDE, Math.floor(snapshot.columnStride || SHALLOW_COLUMN_STRIDE));
    const columns = snapshot.columnBuffer;
    const metadata = snapshot.columnMetadata;
    const maxSeeds = Math.min(this.maxSeedsPerSection, Math.max(1, columnCount));
    const seedBuffer = ensureFloat32ArrayLength(state.particleSeedBuffer, maxSeeds * PARTICLE_SEED_STRIDE);
    const interactionField = ensureFloat32ArrayLength(state.interactionField, columnCount);
    state.particleSeedBuffer = seedBuffer;
    state.interactionField = interactionField;
    state.record.particleSeedBuffer = seedBuffer;
    state.record.interactionField = interactionField;
    state.record.interactionFieldSize = sizeX;
    state.record.particleSeedStride = PARTICLE_SEED_STRIDE;
    state.record.boundsX = sizeX;
    state.record.boundsZ = sizeZ;
    state.record.originX = snapshot.originX;
    state.record.originZ = snapshot.originZ;

    let activeCount = 0;
    let totalThickness = 0;
    let totalFlowSpeed = 0;
    let totalFlowVX = 0;
    let totalFlowVZ = 0;
    let totalSettled = 0;
    let totalAdhesion = 0;
    let totalEdgeSignal = 0;
    let maxThickness = 0;
    let maxFlowSpeed = 0;
    let centroidX = 0;
    let centroidZ = 0;
    let centroidWeight = 0;
    let seedCount = 0;
    let signature = 2166136261 >>> 0;

    for (let z = 0; z < sizeZ; z++) {
      for (let x = 0; x < sizeX; x++) {
        const columnIndex = z * sizeX + x;
        if (columnIndex >= columnCount) {
          continue;
        }
        const meta = metadata[columnIndex] ?? 0;
        const active = (meta & 1) !== 0;
        const columnBase = columnIndex * stride;
        const thickness = active ? (columns[columnBase + 0] ?? 0) : 0;
        const surfaceY = active ? (columns[columnBase + 1] ?? 0) : 0;
        const bedY = columns[columnBase + 2] ?? surfaceY;
        const spreadVX = active ? (columns[columnBase + 3] ?? 0) : 0;
        const spreadVZ = active ? (columns[columnBase + 4] ?? 0) : 0;
        const settled = active ? (columns[columnBase + 5] ?? 0) : 0;
        const adhesion = active ? (columns[columnBase + 6] ?? 0) : 0;
        const emitterId = active ? (columns[columnBase + 8] ?? 0) : 0;
        const shoreDistance = active ? (columns[columnBase + 9] ?? 0) : 0;

        const flowSpeed = Math.hypot(spreadVX, spreadVZ);
        const coverage = clamp01(thickness / DEFAULT_SHALLOW_WATER_CONFIG.handoffThickness);
        const edgeSignal = clamp01(1 - shoreDistance / 4);
        const localInteraction = clamp01(
          coverage * 0.45 +
          flowSpeed * 0.25 +
          edgeSignal * 0.4 +
          (1 - settled) * 0.12 +
          adhesion * 0.08,
        );
        interactionField[columnIndex] = localInteraction;

        signature = mixHash(signature, active ? 1 : 0);
        signature = mixHash(signature, quantize(thickness));
        signature = mixHash(signature, quantize(surfaceY));
        signature = mixHash(signature, quantize(bedY));
        signature = mixHash(signature, quantize(spreadVX));
        signature = mixHash(signature, quantize(spreadVZ));
        signature = mixHash(signature, quantize(settled));
        signature = mixHash(signature, quantize(adhesion));
        signature = mixHash(signature, quantize(shoreDistance));
        signature = mixHash(signature, emitterId | 0);

        if (!active) {
          continue;
        }

        activeCount += 1;
        totalThickness += thickness;
        totalFlowSpeed += flowSpeed;
        totalFlowVX += spreadVX;
        totalFlowVZ += spreadVZ;
        totalSettled += settled;
        totalAdhesion += adhesion;
        totalEdgeSignal += edgeSignal;
        maxThickness = Math.max(maxThickness, thickness);
        maxFlowSpeed = Math.max(maxFlowSpeed, flowSpeed);
        centroidX += (snapshot.originX + x + 0.5) * thickness;
        centroidZ += (snapshot.originZ + z + 0.5) * thickness;
        centroidWeight += thickness;

        if (seedCount < maxSeeds && thickness >= this.minSeedThickness) {
          const seedBase = seedCount * PARTICLE_SEED_STRIDE;
          seedBuffer[seedBase + 0] = snapshot.originX + x + 0.5;
          seedBuffer[seedBase + 1] = surfaceY;
          seedBuffer[seedBase + 2] = snapshot.originZ + z + 0.5;
          seedBuffer[seedBase + 3] = spreadVX * 0.85;
          seedBuffer[seedBase + 4] = 0;
          seedBuffer[seedBase + 5] = spreadVZ * 0.85;
          seedBuffer[seedBase + 6] = clamp(0.12 + thickness * 0.28 + edgeSignal * 0.18, 0.12, 0.95);
          seedBuffer[seedBase + 7] = edgeSignal > 0.45 || flowSpeed > this.minDisturbanceFlow ? 1 : 0;
          seedCount += 1;
        }
      }
    }

    if (centroidWeight <= 0) {
      centroidX = snapshot.originX + sizeX * 0.5;
      centroidZ = snapshot.originZ + sizeZ * 0.5;
    } else {
      centroidX /= centroidWeight;
      centroidZ /= centroidWeight;
    }

    state.record.particleSeedCount = seedCount;

    const averageThickness = activeCount > 0 ? totalThickness / activeCount : 0;
    const averageFlowSpeed = activeCount > 0 ? totalFlowSpeed / activeCount : 0;
    const averageFlowVX = activeCount > 0 ? totalFlowVX / activeCount : 0;
    const averageFlowVZ = activeCount > 0 ? totalFlowVZ / activeCount : 0;
    const averageSettled = activeCount > 0 ? totalSettled / activeCount : 0;
    const averageAdhesion = activeCount > 0 ? totalAdhesion / activeCount : 0;
    const averageEdgeSignal = activeCount > 0 ? totalEdgeSignal / activeCount : 0;

    signature = mixHash(signature, activeCount);
    signature = mixHash(signature, quantize(totalThickness));
    signature = mixHash(signature, quantize(totalFlowSpeed));
    signature = mixHash(signature, quantize(averageThickness));
    signature = mixHash(signature, quantize(averageFlowSpeed));
    signature = mixHash(signature, quantize(averageEdgeSignal));
    signature = mixHash(signature, quantize(centroidX));
    signature = mixHash(signature, quantize(centroidZ));

    return {
      activeCount,
      totalThickness,
      averageThickness,
      averageFlowSpeed,
      averageFlowVX,
      averageFlowVZ,
      averageSettled,
      averageAdhesion,
      averageEdgeSignal,
      maxThickness,
      maxFlowSpeed,
      centroidX,
      centroidZ,
      signature,
    };
  }

  private emitDisturbance(
    system: DVEWaterLocalFluidSystem,
    summary: SectionSummary,
    centerX: number,
    centerZ: number,
    radius: number,
  ) {
    if (summary.activeCount <= 0) {
      return;
    }

    const energy = clamp01(
      summary.averageThickness * 0.5 +
      summary.averageFlowSpeed * 0.45 +
      summary.averageEdgeSignal * 0.35 +
      summary.maxFlowSpeed * 0.2,
    );

    if (summary.averageFlowSpeed >= this.minDisturbanceFlow) {
      system.dispatchActorWake(
        centerX,
        centerZ,
        summary.averageFlowVX,
        summary.averageFlowVZ,
        radius,
        energy,
      );
      return;
    }

    if (summary.averageEdgeSignal >= this.minEdgeSignal || summary.maxThickness >= DEFAULT_SHALLOW_WATER_CONFIG.handoffThickness * 0.5) {
      system.dispatchImpact(centerX, centerZ, energy, radius);
    }
  }

  private flushQueuedDisturbances(system: DVEWaterLocalFluidSystem) {
    for (const event of this.pendingDisturbances) {
      switch (event.kind) {
        case "wake":
          system.dispatchActorWake(
            event.worldX,
            event.worldZ,
            event.velocityX ?? 0,
            event.velocityZ ?? 0,
            event.radius,
            event.energy,
          );
          break;
        case "actor-wade":
          system.dispatchActorWade(
            event.worldX,
            event.worldZ,
            event.velocityX ?? 0,
            event.velocityZ ?? 0,
            event.radius,
          );
          break;
        case "heavy-impact":
          system.dispatchHeavyImpact(
            event.worldX,
            event.worldZ,
            event.mass ?? Math.max(event.energy, 0.1),
            Math.max(0.1, event.energy),
            event.radius,
          );
          break;
        case "object-splash":
          system.dispatchObjectSplash(
            event.worldX,
            event.worldZ,
            event.mass ?? Math.max(event.energy * 10, 0.1),
            Math.max(0.1, event.energy),
          );
          break;
        case "impact":
          system.dispatchImpact(event.worldX, event.worldZ, event.energy, event.radius);
          break;
        case "emitter": {
          const emitterId = `manual:${Math.round(event.worldX * 10)}:${Math.round(event.worldZ * 10)}:${Math.round(event.radius * 10)}`;
          system.registerDisturbanceEmitter(emitterId, event.worldX, event.worldZ, event.energy, event.radius);
          break;
        }
      }
    }
  }
}
