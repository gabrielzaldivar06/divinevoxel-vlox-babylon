import type { Scene } from "@babylonjs/core/scene";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { WaterSectionGPUData } from "@divinevoxel/vlox/Water/Types/WaterTypes.js";
import { DVEWaterLocalFluidSystem } from "./GPU/DVEWaterLocalFluidSystem.js";
import { DVEWaterComputeRefiner } from "./GPU/DVEWaterComputeRefiner.js";

const DEFAULT_PIXEL = new Uint8Array([128, 32, 192, 255]);
const UNKNOWN_SHORE_DISTANCE = 0xff;
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
const FOAM_DECAY = 0.94;
const EDGE_DECAY = 0.9;
const MASS_TRANSFER_RATE = 4.2;
const MASS_RETENTION = 0.985;
const MOMENTUM_RESPONSE = 0.28;
const VELOCITY_LIMIT = 1.35;
const INTERACTION_TO_FLOW = 0.22;
const INTERACTION_TO_FOAM = 0.3;
const INTERACTION_TO_PRESSURE = 0.2;
const PATCH_SUMMARY_MEAN_FLOW_INDEX = 6;
const PATCH_SUMMARY_MEAN_TURBULENCE_INDEX = 7;
const PATCH_SUMMARY_WAVE_DIRECTION_X_INDEX = 8;
const PATCH_SUMMARY_WAVE_DIRECTION_Z_INDEX = 9;
const PATCH_SUMMARY_SHORE_INFLUENCE_INDEX = 10;
const PATCH_SUMMARY_ANTI_PERIODICITY_SEED_INDEX = 11;

function isSettledBenchmarkHydrology() {
  const benchmark = (globalThis as any).__DVE_TERRAIN_BENCHMARK__;
  return benchmark?.hydrologySettled === true;
}

interface CachedWaterSectionState {
  key: string;
  originX: number;
  originZ: number;
  boundsX: number;
  boundsZ: number;
  paddedBoundsX: number;
  paddedBoundsZ: number;
  gpuData: WaterSectionGPUData;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function decodeShoreDistance(metadata: number) {
  const shoreDistance = (metadata >>> 16) & 0xff;
  return shoreDistance === UNKNOWN_SHORE_DISTANCE ? -1 : shoreDistance;
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
  private massDeltaField = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private shiftFieldScratch = new Float32Array(HYBRID_TEXTURE_SIZE * HYBRID_TEXTURE_SIZE);
  private sectionStates = new Map<string, CachedWaterSectionState>();
  private targetsDirty = false;
  baseTexture: RawTexture;
  dynamicTexture: RawTexture;
  flowTexture: RawTexture;
  debugTexture: RawTexture;
  width = HYBRID_TEXTURE_SIZE;
  height = HYBRID_TEXTURE_SIZE;
  /** Local fluid simulation backend selected by explicit solver gate. */
  private gpuSim: DVEWaterLocalFluidSystem | null = null;
  /** Phase-9 GPU compute refiner: replaces simulateStep + packTextures with WebGPU compute. */
  private computeRefiner: DVEWaterComputeRefiner | null = null;
  private elapsedTime = 0;
  private accumulatedDelta = 0;
  private targetRebuildAccumulator = 0;
  private clipOriginX = -HYBRID_CLIP_HALF;
  private clipOriginZ = -HYBRID_CLIP_HALF;

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
    this.massDeltaField.fill(0);
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
    this.massDeltaField.fill(0);
    this.baseTextureData.set(DEFAULT_PIXEL, 0);
    this.dynamicTextureData.set(DEFAULT_PIXEL, 0);
    this.flowTextureData.set(DEFAULT_PIXEL, 0);
    this.baseTexture.update(this.baseTextureData);
    this.dynamicTexture.update(this.dynamicTextureData);
    this.flowTexture.update(this.flowTextureData);
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

  private clampVelocity(value: number) {
    return Math.max(-VELOCITY_LIMIT, Math.min(VELOCITY_LIMIT, value));
  }

  private applyPairTransfer(
    fromIndex: number,
    toIndex: number,
    signedDrive: number,
    availableFrom: number,
    availableTo: number,
    deltaSeconds: number,
  ) {
    const proposedTransfer = signedDrive * MASS_TRANSFER_RATE * deltaSeconds;
    if (proposedTransfer > 0) {
      const transfer = Math.min(proposedTransfer, availableFrom * 0.5);
      this.massDeltaField[fromIndex] -= transfer;
      this.massDeltaField[toIndex] += transfer;
      return;
    }
    if (proposedTransfer < 0) {
      const transfer = Math.min(-proposedTransfer, availableTo * 0.5);
      this.massDeltaField[fromIndex] += transfer;
      this.massDeltaField[toIndex] -= transfer;
    }
  }

  private isInClipBounds(x: number, z: number) {
    return (
      x >= this.clipOriginX &&
      x < this.clipOriginX + this.width &&
      z >= this.clipOriginZ &&
      z < this.clipOriginZ + this.height
    );
  }

  private stampParticles(section: CachedWaterSectionState) {
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

  private getPaddedIndex(section: CachedWaterSectionState, localX: number, localZ: number) {
    const paddedRadiusX = Math.max(0, Math.floor((section.paddedBoundsX - section.boundsX) * 0.5));
    const paddedRadiusZ = Math.max(0, Math.floor((section.paddedBoundsZ - section.boundsZ) * 0.5));
    return (localX + paddedRadiusX) * section.paddedBoundsZ + (localZ + paddedRadiusZ);
  }

  private sampleContinuity(section: CachedWaterSectionState, localX: number, localZ: number) {
    const stride = section.gpuData.paddedColumnStride;
    let fill = 0;
    let flowX = 0;
    let flowZ = 0;
    let flowStrength = 0;
    let turbulence = 0;
    let shoreFactor = 0;
    let samples = 0;

    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
        const paddedX = localX + offsetX;
        const paddedZ = localZ + offsetZ;
        const paddedIndex = this.getPaddedIndex(section, paddedX, paddedZ);
        if (paddedIndex < 0 || paddedIndex >= section.gpuData.paddedColumnMetadata.length) continue;
        const metadata = section.gpuData.paddedColumnMetadata[paddedIndex] ?? 0;
        const filled = (metadata & 0x1) === 1;
        if (!filled) continue;

        const dataIndex = paddedIndex * stride;
        fill += clamp01(section.gpuData.paddedColumnBuffer[dataIndex + 2] ?? 0);
        flowX += section.gpuData.paddedColumnBuffer[dataIndex + 3] ?? 0;
        flowZ += section.gpuData.paddedColumnBuffer[dataIndex + 4] ?? 0;
        flowStrength += clamp01(section.gpuData.paddedColumnBuffer[dataIndex + 5] ?? 0);
        turbulence += clamp01(section.gpuData.paddedColumnBuffer[dataIndex + 7] ?? 0);
        const shoreDistance = decodeShoreDistance(metadata);
        shoreFactor += shoreDistance < 0 ? 1 : clamp01(1 - Math.min(shoreDistance, 8) / 8);
        samples += 1;
      }
    }

    if (samples === 0) {
      return null;
    }

    return {
      fill: fill / samples,
      flowX: flowX / samples,
      flowZ: flowZ / samples,
      flowStrength: flowStrength / samples,
      turbulence: turbulence / samples,
      shoreFactor: shoreFactor / samples,
    };
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
        const metadata = section.gpuData.columnMetadata[index] ?? 0;
        const filled = (metadata & 0x1) === 1;
        if (!filled) continue;

        const continuity = this.sampleContinuity(section, localX, localZ);
        const fill = continuity?.fill ?? clamp01(section.gpuData.columnBuffer[dataIndex + 2] ?? 0);
        const flowX = continuity?.flowX ?? section.gpuData.columnBuffer[dataIndex + 3] ?? 0;
        const flowZ = continuity?.flowZ ?? section.gpuData.columnBuffer[dataIndex + 4] ?? 0;
        const flowStrength = continuity?.flowStrength ?? clamp01(section.gpuData.columnBuffer[dataIndex + 5] ?? 0);
        const turbulence = continuity?.turbulence ?? clamp01(section.gpuData.columnBuffer[dataIndex + 7] ?? 0);
        const shoreDistance = decodeShoreDistance(metadata);
        let resolvedFlowX = flowX;
        let resolvedFlowZ = flowZ;
        let resolvedFlowStrength = flowStrength;
        let resolvedTurbulence = turbulence;
        let shoreFactor = continuity?.shoreFactor ?? (shoreDistance < 0 ? 1 : clamp01(1 - Math.min(shoreDistance, 8) / 8));
        const patchSummaryIndex = this.getColumnPatchSummaryIndex(section, index);
        if (patchSummaryIndex >= 0) {
          const patchStride = section.gpuData.patchSummaryStride;
          const patchBaseIndex = patchSummaryIndex * patchStride;
          const patchSummary = section.gpuData.patchSummaryBuffer;
          const patchMeanFlow = clamp01(patchSummary[patchBaseIndex + PATCH_SUMMARY_MEAN_FLOW_INDEX] ?? 0);
          const patchMeanTurbulence = clamp01(
            patchSummary[patchBaseIndex + PATCH_SUMMARY_MEAN_TURBULENCE_INDEX] ?? 0,
          );
          const patchWaveDirectionX = patchSummary[patchBaseIndex + PATCH_SUMMARY_WAVE_DIRECTION_X_INDEX] ?? 0;
          const patchWaveDirectionZ = patchSummary[patchBaseIndex + PATCH_SUMMARY_WAVE_DIRECTION_Z_INDEX] ?? 0;
          const patchShoreInfluence = clamp01(
            patchSummary[patchBaseIndex + PATCH_SUMMARY_SHORE_INFLUENCE_INDEX] ?? 0,
          );
          const patchPhase = this.getPatchPhase(
            patchSummary[patchBaseIndex + PATCH_SUMMARY_ANTI_PERIODICITY_SEED_INDEX] ?? 0,
          );
          const directionWeight = 0.25 + patchMeanFlow * 0.35;
          resolvedFlowX = flowX * (1 - directionWeight) + patchWaveDirectionX * directionWeight;
          resolvedFlowZ = flowZ * (1 - directionWeight) + patchWaveDirectionZ * directionWeight;
          resolvedFlowStrength = Math.max(flowStrength, patchMeanFlow);
          resolvedTurbulence = Math.max(turbulence, patchMeanTurbulence * 0.9);
          shoreFactor = Math.max(shoreFactor, patchShoreInfluence * 0.9);
          if (patchMeanFlow >= this.targetPatchFlowField[clipIndex]) {
            this.targetPatchFlowField[clipIndex] = patchMeanFlow;
            this.targetPatchPhaseField[clipIndex] = patchPhase;
          }
        }
        const interaction = this.sampleSectionInteractionField(section, localX, localZ);
        const largeBody = this.sampleSectionLargeBodyField(section, localX, localZ);
        resolvedFlowStrength = Math.max(resolvedFlowStrength, largeBody * 0.7);
        resolvedTurbulence = Math.max(resolvedTurbulence, largeBody * 0.18);
        this.targetFillField[clipIndex] = Math.max(this.targetFillField[clipIndex], fill);
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
  }

  private sampleScalarField(field: Float32Array, x: number, z: number) {
    const clampedX = Math.max(0, Math.min(this.width - 1, x));
    const clampedZ = Math.max(0, Math.min(this.height - 1, z));
    const x0 = Math.floor(clampedX);
    const z0 = Math.floor(clampedZ);
    const x1 = Math.min(this.width - 1, x0 + 1);
    const z1 = Math.min(this.height - 1, z0 + 1);
    const tx = clampedX - x0;
    const tz = clampedZ - z0;
    const a = field[x0 * this.height + z0];
    const b = field[x1 * this.height + z0];
    const c = field[x0 * this.height + z1];
    const d = field[x1 * this.height + z1];
    const ab = a + (b - a) * tx;
    const cd = c + (d - c) * tx;
    return ab + (cd - ab) * tz;
  }

  private sampleSectionInteractionField(section: CachedWaterSectionState, localX: number, localZ: number) {
    const field = section.gpuData.interactionField;
    const size = section.gpuData.interactionFieldSize;
    if (!field || field.length === 0 || size <= 0) {
      return 0;
    }
    const fx = clamp01((localX + 0.5) / Math.max(section.boundsX, 1)) * (size - 1);
    const fz = clamp01((localZ + 0.5) / Math.max(section.boundsZ, 1)) * (size - 1);
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const x1 = Math.min(size - 1, x0 + 1);
    const z1 = Math.min(size - 1, z0 + 1);
    const tx = fx - x0;
    const tz = fz - z0;
    const v00 = field[x0 * size + z0] ?? 0;
    const v10 = field[x1 * size + z0] ?? 0;
    const v01 = field[x0 * size + z1] ?? 0;
    const v11 = field[x1 * size + z1] ?? 0;
    const north = v00 + (v10 - v00) * tx;
    const south = v01 + (v11 - v01) * tx;
    return clamp01(north + (south - north) * tz);
  }

  private sampleSectionLargeBodyField(section: CachedWaterSectionState, localX: number, localZ: number) {
    const field = section.gpuData.largeBodyField;
    const size = section.gpuData.largeBodyFieldSize;
    if (!field || field.length === 0 || size <= 0) {
      return 0;
    }
    const fx = clamp01((localX + 0.5) / Math.max(section.boundsX, 1)) * (size - 1);
    const fz = clamp01((localZ + 0.5) / Math.max(section.boundsZ, 1)) * (size - 1);
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const x1 = Math.min(size - 1, x0 + 1);
    const z1 = Math.min(size - 1, z0 + 1);
    const tx = fx - x0;
    const tz = fz - z0;
    const v00 = field[x0 * size + z0] ?? 0;
    const v10 = field[x1 * size + z0] ?? 0;
    const v01 = field[x0 * size + z1] ?? 0;
    const v11 = field[x1 * size + z1] ?? 0;
    const north = v00 + (v10 - v00) * tx;
    const south = v01 + (v11 - v01) * tx;
    return clamp01(north + (south - north) * tz);
  }

  private getColumnPatchSummaryIndex(section: CachedWaterSectionState, columnIndex: number) {
    const lookup = section.gpuData.columnPatchIndex[columnIndex] ?? 0;
    if (lookup <= 0) {
      return -1;
    }
    const patchIndex = lookup - 1;
    return patchIndex >= 0 && patchIndex < section.gpuData.patchSummaryCount ? patchIndex : -1;
  }

  private getPatchPhase(seed: number) {
    return fract(Math.abs(seed) * 0.61803398875);
  }

  private simulateStep(deltaSeconds: number) {
    this.massDeltaField.fill(0);

    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.height; z++) {
        const index = x * this.height + z;
        const currentFill = this.fillField[index];
        const currentVelocityX = this.velocityXField[index];
        const currentVelocityZ = this.velocityZField[index];
        const targetVelocityX = this.targetVelocityXField[index] * this.targetFlowField[index];
        const targetVelocityZ = this.targetVelocityZField[index] * this.targetFlowField[index];

        if (x + 1 < this.width) {
          const rightIndex = (x + 1) * this.height + z;
          const rightFill = this.fillField[rightIndex];
          const rightTargetVelocityX = this.targetVelocityXField[rightIndex] * this.targetFlowField[rightIndex];
          const pairVelocity = (currentVelocityX + this.velocityXField[rightIndex]) * 0.5;
          const pairTargetVelocity = (targetVelocityX + rightTargetVelocityX) * 0.5;
          const signedDrive =
            (currentFill - rightFill) * 0.55 +
            pairVelocity * 0.34 +
            pairTargetVelocity * MOMENTUM_RESPONSE;
          this.applyPairTransfer(index, rightIndex, signedDrive, currentFill, rightFill, deltaSeconds);
        }

        if (z + 1 < this.height) {
          const downIndex = x * this.height + (z + 1);
          const downFill = this.fillField[downIndex];
          const downTargetVelocityZ = this.targetVelocityZField[downIndex] * this.targetFlowField[downIndex];
          const pairVelocity = (currentVelocityZ + this.velocityZField[downIndex]) * 0.5;
          const pairTargetVelocity = (targetVelocityZ + downTargetVelocityZ) * 0.5;
          const signedDrive =
            (currentFill - downFill) * 0.55 +
            pairVelocity * 0.34 +
            pairTargetVelocity * MOMENTUM_RESPONSE;
          this.applyPairTransfer(index, downIndex, signedDrive, currentFill, downFill, deltaSeconds);
        }
      }
    }

    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.height; z++) {
        const index = x * this.height + z;
        const currentFill = this.fillField[index];
        const targetPresence = this.targetPresenceField[index];
        const targetFill = this.targetFillField[index];
        const currentVelocityX = this.velocityXField[index];
        const currentVelocityZ = this.velocityZField[index];
        const sampleX = x - currentVelocityX * VELOCITY_ADVECTION * deltaSeconds;
        const sampleZ = z - currentVelocityZ * VELOCITY_ADVECTION * deltaSeconds;
        const advectedFill = this.sampleScalarField(this.fillField, sampleX, sampleZ);
        const advectedFoam = this.sampleScalarField(this.foamField, sampleX, sampleZ);

        const leftFill = this.fillField[Math.max(0, x - 1) * this.height + z];
        const rightFill = this.fillField[Math.min(this.width - 1, x + 1) * this.height + z];
        const upFill = this.fillField[x * this.height + Math.max(0, z - 1)];
        const downFill = this.fillField[x * this.height + Math.min(this.height - 1, z + 1)];
        const neighborAverage = (leftFill + rightFill + upFill + downFill) * 0.25;
        const netMass = this.massDeltaField[index];
        const pressure = (neighborAverage - advectedFill + netMass * 2.2) * PRESSURE_RESPONSE;
        const targetVelocityX = this.targetVelocityXField[index] * this.targetFlowField[index];
        const targetVelocityZ = this.targetVelocityZField[index] * this.targetFlowField[index];
        const interaction = this.targetInteractionField[index];
        const gradientX = (leftFill - rightFill) * 0.5;
        const gradientZ = (upFill - downFill) * 0.5;
        const shoreDamping = 1 - this.targetShoreField[index] * 0.24;
        const presenceMix = targetPresence > 0 ? TARGET_PULL : 0.03;
        let nextVelocityX = currentVelocityX * VELOCITY_DAMPING + targetVelocityX * presenceMix + gradientX * 0.2;
        let nextVelocityZ = currentVelocityZ * VELOCITY_DAMPING + targetVelocityZ * presenceMix + gradientZ * 0.2;
        nextVelocityX += pressure * Math.sign(gradientX || targetVelocityX || 1) * 0.08;
        nextVelocityZ += pressure * Math.sign(gradientZ || targetVelocityZ || 1) * 0.08;
        nextVelocityX += netMass * 0.9;
        nextVelocityZ += netMass * 0.9;
        nextVelocityX += targetVelocityX * interaction * INTERACTION_TO_FLOW;
        nextVelocityZ += targetVelocityZ * interaction * INTERACTION_TO_FLOW;
        nextVelocityX *= shoreDamping;
        nextVelocityZ *= shoreDamping;
        nextVelocityX = this.clampVelocity(nextVelocityX);
        nextVelocityZ = this.clampVelocity(nextVelocityZ);

        const fillRelaxation = targetPresence > 0 ? FILL_RELAXATION : 0.08;
        let nextFill = (
          advectedFill * (1 - fillRelaxation) +
          neighborAverage * 0.12 +
          targetFill * fillRelaxation +
          currentFill * MASS_RETENTION +
          netMass +
          pressure
        ) * 0.5;
        if (targetPresence <= 0) {
          nextFill *= EDGE_DECAY;
        }
        nextFill = clamp01(nextFill);

        const speed = Math.sqrt(nextVelocityX * nextVelocityX + nextVelocityZ * nextVelocityZ);
        const foamSource =
          this.targetTurbulenceField[index] * 0.24 +
          this.targetShoreField[index] * 0.18 +
          speed * 0.12 +
          interaction * INTERACTION_TO_FOAM +
          Math.abs(pressure) * 0.9 +
          this.particleFoamField[index] * 0.9;
        const nextFoam = clamp01(Math.max(advectedFoam * FOAM_DECAY, foamSource));

        this.fillFieldNext[index] = nextFill;
        this.velocityXFieldNext[index] = nextVelocityX;
        this.velocityZFieldNext[index] = nextVelocityZ;
        this.foamFieldNext[index] = nextFoam;
        this.pressureFieldNext[index] = clamp01(Math.abs(pressure) * 2.6 + Math.abs(netMass) * 3.1 + interaction * INTERACTION_TO_PRESSURE);
      }
    }

    [this.fillField, this.fillFieldNext] = [this.fillFieldNext, this.fillField];
    [this.velocityXField, this.velocityXFieldNext] = [this.velocityXFieldNext, this.velocityXField];
    [this.velocityZField, this.velocityZFieldNext] = [this.velocityZFieldNext, this.velocityZField];
    [this.foamField, this.foamFieldNext] = [this.foamFieldNext, this.foamField];
    [this.pressureField, this.pressureFieldNext] = [this.pressureFieldNext, this.pressureField];
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
    this.shiftSimulationFields(shiftX, shiftZ);
    // Notify the GPU sim so particles are re-seeded in the new clip frame
    this.gpuSim?.onClipMoved(this.clipOriginX, this.clipOriginZ);
    this.targetsDirty = true;
    this.rebuildTargets();
    this.targetsDirty = false;
    this.targetRebuildAccumulator = 0;
    const writeDebugTexture = shouldWriteDebugTexture(this.scene);
    this.packTextures(writeDebugTexture);
    this.baseTexture.update(this.baseTextureData);
    this.dynamicTexture.update(this.dynamicTextureData);
    this.flowTexture.update(this.flowTextureData);
    if (writeDebugTexture) {
      this.debugTexture.update(this.debugTextureData);
    }
    return true;
  }

  advance(deltaSeconds: number) {
    if (deltaSeconds <= 0 || this.sectionStates.size === 0) {
      return;
    }
    if (isSettledBenchmarkHydrology() && !this.targetsDirty) {
      return;
    }
    this.accumulatedDelta += deltaSeconds;
    this.targetRebuildAccumulator += deltaSeconds;
    let steps = 0;
    while (this.accumulatedDelta >= SIMULATION_STEP && steps < MAX_SIMULATION_STEPS) {
      this.accumulatedDelta -= SIMULATION_STEP;
      this.elapsedTime += SIMULATION_STEP;
      if (this.targetsDirty || this.targetRebuildAccumulator >= TARGET_REBUILD_INTERVAL) {
        this.rebuildTargets();
        this.targetsDirty = false;
        this.targetRebuildAccumulator = 0;
      }
      this.simulateStep(SIMULATION_STEP);
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

    this.baseTexture.update(this.baseTextureData);
    this.dynamicTexture.update(this.dynamicTextureData);
    this.flowTexture.update(this.flowTextureData);
    if (writeDebugTexture) {
      this.debugTexture.update(this.debugTextureData);
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
    if (!this.gpuSim?.ready) {
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
    const sectionKey = `${originX}:${originZ}:${width}:${height}`;
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
    this.targetsDirty = true;
    this.accumulatedDelta = Math.max(this.accumulatedDelta, SIMULATION_STEP);
  }

  dispose() {
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