import type { Scene } from "@babylonjs/core/scene";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { WaterSectionGPUData } from "@divinevoxel/vlox/Water/Types/WaterTypes.js";
import { DVEWaterLocalFluidSystem } from "./GPU/DVEWaterLocalFluidSystem.js";
import type { WaterLocalFluidBudget } from "./GPU/DVEWaterLocalFluidTypes.js";
import { DVEWaterComputeRefiner } from "./GPU/DVEWaterComputeRefiner.js";
import {
  type HybridBridgeContinuousSectionInput,
  type HybridBridgeShallowSectionInput,
  readHybridContinuousColumn,
  readHybridShallowColumn,
} from "./DVEWaterHybridBridge.contracts.js";
import {
  refineHybridVisualFields,
  type HybridVisualRefinerFields,
  type HybridVisualRefinerTuning,
} from "./DVEWaterHybridVisualRefiner.js";

const DEFAULT_PIXEL = new Uint8Array([128, 32, 192, 255]);
const bridgeCache = new WeakMap<Scene, DVEWaterHybridBridge>();
const HYBRID_TEXTURE_SIZE = 256;
const HYBRID_CLIP_HALF = HYBRID_TEXTURE_SIZE / 2;
const FLOW_PULSE_SCALE = 0.08;
const PARTICLE_TIME_WRAP = 12;
const CLIP_REBUILD_STEP = 8;
const SIMULATION_STEP = 1 / 30;
const MAX_SIMULATION_STEPS = 3;
const TARGET_REBUILD_INTERVAL = 1 / 10;
const VELOCITY_ADVECTION = 2.2;
const VELOCITY_DAMPING = 0.92;
const TARGET_PULL = 0.12;
const FILL_RELAXATION = 0.22;
const PRESSURE_RESPONSE = 0.18;
// WaterBall Tait EOS: tension-free pressure (max(0,...) = fluid only pushes, never retracts)
const TAIT_STIFFNESS = 0.38;
const TAIT_REST_DENSITY = 0.55;
const FOAM_DECAY = 0.94;
const EDGE_DECAY = 0.9;
const MASS_TRANSFER_RATE = 4.2;
const MASS_RETENTION = 0.985;
const MOMENTUM_RESPONSE = 0.28;
const VELOCITY_LIMIT = 1.35;
const INTERACTION_TO_FLOW = 0.22;
const INTERACTION_TO_FOAM = 0.3;
const INTERACTION_TO_PRESSURE = 0.2;

const HYBRID_VISUAL_REFINER_TUNING: HybridVisualRefinerTuning = {
  velocityAdvection: VELOCITY_ADVECTION,
  velocityDamping: VELOCITY_DAMPING,
  targetPull: TARGET_PULL,
  fillRelaxation: FILL_RELAXATION,
  pressureResponse: PRESSURE_RESPONSE,
  taitStiffness: TAIT_STIFFNESS,
  taitRestDensity: TAIT_REST_DENSITY,
  foamDecay: FOAM_DECAY,
  edgeDecay: EDGE_DECAY,
  massTransferRate: MASS_TRANSFER_RATE,
  massRetention: MASS_RETENTION,
  momentumResponse: MOMENTUM_RESPONSE,
  velocityLimit: VELOCITY_LIMIT,
  interactionToFlow: INTERACTION_TO_FLOW,
  interactionToFoam: INTERACTION_TO_FOAM,
  interactionToPressure: INTERACTION_TO_PRESSURE,
};

function isSettledBenchmarkHydrology() {
  const benchmark = (globalThis as any).__DVE_TERRAIN_BENCHMARK__;
  return benchmark?.hydrologySettled === true;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function fract(value: number) {
  return value - Math.floor(value);
}

function createTexture(scene: Scene, data: Uint8Array, width: number, height: number) {
  const texture = RawTexture.CreateRGBATexture(
    data,
    width,
    height,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.name = "dve_water_hybrid";
  return texture;
}

function shouldWriteDebugTexture(scene: Scene) {
  const mode = String(scene.metadata?.dveWaterDebugMode || "off").toLowerCase();
  return mode !== "off";
}

export interface WaterHybridBridgeFrameStats {
  frame: number;
  dirtyAtFrameStart: boolean;
  targetsDirty: boolean;
  targetsDirtyMarks: number;
  rebuildTargetsCalls: number;
  simulateStepCalls: number;
  textureUpdateCalls: number;
  textureUploadPasses: number;
  convergedTransitions: number;
  convergedState: boolean;
  skippedForSettled: boolean;
  skippedForConverged: boolean;
  shallowInjectedSections: number;
  shallowRetainedSections: number;
  shallowRemovedSections: number;
  clipRecentered: boolean;
  activeContinuousSections: number;
  activeShallowSections: number;
  dirtyReasons: Record<string, number>;
}

export class DVEWaterHybridBridge {
  baseTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
  dynamicTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
  flowTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
  debugTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
  private baseStagingTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
  private dynamicStagingTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
  private flowStagingTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
  private debugStagingTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
  private fillField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private fillFieldNext = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private velocityXField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private velocityXFieldNext = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private velocityZField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private velocityZFieldNext = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private foamField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private foamFieldNext = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private targetFillField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private targetVelocityXField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private targetVelocityZField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private targetFlowField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private targetTurbulenceField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private targetShoreField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private targetInteractionField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private targetLargeBodyField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private targetPatchFlowField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private targetPatchPhaseField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private targetPresenceField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private particleFoamField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private particleFlowField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private pressureField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private pressureFieldNext = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  // Visual-only redistribution term used by the bridge refiner. It must never
  // be fed back into runtime physics ownership, transport, or mass accounting.
  private visualMassDeltaField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private shiftFieldScratch = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  // Extracted visual inputs only. The bridge may refine and pack these for shading,
  // but it must never become gameplay authority for water state.
  private sectionStates = new Map<string, HybridBridgeContinuousSectionInput>();
  private shallowSectionStates = new Map<string, HybridBridgeShallowSectionInput>();
  private shallowSectionsSeenThisFrame = new Set<string>();
  private targetsDirty = false;
  /** True once simulation has converged (max field delta below threshold). */
  private _converged = false;
  /** Frames since last significant field change. */
  private _stableFrames = 0;
  baseTexture: RawTexture;
  dynamicTexture: RawTexture;
  flowTexture: RawTexture;
  debugTexture: RawTexture;
  width = HYBRID_TEXTURE_SIZE;
  height = HYBRID_TEXTURE_SIZE;
  /** Local fluid simulation backend selected by explicit solver gate. */
  private gpuSim: DVEWaterLocalFluidSystem | null = null;

  get localFluidSystem(): DVEWaterLocalFluidSystem | null {
    return this.gpuSim;
  }

  // ── Gameplay disturbance convenience API ────────────────────
  dispatchActorWake(worldX: number, worldZ: number, vx: number, vz: number, radius?: number, energy?: number): void {
    this.gpuSim?.dispatchActorWake(worldX, worldZ, vx, vz, radius, energy);
  }

  dispatchActorWade(worldX: number, worldZ: number, vx: number, vz: number, legRadius?: number): void {
    this.gpuSim?.dispatchActorWade(worldX, worldZ, vx, vz, legRadius);
  }

  dispatchImpact(worldX: number, worldZ: number, energy: number, radius?: number): void {
    this.gpuSim?.dispatchImpact(worldX, worldZ, energy, radius);
  }

  dispatchHeavyImpact(worldX: number, worldZ: number, mass: number, velocity: number, radius?: number): void {
    this.gpuSim?.dispatchHeavyImpact(worldX, worldZ, mass, velocity, radius);
  }

  dispatchObjectSplash(worldX: number, worldZ: number, mass: number, impactVelocity: number): void {
    this.gpuSim?.dispatchObjectSplash(worldX, worldZ, mass, impactVelocity);
  }

  setFluidBudget(partial: Partial<WaterLocalFluidBudget>): void {
    this.gpuSim?.setBudget(partial);
  }

  /** Phase-9 GPU compute refiner: replaces simulateStep + packTextures with WebGPU compute. */
  private computeRefiner: DVEWaterComputeRefiner | null = null;
  private elapsedTime = 0;
  private accumulatedDelta = 0;
  private targetRebuildAccumulator = 0;
  private clipOriginX = -HYBRID_CLIP_HALF;
  private clipOriginZ = -HYBRID_CLIP_HALF;
  private frameCounter = 0;
  private frameStats: WaterHybridBridgeFrameStats = this.createEmptyFrameStats(0);

  constructor(public scene: Scene) {
    this.baseTextureData.fill(0);
    this.dynamicTextureData.fill(0);
    this.flowTextureData.fill(0);
    this.debugTextureData.fill(0);
    this.fillField.fill(0);
    this.fillFieldNext.fill(0);
    this.velocityXField.fill(0);
    this.velocityXFieldNext.fill(0);
    this.velocityZField.fill(0);
    this.velocityZFieldNext.fill(0);
    this.foamField.fill(0);
    this.foamFieldNext.fill(0);
    this.targetFillField.fill(0);
    this.targetVelocityXField.fill(0);
    this.targetVelocityZField.fill(0);
    this.targetFlowField.fill(0);
    this.targetTurbulenceField.fill(0);
    this.targetShoreField.fill(0);
    this.targetInteractionField.fill(0);
    this.targetLargeBodyField.fill(0);
    this.targetPatchFlowField.fill(0);
    this.targetPatchPhaseField.fill(0);
    this.targetPresenceField.fill(0);
    this.particleFoamField.fill(0);
    this.particleFlowField.fill(0);
    this.pressureField.fill(0);
    this.pressureFieldNext.fill(0);
    this.visualMassDeltaField.fill(0);
    this.baseTextureData.set(DEFAULT_PIXEL, 0);
    this.dynamicTextureData.set(DEFAULT_PIXEL, 0);
    this.flowTextureData.set(DEFAULT_PIXEL, 0);
    this.debugTextureData.set(DEFAULT_PIXEL, 0);
    this.baseTexture = createTexture(scene, this.baseTextureData, this.width, this.height);
    this.baseTexture.name = "dve_water_hybrid_base";
    this.dynamicTexture = createTexture(scene, this.dynamicTextureData, this.width, this.height);
    this.dynamicTexture.name = "dve_water_hybrid_dynamic";
    this.flowTexture = createTexture(scene, this.flowTextureData, this.width, this.height);
    this.flowTexture.name = "dve_water_hybrid_flow";
    this.debugTexture = createTexture(scene, this.debugTextureData, this.width, this.height);
    this.debugTexture.name = "dve_water_hybrid_debug";

    // Initialise local fluid simulation through the solver gate.
    // When WebGPU is available, MLS-MPM is now preferred and PBF remains fallback.
    this.gpuSim = new DVEWaterLocalFluidSystem();
    this.gpuSim.init().then((ok) => {
      if (!ok) {
        this.gpuSim = null;
      }
    });

    // Phase-9: initialise GPU compute refiner (simulateStep + packTextures on GPU).
    this.computeRefiner = new DVEWaterComputeRefiner();
    this.computeRefiner.init().then((ok) => {
      if (!ok) {
        this.computeRefiner = null;
      }
    });
  }

  getBaseTexture() {
    return this.baseTexture;
  }

  getDynamicTexture() {
    return this.dynamicTexture;
  }

  getFlowTexture() {
    return this.flowTexture;
  }

  getDebugTexture() {
    return this.debugTexture;
  }

  getClipState() {
    return {
      originX: this.clipOriginX,
      originZ: this.clipOriginZ,
      invWidth: 1 / this.width,
      invHeight: 1 / this.height,
    };
  }

  private createEmptyFrameStats(frame: number): WaterHybridBridgeFrameStats {
    return {
      frame,
      dirtyAtFrameStart: false,
      targetsDirty: false,
      targetsDirtyMarks: 0,
      rebuildTargetsCalls: 0,
      simulateStepCalls: 0,
      textureUpdateCalls: 0,
      textureUploadPasses: 0,
      convergedTransitions: 0,
      convergedState: false,
      skippedForSettled: false,
      skippedForConverged: false,
      shallowInjectedSections: 0,
      shallowRetainedSections: 0,
      shallowRemovedSections: 0,
      clipRecentered: false,
      activeContinuousSections: 0,
      activeShallowSections: 0,
      dirtyReasons: {},
    };
  }

  beginFrame() {
    this.frameCounter += 1;
    this.frameStats = this.createEmptyFrameStats(this.frameCounter);
    this.frameStats.dirtyAtFrameStart = this.targetsDirty;
    this.frameStats.targetsDirty = this.targetsDirty;
    this.frameStats.convergedState = this._converged;
    this.frameStats.activeContinuousSections = this.sectionStates.size;
    this.frameStats.activeShallowSections = this.shallowSectionStates.size;
  }

  getFrameStats(): WaterHybridBridgeFrameStats {
    return {
      ...this.frameStats,
      targetsDirty: this.targetsDirty,
      convergedState: this._converged,
      activeContinuousSections: this.sectionStates.size,
      activeShallowSections: this.shallowSectionStates.size,
      dirtyReasons: { ...this.frameStats.dirtyReasons },
    };
  }

  private noteTargetsDirty(reason: string) {
    this.targetsDirty = true;
    this._converged = false;
    this._stableFrames = 0;
    this.frameStats.targetsDirty = true;
    this.frameStats.targetsDirtyMarks += 1;
    this.frameStats.convergedState = false;
    this.frameStats.dirtyReasons[reason] = (this.frameStats.dirtyReasons[reason] ?? 0) + 1;
  }

  private runRebuildTargets() {
    this.frameStats.rebuildTargetsCalls += 1;
    this.rebuildTargets();
  }

  private runSimulateStep(deltaSeconds: number) {
    this.frameStats.simulateStepCalls += 1;
    this.simulateStep(deltaSeconds);
  }

  private uploadTextures(writeDebugTexture: boolean) {
    this.frameStats.textureUploadPasses += 1;
    this.baseTexture.update(this.baseTextureData);
    this.dynamicTexture.update(this.dynamicTextureData);
    this.flowTexture.update(this.flowTextureData);
    this.frameStats.textureUpdateCalls += 3;
    if (writeDebugTexture) {
      this.debugTexture.update(this.debugTextureData);
      this.frameStats.textureUpdateCalls += 1;
    }
    this.frameStats.targetsDirty = this.targetsDirty;
  }

  reset() {
    this.width = HYBRID_TEXTURE_SIZE;
    this.height = HYBRID_TEXTURE_SIZE;
    this.baseTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
    this.dynamicTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
    this.flowTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
    this.debugTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
    this.baseStagingTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
    this.dynamicStagingTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
    this.flowStagingTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
    this.debugStagingTextureData = new Uint8Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE * 4);
    this.sectionStates.clear();
    this.shallowSectionStates.clear();
    this.shallowSectionsSeenThisFrame.clear();
    this.elapsedTime = 0;
    this.accumulatedDelta = 0;
    this.targetRebuildAccumulator = 0;
    this.clipOriginX = -HYBRID_CLIP_HALF;
    this.clipOriginZ = -HYBRID_CLIP_HALF;
    this.baseTextureData.fill(0);
    this.dynamicTextureData.fill(0);
    this.flowTextureData.fill(0);
    this.debugTextureData.fill(0);
    this.fillField.fill(0);
    this.fillFieldNext.fill(0);
    this.velocityXField.fill(0);
    this.velocityXFieldNext.fill(0);
    this.velocityZField.fill(0);
    this.velocityZFieldNext.fill(0);
    this.foamField.fill(0);
    this.foamFieldNext.fill(0);
    this.targetFillField.fill(0);
    this.targetVelocityXField.fill(0);
    this.targetVelocityZField.fill(0);
    this.targetFlowField.fill(0);
    this.targetTurbulenceField.fill(0);
    this.targetShoreField.fill(0);
    this.targetInteractionField.fill(0);
    this.targetLargeBodyField.fill(0);
    this.targetPatchFlowField.fill(0);
    this.targetPatchPhaseField.fill(0);
    this.targetPresenceField.fill(0);
    this.particleFoamField.fill(0);
    this.particleFlowField.fill(0);
    this.pressureField.fill(0);
    this.pressureFieldNext.fill(0);
    this.visualMassDeltaField.fill(0);
    this.baseTextureData.set(DEFAULT_PIXEL, 0);
    this.dynamicTextureData.set(DEFAULT_PIXEL, 0);
    this.flowTextureData.set(DEFAULT_PIXEL, 0);
    this.uploadTextures(false);
    this.gpuSim?.clearSections();
  }

  private getClipIndex(worldX: number, worldZ: number) {
    if (!this.isInClipBounds(worldX, worldZ)) {
      return -1;
    }
    const localX = worldX - this.clipOriginX;
    const localZ = worldZ - this.clipOriginZ;
    return localX * this.height + localZ;
  }

  private shiftField(field: Float32Array, shiftX: number, shiftZ: number) {
    this.shiftFieldScratch.fill(0);
    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.height; z++) {
        const sourceX = x + shiftX;
        const sourceZ = z + shiftZ;
        if (sourceX < 0 || sourceX >= this.width || sourceZ < 0 || sourceZ >= this.height) {
          continue;
        }
        this.shiftFieldScratch[x * this.height + z] = field[sourceX * this.height + sourceZ];
      }
    }
    field.set(this.shiftFieldScratch);
  }

  private shiftSimulationFields(shiftX: number, shiftZ: number) {
    if (shiftX === 0 && shiftZ === 0) {
      return;
    }
    this.shiftField(this.fillField, shiftX, shiftZ);
    this.shiftField(this.velocityXField, shiftX, shiftZ);
    this.shiftField(this.velocityZField, shiftX, shiftZ);
    this.shiftField(this.foamField, shiftX, shiftZ);
    this.shiftField(this.pressureField, shiftX, shiftZ);
  }

  private isInClipBounds(x: number, z: number) {
    return (
      x >= this.clipOriginX &&
      x < this.clipOriginX + this.width &&
      z >= this.clipOriginZ &&
      z < this.clipOriginZ + this.height
    );
  }

  private stampParticles(section: HybridBridgeContinuousSectionInput) {
    const particleStride = section.gpuData.particleSeedStride;
    const particleCount = section.gpuData.particleSeedCount;
    const particles = section.gpuData.particleSeedBuffer;
    const time = this.elapsedTime % PARTICLE_TIME_WRAP;

    for (let index = 0; index < particleCount; index++) {
      const baseIndex = index * particleStride;
      const startX = particles[baseIndex];
      const startZ = particles[baseIndex + 2];
      const velocityX = particles[baseIndex + 3];
      const velocityZ = particles[baseIndex + 5];
      const radius = Math.max(0.75, particles[baseIndex + 6] * 5);
      const kind = particles[baseIndex + 7];
      const x = startX + velocityX * time * 3.5;
      const z = startZ + velocityZ * time * 3.5;
      const cx = Math.floor(x);
      const cz = Math.floor(z);
      const intensity = kind > 0 ? 0.18 : 0.3;

      for (let offsetX = -2; offsetX <= 2; offsetX++) {
        for (let offsetZ = -2; offsetZ <= 2; offsetZ++) {
          const dx = offsetX;
          const dz = offsetZ;
          const distance = Math.sqrt(dx * dx + dz * dz);
          const falloff = clamp01(1 - distance / radius);
          if (falloff <= 0) continue;
          const clipIndex = this.getClipIndex(cx + offsetX, cz + offsetZ);
          if (clipIndex < 0) continue;
          this.particleFoamField[clipIndex] = Math.max(this.particleFoamField[clipIndex], falloff * intensity);
          this.particleFlowField[clipIndex] = Math.max(
            this.particleFlowField[clipIndex],
            falloff * (0.22 + Math.abs(velocityX) * 0.14 + Math.abs(velocityZ) * 0.14),
          );
        }
      }
    }
  }

  private rebuildTargets() {
    this.targetFillField.fill(0);
    this.targetVelocityXField.fill(0);
    this.targetVelocityZField.fill(0);
    this.targetFlowField.fill(0);
    this.targetTurbulenceField.fill(0);
    this.targetShoreField.fill(0);
    this.targetInteractionField.fill(0);
    this.targetLargeBodyField.fill(0);
    this.targetPatchFlowField.fill(0);
    this.targetPatchPhaseField.fill(0);
    this.targetPresenceField.fill(0);
    this.particleFoamField.fill(0);
    this.particleFlowField.fill(0);
    for (const section of this.sectionStates.values()) {
      const intersectsClip = !(
        section.originX + section.boundsX < this.clipOriginX ||
        section.originX > this.clipOriginX + this.width ||
        section.originZ + section.boundsZ < this.clipOriginZ ||
        section.originZ > this.clipOriginZ + this.height
      );
      if (!intersectsClip) continue;

      const stride = section.gpuData.columnStride;
      for (let index = 0; index < section.boundsX * section.boundsZ; index++) {
        const localX = Math.floor(index / section.boundsZ);
        const localZ = index % section.boundsZ;
        const worldX = section.originX + localX;
        const worldZ = section.originZ + localZ;
        const clipIndex = this.getClipIndex(worldX, worldZ);
        if (clipIndex < 0) continue;
        const dataIndex = index * stride;
        const column = readHybridContinuousColumn(section, localX, localZ);
        if (!column.filled) continue;

        let resolvedFlowX = column.flowX;
        let resolvedFlowZ = column.flowZ;
        let resolvedFlowStrength = column.flowStrength;
        let resolvedTurbulence = column.turbulence;
        let shoreFactor = column.shoreFactor;
        const patchSummary = column.patchSummary;
        if (patchSummary) {
          const patchMeanFlow = clamp01(patchSummary.meanFlow);
          const patchMeanTurbulence = clamp01(patchSummary.meanTurbulence);
          const patchWaveDirectionX = patchSummary.dominantWaveDirectionX;
          const patchWaveDirectionZ = patchSummary.dominantWaveDirectionZ;
          const patchShoreInfluence = clamp01(patchSummary.shoreInfluence);
          const patchPhase = this.getPatchPhase(patchSummary.antiPeriodicitySeed);
          const directionWeight = 0.25 + patchMeanFlow * 0.35;
          resolvedFlowX = column.flowX * (1 - directionWeight) + patchWaveDirectionX * directionWeight;
          resolvedFlowZ = column.flowZ * (1 - directionWeight) + patchWaveDirectionZ * directionWeight;
          resolvedFlowStrength = Math.max(column.flowStrength, patchMeanFlow);
          resolvedTurbulence = Math.max(column.turbulence, patchMeanTurbulence * 0.9);
          shoreFactor = Math.max(shoreFactor, patchShoreInfluence * 0.9);
          if (patchMeanFlow >= this.targetPatchFlowField[clipIndex]) {
            this.targetPatchFlowField[clipIndex] = patchMeanFlow;
            this.targetPatchPhaseField[clipIndex] = patchPhase;
          }
        }
        const interaction = column.interaction;
        const largeBody = column.largeBody;
        resolvedFlowStrength = Math.max(resolvedFlowStrength, largeBody * 0.7);
        resolvedTurbulence = Math.max(resolvedTurbulence, largeBody * 0.18);
        this.targetFillField[clipIndex] = Math.max(this.targetFillField[clipIndex], column.fill);
        this.targetVelocityXField[clipIndex] = resolvedFlowX;
        this.targetVelocityZField[clipIndex] = resolvedFlowZ;
        this.targetFlowField[clipIndex] = Math.max(this.targetFlowField[clipIndex], resolvedFlowStrength);
        this.targetTurbulenceField[clipIndex] = Math.max(this.targetTurbulenceField[clipIndex], resolvedTurbulence);
        this.targetShoreField[clipIndex] = Math.max(this.targetShoreField[clipIndex], shoreFactor);
        this.targetInteractionField[clipIndex] = Math.max(this.targetInteractionField[clipIndex], interaction);
        this.targetLargeBodyField[clipIndex] = Math.max(this.targetLargeBodyField[clipIndex], largeBody);
        this.targetPresenceField[clipIndex] = 1;
      }
      this.stampParticles(section);
    }
    this.stampShallowTargets();
  }

  private stampShallowTargets() {
    for (const section of this.shallowSectionStates.values()) {
      for (let xi = 0; xi < section.sizeX; xi++) {
        for (let zi = 0; zi < section.sizeZ; zi++) {
          const worldX = section.originX + xi;
          const worldZ = section.originZ + zi;
          const idx = this.getClipIndex(worldX, worldZ);
          if (idx < 0) continue;
          const column = readHybridShallowColumn(section, xi, zi);
          if (!column.active || column.thickness <= 0) {
            continue;
          }
          const fill = Math.min(1, column.thickness);
          const speed = Math.sqrt(
            column.spreadVX * column.spreadVX + column.spreadVZ * column.spreadVZ,
          );
          this.targetPresenceField[idx] = Math.max(this.targetPresenceField[idx], fill);
          this.targetFillField[idx] = Math.max(this.targetFillField[idx], fill);
          this.targetFlowField[idx] = Math.max(this.targetFlowField[idx], Math.min(1, speed));
          this.targetVelocityXField[idx] = column.spreadVX;
          this.targetVelocityZField[idx] = column.spreadVZ;
          if (column.shoreDistance <= 1) {
            this.targetShoreField[idx] = Math.max(this.targetShoreField[idx], 0.8);
          }
        }
      }
    }
  }


  private getPatchPhase(seed: number) {
    return fract(Math.abs(seed) * 0.61803398875);
  }

  private createVisualRefinerFields(): HybridVisualRefinerFields {
    return {
      width: this.width,
      height: this.height,
      fillField: this.fillField,
      fillFieldNext: this.fillFieldNext,
      velocityXField: this.velocityXField,
      velocityXFieldNext: this.velocityXFieldNext,
      velocityZField: this.velocityZField,
      velocityZFieldNext: this.velocityZFieldNext,
      foamField: this.foamField,
      foamFieldNext: this.foamFieldNext,
      pressureField: this.pressureField,
      pressureFieldNext: this.pressureFieldNext,
      targetFillField: this.targetFillField,
      targetVelocityXField: this.targetVelocityXField,
      targetVelocityZField: this.targetVelocityZField,
      targetFlowField: this.targetFlowField,
      targetTurbulenceField: this.targetTurbulenceField,
      targetShoreField: this.targetShoreField,
      targetInteractionField: this.targetInteractionField,
      targetPresenceField: this.targetPresenceField,
      particleFoamField: this.particleFoamField,
      visualMassDeltaField: this.visualMassDeltaField,
    };
  }

  private applyVisualRefinerFields(next: HybridVisualRefinerFields) {
    this.fillField = next.fillField as typeof this.fillField;
    this.fillFieldNext = next.fillFieldNext as typeof this.fillFieldNext;
    this.velocityXField = next.velocityXField as typeof this.velocityXField;
    this.velocityXFieldNext = next.velocityXFieldNext as typeof this.velocityXFieldNext;
    this.velocityZField = next.velocityZField as typeof this.velocityZField;
    this.velocityZFieldNext = next.velocityZFieldNext as typeof this.velocityZFieldNext;
    this.foamField = next.foamField as typeof this.foamField;
    this.foamFieldNext = next.foamFieldNext as typeof this.foamFieldNext;
    this.pressureField = next.pressureField as typeof this.pressureField;
    this.pressureFieldNext = next.pressureFieldNext as typeof this.pressureFieldNext;
  }

  private simulateStep(deltaSeconds: number) {
    this.applyVisualRefinerFields(
      refineHybridVisualFields(
        this.createVisualRefinerFields(),
        HYBRID_VISUAL_REFINER_TUNING,
        deltaSeconds,
      ),
    );
  }

  private packTextures(writeDebugTexture = shouldWriteDebugTexture(this.scene)) {
    this.baseStagingTextureData.fill(0);
    this.dynamicStagingTextureData.fill(0);
    this.flowStagingTextureData.fill(0);
    if (writeDebugTexture) {
      this.debugStagingTextureData.fill(0);
    }
    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.height; z++) {
        const index = x * this.height + z;
        const fill = clamp01(this.fillField[index]);
        const foam = clamp01(this.foamField[index]);
        const targetFoam = clamp01(this.targetTurbulenceField[index] * 0.35 + this.targetShoreField[index] * 0.24);
        const velocityX = this.velocityXField[index];
        const velocityZ = this.velocityZField[index];
        const speed = clamp01(Math.sqrt(velocityX * velocityX + velocityZ * velocityZ));
        const leftVelocityZ = this.velocityZField[Math.max(0, x - 1) * this.height + z];
        const rightVelocityZ = this.velocityZField[Math.min(this.width - 1, x + 1) * this.height + z];
        const upVelocityX = this.velocityXField[x * this.height + Math.max(0, z - 1)];
        const downVelocityX = this.velocityXField[x * this.height + Math.min(this.height - 1, z + 1)];
        const curl = Math.abs((rightVelocityZ - leftVelocityZ) - (downVelocityX - upVelocityX));
        const patchFlow = clamp01(this.targetPatchFlowField[index]);
        const patchPhase = this.targetPatchPhaseField[index];
        const largeBody = clamp01(this.targetLargeBodyField[index]);
        const pulse = fract(
          this.elapsedTime * (0.22 + speed * 0.35 + patchFlow * 0.18 + largeBody * 0.08) +
            x * 0.013 +
            z * 0.017 +
            patchPhase * 0.43,
        );
        const stableFoam = clamp01(
          targetFoam + foam * 0.35 + this.targetFlowField[index] * 0.08 + patchFlow * 0.05 + largeBody * 0.02,
        );
        const dynamicFoam = clamp01(
          foam * 0.85 + this.particleFoamField[index] + pulse * FLOW_PULSE_SCALE * (speed + patchFlow * 0.35),
        );
        const dynamicFlow = clamp01(
          speed * 0.62 +
            this.targetFlowField[index] * 0.24 +
            patchFlow * 0.14 +
            this.particleFlowField[index],
        );
        const calmness = clamp01(
          1 - Math.min(1, speed * 0.8 + foam * 0.42 + this.targetTurbulenceField[index] * 0.3) + largeBody * 0.18,
        );
        const interaction = clamp01(this.targetInteractionField[index]);
        const agitation = clamp01(
          curl * 0.25 + foam * 0.28 + this.particleFlowField[index] * 0.4 + interaction * 0.42 + largeBody * 0.08,
        );
        const pressure = clamp01(this.pressureField[index]);
        const encodedVelocityX = clamp01(this.velocityXField[index] / (VELOCITY_LIMIT * 2) + 0.5);
        const encodedVelocityZ = clamp01(this.velocityZField[index] / (VELOCITY_LIMIT * 2) + 0.5);

        const textureIndex = index * 4;
        this.baseStagingTextureData[textureIndex] = Math.round(clamp01(stableFoam + interaction * 0.18) * 255);
        this.baseStagingTextureData[textureIndex + 1] = Math.round(dynamicFlow * 255);
        this.baseStagingTextureData[textureIndex + 2] = Math.round(calmness * 255);
        this.baseStagingTextureData[textureIndex + 3] = Math.round(fill * 255);

        this.dynamicStagingTextureData[textureIndex] = Math.round(clamp01(dynamicFoam + interaction * 0.2) * 255);
        this.dynamicStagingTextureData[textureIndex + 1] = Math.round(clamp01(dynamicFlow + interaction * 0.16) * 255);
        this.dynamicStagingTextureData[textureIndex + 2] = Math.round(agitation * 255);
        this.dynamicStagingTextureData[textureIndex + 3] = Math.round(patchFlow * 255);

        this.flowStagingTextureData[textureIndex] = Math.round(encodedVelocityX * 255);
        this.flowStagingTextureData[textureIndex + 1] = Math.round(encodedVelocityZ * 255);
        this.flowStagingTextureData[textureIndex + 2] = Math.round(clamp01(speed + interaction * 0.12) * 255);
        this.flowStagingTextureData[textureIndex + 3] = Math.round(clamp01(pressure + interaction * 0.12) * 255);

        if (writeDebugTexture) {
          this.debugStagingTextureData[textureIndex] = Math.round(largeBody * 255);
          this.debugStagingTextureData[textureIndex + 1] = Math.round(clamp01(this.targetShoreField[index]) * 255);
          this.debugStagingTextureData[textureIndex + 2] = Math.round(interaction * 255);
          this.debugStagingTextureData[textureIndex + 3] = Math.round(clamp01(this.targetPresenceField[index]) * 255);
        }
      }
    }
    this.baseTextureData.set(this.baseStagingTextureData);
    this.dynamicTextureData.set(this.dynamicStagingTextureData);
    this.flowTextureData.set(this.flowStagingTextureData);
    if (writeDebugTexture) {
      this.debugTextureData.set(this.debugStagingTextureData);
    }
  }

  centerClipOn(cameraX: number, cameraZ: number) {
    const desiredOriginX = Math.floor(cameraX / CLIP_REBUILD_STEP) * CLIP_REBUILD_STEP - HYBRID_CLIP_HALF;
    const desiredOriginZ = Math.floor(cameraZ / CLIP_REBUILD_STEP) * CLIP_REBUILD_STEP - HYBRID_CLIP_HALF;
    if (desiredOriginX === this.clipOriginX && desiredOriginZ === this.clipOriginZ) {
      return false;
    }
    const shiftX = desiredOriginX - this.clipOriginX;
    const shiftZ = desiredOriginZ - this.clipOriginZ;
    this.clipOriginX = desiredOriginX;
    this.clipOriginZ = desiredOriginZ;
    this.frameStats.clipRecentered = true;
    this.shiftSimulationFields(shiftX, shiftZ);
    // Notify the GPU sim so particles are re-seeded in the new clip frame
    this.gpuSim?.onClipMoved(this.clipOriginX, this.clipOriginZ);
    this.noteTargetsDirty("clip-recenter");
    this.runRebuildTargets();
    this.targetsDirty = false;
    this.targetRebuildAccumulator = 0;
    const writeDebugTexture = shouldWriteDebugTexture(this.scene);
    this.packTextures(writeDebugTexture);
    this.uploadTextures(writeDebugTexture);
    return true;
  }

  advance(deltaSeconds: number) {
    if (deltaSeconds <= 0) {
      return;
    }
    if (this.sectionStates.size === 0 && this.shallowSectionStates.size === 0) {
      if (this.targetsDirty) {
        this.clearBridgeFieldsAndUpload();
      }
      return;
    }
    // Skip simulation when settled and no new data injected
    if (!this.targetsDirty) {
      if (isSettledBenchmarkHydrology()) {
        this.frameStats.skippedForSettled = true;
        return;
      }
      // General convergence: if we ran at least one cycle and fields haven't
      // changed, skip the expensive simulate+pack+upload path entirely.
      if (this._converged) {
        this.frameStats.skippedForConverged = true;
        this.frameStats.convergedState = true;
        return;
      }
    }
    this.accumulatedDelta += deltaSeconds;
    this.targetRebuildAccumulator += deltaSeconds;
    let steps = 0;
    while (this.accumulatedDelta >= SIMULATION_STEP && steps < MAX_SIMULATION_STEPS) {
      this.accumulatedDelta -= SIMULATION_STEP;
      this.elapsedTime += SIMULATION_STEP;
      if (this.targetsDirty || this.targetRebuildAccumulator >= TARGET_REBUILD_INTERVAL) {
        this.runRebuildTargets();
        this.targetsDirty = false;
        this.targetRebuildAccumulator = 0;
      }
      this.gpuSim?.flushDisturbances();
      this.runSimulateStep(SIMULATION_STEP);
      this.applyGPUSimContributions();

      // Phase-9: if compute refiner is ready, submit GPU work for this step.
      // CPU simulateStep above keeps the float fields authoritative; GPU provides
      // refined packed textures one frame later.
      if (this.computeRefiner?.ready) {
        this._uploadToComputeRefiner();
        this.computeRefiner.refine(SIMULATION_STEP, this.elapsedTime);
      }

      steps += 1;
    }
    if (steps === 0) {
      return;
    }

    // Convergence detection: check max field delta after simulation
    {
      let maxDelta = 0;
      const n = this.fillField.length;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(this.fillField[i] - this.targetFillField[i]);
        if (d > maxDelta) maxDelta = d;
      }
      if (maxDelta < 0.001) {
        this._stableFrames++;
        if (this._stableFrames >= 10 && !this._converged) {
          this._converged = true;
          this.frameStats.convergedTransitions += 1;
        }
      } else {
        this._stableFrames = 0;
        this._converged = false;
      }
      this.frameStats.convergedState = this._converged;
    }

    const writeDebugTexture = shouldWriteDebugTexture(this.scene);
    const computeRefiner = this.computeRefiner;
    const useGPUComputedPacking = !!(computeRefiner?.ready && computeRefiner.packedDataReady);
    if (!useGPUComputedPacking) {
      this.packTextures(writeDebugTexture);
    }

    // Phase-9: override packed textures with GPU compute output when available.
    if (useGPUComputedPacking) {
      this.baseTextureData.set(computeRefiner!.packedBase);
      this.dynamicTextureData.set(computeRefiner!.packedDynamic);
      this.flowTextureData.set(computeRefiner!.packedFlow);
      if (writeDebugTexture) {
        this.debugTextureData.set(computeRefiner!.packedDebug);
      }
    }

    this.uploadTextures(writeDebugTexture);
  }

  private clearBridgeFieldsAndUpload() {
    this.accumulatedDelta = 0;
    this.targetRebuildAccumulator = 0;
    this.fillField.fill(0);
    this.fillFieldNext.fill(0);
    this.velocityXField.fill(0);
    this.velocityXFieldNext.fill(0);
    this.velocityZField.fill(0);
    this.velocityZFieldNext.fill(0);
    this.foamField.fill(0);
    this.foamFieldNext.fill(0);
    this.targetFillField.fill(0);
    this.targetVelocityXField.fill(0);
    this.targetVelocityZField.fill(0);
    this.targetFlowField.fill(0);
    this.targetTurbulenceField.fill(0);
    this.targetShoreField.fill(0);
    this.targetInteractionField.fill(0);
    this.targetLargeBodyField.fill(0);
    this.targetPatchFlowField.fill(0);
    this.targetPatchPhaseField.fill(0);
    this.targetPresenceField.fill(0);
    this.particleFoamField.fill(0);
    this.particleFlowField.fill(0);
    this.pressureField.fill(0);
    this.pressureFieldNext.fill(0);
    this.visualMassDeltaField.fill(0);
    const writeDebugTexture = shouldWriteDebugTexture(this.scene);
    this.packTextures(writeDebugTexture);
    this.uploadTextures(writeDebugTexture);
    this.targetsDirty = false;
    this._converged = false;
    this._stableFrames = 0;
    this.frameStats.targetsDirty = false;
    this.frameStats.convergedState = false;
  }

  private clearLiveFieldsForSection(originX: number, originZ: number, sizeX: number, sizeZ: number) {
    for (let x = 0; x < sizeX; x++) {
      for (let z = 0; z < sizeZ; z++) {
        const clipIndex = this.getClipIndex(originX + x, originZ + z);
        if (clipIndex < 0) continue;
        this.fillField[clipIndex] = 0;
        this.fillFieldNext[clipIndex] = 0;
        this.velocityXField[clipIndex] = 0;
        this.velocityXFieldNext[clipIndex] = 0;
        this.velocityZField[clipIndex] = 0;
        this.velocityZFieldNext[clipIndex] = 0;
        this.foamField[clipIndex] = 0;
        this.foamFieldNext[clipIndex] = 0;
        this.pressureField[clipIndex] = 0;
        this.pressureFieldNext[clipIndex] = 0;
        this.visualMassDeltaField[clipIndex] = 0;
      }
    }
  }

  /**
  * Blend local fluid particle contributions into the velocity and foam fields
  * after each CPU simulation step. The solver runs asynchronously; its output
   * fields are updated continuously and read here whenever they have valid data.
   * Areas without particle coverage are left unchanged (CPU path keeps ownership).
   */
  /**
   * Phase-9: Upload all target fields and current simulation state to the
   * DVEWaterComputeRefiner GPU buffers, ready for the next refine() dispatch.
   * Must be called AFTER rebuildTargets() and simulateStep() for this step.
   */
  private _uploadToComputeRefiner(): void {
    const r = this.computeRefiner!;
    r.uploadTargets(
      this.targetFillField,
      this.targetVelocityXField,
      this.targetVelocityZField,
      this.targetFlowField,
      this.targetTurbulenceField,
      this.targetShoreField,
      this.targetInteractionField,
      this.targetLargeBodyField,
      this.targetPatchFlowField,
      this.targetPatchPhaseField,
      this.targetPresenceField,
      this.particleFoamField,
      this.particleFlowField,
    );
    r.uploadSimState(
      this.fillField,
      this.velocityXField,
      this.velocityZField,
      this.foamField,
      this.pressureField,
    );
  }

  private applyGPUSimContributions(): void {
    if (!this.gpuSim?.ready || !this.gpuSim.hasFreshContributions) {
      return;
    }
    const sim = this.gpuSim;
    const n = this.width * this.height;
    for (let i = 0; i < n; i++) {
      const gpuFill = sim.fillContribField[i];
      if (gpuFill < 0.04) {
        continue;
      }
      // Blend factor: stronger where particle density is high, fades at sparse edges
      const blend = Math.min(1.0, gpuFill * 1.5);
      const invBlend = 1.0 - blend;
      // GPU-derived velocity replaces CPU velocity in proportion to particle coverage
      this.velocityXField[i] = this.velocityXField[i] * invBlend + sim.velocityXField[i] * blend;
      this.velocityZField[i] = this.velocityZField[i] * invBlend + sim.velocityZField[i] * blend;
      // GPU foam contribution is additive (particle splashing augments shore/turbulence foam)
      this.foamField[i] = Math.min(1.0, Math.max(this.foamField[i], sim.foamContribField[i] * blend));
    }
  }

  beginShallowInjectionFrame() {
    this.shallowSectionsSeenThisFrame.clear();
  }

  finishShallowInjectionFrame() {
    let removed = false;
    let removedCount = 0;
    for (const key of Array.from(this.shallowSectionStates.keys())) {
      if (this.shallowSectionsSeenThisFrame.has(key)) continue;
      const section = this.shallowSectionStates.get(key);
      this.shallowSectionStates.delete(key);
      if (section) {
        this.clearLiveFieldsForSection(section.originX, section.originZ, section.sizeX, section.sizeZ);
      }
      removed = true;
      removedCount += 1;
    }
    this.shallowSectionsSeenThisFrame.clear();
    if (!removed) return;
    this.frameStats.shallowRemovedSections += removedCount;
    this.noteTargetsDirty("shallow-frame-prune");
  }

  clearInjectedShallowSection(originX: number, originZ: number) {
    const key = `${originX}:${originZ}`;
    const section = this.shallowSectionStates.get(key);
    if (!this.shallowSectionStates.delete(key)) return;
    this.shallowSectionsSeenThisFrame.delete(key);
    if (section) {
      this.clearLiveFieldsForSection(section.originX, section.originZ, section.sizeX, section.sizeZ);
    }
    this.frameStats.shallowRemovedSections += 1;
    this.noteTargetsDirty("shallow-section-clear");
  }

  retainInjectedShallowSection(originX: number, originZ: number) {
    const key = `${originX}:${originZ}`;
    if (!this.shallowSectionStates.has(key)) {
      return false;
    }
    this.shallowSectionsSeenThisFrame.add(key);
    this.frameStats.shallowRetainedSections += 1;
    return true;
  }

  /**
   * Inject shallow water simulation data from the editor shallow renderer into
   * the bridge target fields so that the hybrid water PBR shader becomes aware
   * of shallow water presence, flow velocity, and shore proximity.  Called once
   * per frame per active shallow section before advance().
   */
  injectShallowSection(
    originX: number,
    originZ: number,
    sizeX: number,
    sizeZ: number,
    columnBuffer: Float32Array,
    columnStride: number,
    columnMetadata: Uint32Array,
  ) {
    const key = `${originX}:${originZ}`;
    this.shallowSectionsSeenThisFrame.add(key);
    this.shallowSectionStates.set(key, {
      key,
      originX,
      originZ,
      sizeX,
      sizeZ,
      columnBuffer,
      columnStride,
      columnMetadata,
    });
    this.frameStats.shallowInjectedSections += 1;
    this.noteTargetsDirty("shallow-section-inject");
  }

  updateFromSectionGPUData(
    gpuData: WaterSectionGPUData,
    width: number,
    height: number,
    paddedBoundsX: number,
    paddedBoundsZ: number,
    originX: number,
    originZ: number,
  ) {
    if (width <= 0 || height <= 0) {
      return;
    }
    const sectionKey = `${originX}:${originZ}:${width}:${height}`;
    let removedVariant = false;
    for (const [key, section] of Array.from(this.sectionStates.entries())) {
      if (section.originX !== originX || section.originZ !== originZ || key === sectionKey) {
        continue;
      }
      this.sectionStates.delete(key);
      removedVariant = true;
    }
    // Register the section with the GPU sim so particles can be seeded from it
    if (this.gpuSim) {
      this.gpuSim.registerSection({
        originX,
        originZ,
        boundsX: width,
        boundsZ: height,
        particleSeedBuffer: gpuData.particleSeedBuffer,
        particleSeedStride: gpuData.particleSeedStride,
        particleSeedCount: gpuData.particleSeedCount,
        interactionField: gpuData.interactionField,
        interactionFieldSize: gpuData.interactionFieldSize,
      });
    }
    this.sectionStates.set(sectionKey, {
      key: sectionKey,
      originX,
      originZ,
      boundsX: width,
      boundsZ: height,
      paddedBoundsX,
      paddedBoundsZ,
      gpuData,
    });
    this.noteTargetsDirty("continuous-section-update");
  }

  removeSection(originX: number, originZ: number) {
    let removed = false;
    for (const [key, section] of Array.from(this.sectionStates.entries())) {
      if (section.originX !== originX || section.originZ !== originZ) continue;
      this.sectionStates.delete(key);
      this.clearLiveFieldsForSection(section.originX, section.originZ, section.boundsX, section.boundsZ);
      removed = true;
    }
    this.gpuSim?.removeSection(originX, originZ);
    if (!removed) return;
    this.noteTargetsDirty("continuous-section-remove");
  }

  /** Sprint 10: Optional callback injected by shallow water system to receive puddle spawn requests */
  onPuddleSpawn: ((worldX: number, worldZ: number, terrainY: number, thickness: number) => void) | null = null;

  /** Inject a puddle spawn into the shallow water layer */
  injectPuddleSpawn(worldX: number, worldZ: number, terrainY: number, initialThickness: number): void {
    this.onPuddleSpawn?.(worldX, worldZ, terrainY, initialThickness);
  }

  dispose() {
    this.onPuddleSpawn = null;
    this.gpuSim?.dispose();
    this.gpuSim = null;
    this.computeRefiner?.dispose();
    this.computeRefiner = null;
    this.baseTexture.dispose();
    this.dynamicTexture.dispose();
    this.flowTexture.dispose();
    this.debugTexture.dispose();
    bridgeCache.delete(this.scene);
  }
}

export function getSceneWaterHybridBridge(scene: Scene) {
  const cached = bridgeCache.get(scene);
  if (cached) {
    return cached;
  }
  const bridge = new DVEWaterHybridBridge(scene);
  bridgeCache.set(scene, bridge);
  return bridge;
}