/**
 * DVEWaterGPUSimulation — Orchestrates the GPU MLS-MPM water simulation for DVE.
 *
 * Responsibilities:
 *  1. Acquire a WebGPU GPUDevice via navigator.gpu (independent of Babylon.js).
 *  2. Seed the DVEWaterMLSMPMSimulator from DVE water section data each time the
 *     clip moves or sections change.
 *  3. Run simulation substeps every advance() call via a persistent async loop.
 *  4. Scatter readback particle positions/velocities into Float32Array fields that
 *     DVEWaterHybridBridge can consume in place of the CPU simulateStep() output.
 *
 * Coordinate system mapping:
 *   The simulator's 64×8×64 grid maps to the bridge's 256×256 clip region:
 *     simX = (worldX - clipOriginX) * WORLD_TO_SIM + SIM_MARGIN
 *     simZ = (worldZ - clipOriginZ) * WORLD_TO_SIM + SIM_MARGIN
 *     simY = SIM_Y_SURFACE  (particles float near the bottom under gravity)
 *
 *   where WORLD_TO_SIM = (SIM_CELLS_USEFUL / CLIP_SIZE) = 60 / 256 ≈ 0.234
 *         SIM_MARGIN   = 2  (keep particles away from hard grid boundaries)
 *         SIM_CELLS_USEFUL = SIM_X - 2 * SIM_MARGIN = 60
 *         CLIP_SIZE    = 256
 */

import {
  DVEWaterMLSMPMSimulator,
  POSVEL_STRUCT_SIZE,
  type MLSMPMSeedParticle,
} from "./DVEWaterMLSMPMSimulator.js";
import type {
  WaterLocalFluidBackend,
  WaterLocalFluidSectionRecord,
} from "./DVEWaterLocalFluidTypes.js";

// Domain constants
const SIM_MARGIN = 2;
const CLIP_SIZE = 256;
const SIM_CELLS_USEFUL = DVEWaterMLSMPMSimulator.SIM_X - 2 * SIM_MARGIN; // 60
const WORLD_TO_SIM = SIM_CELLS_USEFUL / CLIP_SIZE; // ≈ 0.234
const SIM_TO_WORLD = CLIP_SIZE / SIM_CELLS_USEFUL;
const SIM_Y_SURFACE = 4.0; // particles start at mid-height; gravity pulls them down

// How many world cells one sim cell covers in XZ
const SIM_XZ_WORLD_FOOTPRINT = SIM_TO_WORLD; // ~4.27 world cells per sim cell

// Output field resolution matches the bridge's 256×256 clip
const FIELD_SIZE = CLIP_SIZE;

export interface GPUSimSectionRecord {
  originX: number;
  originZ: number;
  boundsX: number;
  boundsZ: number;
  /** particleSeedBuffer from WaterSectionGPUData — [x, y, z, vx, vy, vz, radius, kind] × count */
  particleSeedBuffer: Float32Array;
  particleSeedStride: number;
  particleSeedCount: number;
  interactionField?: Float32Array;
  interactionFieldSize?: number;
}

const MAX_INTERACTION_SEED_PARTICLES = 4096;
const INTERACTION_SEED_THRESHOLD = 0.18;
const INTERACTION_SEED_VELOCITY = 0.85;

export class DVEWaterGPUSimulation implements WaterLocalFluidBackend {
  private device: GPUDevice | null = null;
  private simulator: DVEWaterMLSMPMSimulator | null = null;

  /** True after init() has secured a GPUDevice and built all pipelines. */
  ready = false;

  /**
   * Output scatter fields — 256×256 arrays indexed [x * FIELD_SIZE + z].
   * These are written by the async readback loop and read by the bridge.
   * All are in the same coordinate frame as the bridge's clip fields.
   */
  velocityXField = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  velocityZField = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  fillContribField = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  foamContribField = new Float32Array(FIELD_SIZE * FIELD_SIZE);

  private sectionRecords: WaterLocalFluidSectionRecord[] = [];
  private clipOriginX = 0;
  private clipOriginZ = 0;
  private needsReseed = false;

  private loopActive = false;
  private loopPromise: Promise<void> | null = null;

  // --- public API: lifecycle ------------------------------------------------

  /**
   * Asynchronously acquires a WebGPU device and initialises the simulator.
   * Call once at startup; returns true on success.
   */
  async init(): Promise<boolean> {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      console.warn("[DVEWaterGPUSimulation] WebGPU not available — GPU MLS-MPM disabled.");
      return false;
    }
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (!adapter) {
        console.warn("[DVEWaterGPUSimulation] No WebGPU adapter — GPU MLS-MPM disabled.");
        return false;
      }
      this.device = await adapter.requestDevice() as GPUDevice;
      this.simulator = new DVEWaterMLSMPMSimulator(this.device, {
        stiffness: 3.0,
        restDensity: 4.0,
        dynamicViscosity: 0.1,
        dt: 0.2,
        gravityY: -0.15,
        fpMultiplier: 1e7,
      });
      this.ready = true;
      this.loopActive = true;
      this.loopPromise = this._simulationLoop();
      console.log("[DVEWaterGPUSimulation] GPU MLS-MPM initialised.");
      return true;
    } catch (e) {
      console.error("[DVEWaterGPUSimulation] Init failed:", e);
      return false;
    }
  }

  /**
   * Notify the simulation that the bridge's clip origin has changed.
   * Triggers a reseed on the next loop iteration.
   */
  onClipMoved(clipOriginX: number, clipOriginZ: number): void {
    if (clipOriginX !== this.clipOriginX || clipOriginZ !== this.clipOriginZ) {
      this.clipOriginX = clipOriginX;
      this.clipOriginZ = clipOriginZ;
      this.needsReseed = true;
    }
  }

  /**
   * Register or update a water section for seeding.
   * Call this whenever the bridge receives a new WaterSectionGPUData.
   */
  registerSection(record: WaterLocalFluidSectionRecord): void {
    const idx = this.sectionRecords.findIndex(
      (r) => r.originX === record.originX && r.originZ === record.originZ
    );
    if (idx < 0) {
      this.sectionRecords.push(record);
    } else {
      this.sectionRecords[idx] = record;
    }
    this.needsReseed = true;
  }

  /** Remove all section records (e.g. on world unload). */
  clearSections(): void {
    this.sectionRecords.length = 0;
    this.needsReseed = true;
    this.clearOutputFields();
  }

  /** Stop the loop and free GPU resources. */
  dispose(): void {
    this.loopActive = false;
    this.clearOutputFields();
    this.simulator?.dispose();
    this.simulator = null;
    this.device = null;
    this.ready = false;
  }

  // --- private: coordinate conversion --------------------------------------

  private worldToSim(worldX: number, worldZ: number): { sx: number; sz: number } {
    return {
      sx: (worldX - this.clipOriginX) * WORLD_TO_SIM + SIM_MARGIN,
      sz: (worldZ - this.clipOriginZ) * WORLD_TO_SIM + SIM_MARGIN,
    };
  }

  private simToFieldIndex(simX: number, simZ: number): number {
    const worldFracX = (simX - SIM_MARGIN) * SIM_TO_WORLD;
    const worldFracZ = (simZ - SIM_MARGIN) * SIM_TO_WORLD;
    const fx = Math.floor(worldFracX);
    const fz = Math.floor(worldFracZ);
    if (fx < 0 || fx >= FIELD_SIZE || fz < 0 || fz >= FIELD_SIZE) {
      return -1;
    }
    return fx * FIELD_SIZE + fz;
  }

  // --- private: seeding -----------------------------------------------------

  private buildSeedParticles(): MLSMPMSeedParticle[] {
    const particles: MLSMPMSeedParticle[] = [];
    const { SIM_X, SIM_Y, SIM_Z } = DVEWaterMLSMPMSimulator;

    for (const section of this.sectionRecords) {
      const stride = section.particleSeedStride;
      const count = section.particleSeedCount;
      const buf = section.particleSeedBuffer;

      for (let i = 0; i < count; i++) {
        const base = i * stride;
        const worldX = buf[base + 0];
        const worldZ = buf[base + 2];
        const velX = buf[base + 3];
        const velZ = buf[base + 5];

        const { sx, sz } = this.worldToSim(worldX, worldZ);

        // Clamp within usable sim domain
        if (sx < SIM_MARGIN || sx > SIM_X - SIM_MARGIN - 1) continue;
        if (sz < SIM_MARGIN || sz > SIM_Z - SIM_MARGIN - 1) continue;

        const jitter = () => (Math.random() - 0.5) * 0.4;
        particles.push({
          x: sx + jitter(),
          y: SIM_Y_SURFACE + jitter(),
          z: sz + jitter(),
          vx: velX * WORLD_TO_SIM,
          vy: 0,
          vz: velZ * WORLD_TO_SIM,
        });
      }

      this.appendInteractionSeeds(section, particles);
    }

    return particles;
  }

  private appendInteractionSeeds(section: WaterLocalFluidSectionRecord, particles: MLSMPMSeedParticle[]) {
    const field = section.interactionField;
    const size = section.interactionFieldSize ?? 0;
    const { SIM_X, SIM_Z } = DVEWaterMLSMPMSimulator;
    if (!field || field.length === 0 || size <= 0) {
      return;
    }

    let added = 0;
    for (let fx = 0; fx < size; fx++) {
      for (let fz = 0; fz < size; fz++) {
        if (added >= MAX_INTERACTION_SEED_PARTICLES) {
          return;
        }
        const interaction = field[fx * size + fz] ?? 0;
        if (interaction < INTERACTION_SEED_THRESHOLD) {
          continue;
        }
        const gradient = this.sampleInteractionGradient(field, size, fx, fz);
        const directionLength = Math.hypot(gradient.x, gradient.z);
        const dirX = directionLength > 0.0001 ? gradient.x / directionLength : Math.cos(hashAngle(fx, fz));
        const dirZ = directionLength > 0.0001 ? gradient.z / directionLength : Math.sin(hashAngle(fx, fz));
        const worldX = section.originX + ((fx + 0.5) / size) * section.boundsX;
        const worldZ = section.originZ + ((fz + 0.5) / size) * section.boundsZ;
        const { sx, sz } = this.worldToSim(worldX, worldZ);
        if (sx < SIM_MARGIN || sx > SIM_X - SIM_MARGIN - 1) continue;
        if (sz < SIM_MARGIN || sz > SIM_Z - SIM_MARGIN - 1) continue;

        const burstCount = Math.max(1, Math.min(3, Math.round(interaction * 3.5)));
        for (let index = 0; index < burstCount; index++) {
          particles.push({
            x: sx + jitter(),
            y: SIM_Y_SURFACE + jitter() * 0.5,
            z: sz + jitter(),
            vx: dirX * interaction * INTERACTION_SEED_VELOCITY * WORLD_TO_SIM,
            vy: 0,
            vz: dirZ * interaction * INTERACTION_SEED_VELOCITY * WORLD_TO_SIM,
          });
          added += 1;
          if (particles.length >= DVEWaterMLSMPMSimulator.MAX_PARTICLES || added >= MAX_INTERACTION_SEED_PARTICLES) {
            return;
          }
        }
      }
    }
  }

  private sampleInteractionGradient(field: Float32Array, size: number, x: number, z: number) {
    const left = field[Math.max(0, x - 1) * size + z] ?? 0;
    const right = field[Math.min(size - 1, x + 1) * size + z] ?? 0;
    const up = field[x * size + Math.max(0, z - 1)] ?? 0;
    const down = field[x * size + Math.min(size - 1, z + 1)] ?? 0;
    return {
      x: right - left,
      z: down - up,
    };
  }

  // --- private: readback scatter -------------------------------------------

  /**
   * Scatter particle posvel readback data into the output fields.
   * posvelData: Float32Array with layout [x, y, z, _pad, vx, vy, vz, _pad] per particle (8 floats).
   */
  private scatterReadback(posvelData: Float32Array, numParticles: number): void {
    this.clearOutputFields();
    const tempCount = new Float32Array(FIELD_SIZE * FIELD_SIZE);
    const tempVX = new Float32Array(FIELD_SIZE * FIELD_SIZE);
    const tempVZ = new Float32Array(FIELD_SIZE * FIELD_SIZE);
    const tempFill = new Float32Array(FIELD_SIZE * FIELD_SIZE);

    const floatsPerParticle = POSVEL_STRUCT_SIZE / 4; // 8

    for (let i = 0; i < numParticles; i++) {
      const base = i * floatsPerParticle;
      const simX = posvelData[base + 0];
      const simZ = posvelData[base + 2];
      const velX = posvelData[base + 4];
      const velZ = posvelData[base + 6];

      this.scatterParticleToField(simX, simZ, velX, velZ, tempCount, tempVX, tempVZ, tempFill);
    }

    // Expected local density: how many particles we'd have in a fully-filled cell
    // One particle per seed point at ~SIM_XZ_WORLD_FOOTPRINT world cells each
    const expectedDensity = Math.max(1, (SIM_XZ_WORLD_FOOTPRINT * SIM_XZ_WORLD_FOOTPRINT) * 0.25);

    for (let i = 0; i < FIELD_SIZE * FIELD_SIZE; i++) {
      const n = tempCount[i];
      if (n === 0) continue;
      this.velocityXField[i] = tempVX[i] / n / WORLD_TO_SIM; // back to world units
      this.velocityZField[i] = tempVZ[i] / n / WORLD_TO_SIM;
      this.fillContribField[i] = Math.min(1, tempFill[i] / expectedDensity);
      const speed = Math.sqrt(
        this.velocityXField[i] * this.velocityXField[i] +
        this.velocityZField[i] * this.velocityZField[i]
      );
      this.foamContribField[i] = Math.min(1, speed * 0.3 + this.fillContribField[i] * 0.1);
    }
  }

  private scatterParticleToField(
    simX: number,
    simZ: number,
    velX: number,
    velZ: number,
    tempCount: Float32Array,
    tempVX: Float32Array,
    tempVZ: Float32Array,
    tempFill: Float32Array,
  ) {
    const worldX = (simX - SIM_MARGIN) * SIM_TO_WORLD;
    const worldZ = (simZ - SIM_MARGIN) * SIM_TO_WORLD;
    const x0 = Math.floor(worldX);
    const z0 = Math.floor(worldZ);
    const tx = worldX - x0;
    const tz = worldZ - z0;

    this.scatterParticleContribution(x0, z0, (1 - tx) * (1 - tz), velX, velZ, tempCount, tempVX, tempVZ, tempFill);
    this.scatterParticleContribution(x0 + 1, z0, tx * (1 - tz), velX, velZ, tempCount, tempVX, tempVZ, tempFill);
    this.scatterParticleContribution(x0, z0 + 1, (1 - tx) * tz, velX, velZ, tempCount, tempVX, tempVZ, tempFill);
    this.scatterParticleContribution(x0 + 1, z0 + 1, tx * tz, velX, velZ, tempCount, tempVX, tempVZ, tempFill);
  }

  private scatterParticleContribution(
    x: number,
    z: number,
    weight: number,
    velX: number,
    velZ: number,
    tempCount: Float32Array,
    tempVX: Float32Array,
    tempVZ: Float32Array,
    tempFill: Float32Array,
  ) {
    if (weight <= 0 || x < 0 || x >= FIELD_SIZE || z < 0 || z >= FIELD_SIZE) {
      return;
    }
    const index = x * FIELD_SIZE + z;
    tempCount[index] += weight;
    tempVX[index] += velX * weight;
    tempVZ[index] += velZ * weight;
    tempFill[index] += weight;
  }

  private clearOutputFields() {
    this.velocityXField.fill(0);
    this.velocityZField.fill(0);
    this.fillContribField.fill(0);
    this.foamContribField.fill(0);
  }

  // --- private: async simulation loop --------------------------------------

  private async _simulationLoop(): Promise<void> {
    while (this.loopActive) {
      if (!this.ready || !this.simulator) {
        this.clearOutputFields();
        await _sleep(50);
        continue;
      }

      // Reseed if clip moved or sections changed
      if (this.needsReseed) {
        this.needsReseed = false;
        const seeds = this.buildSeedParticles();
        this.simulator.seed(seeds);
      }

      if (this.simulator.numParticles === 0) {
        this.clearOutputFields();
        await _sleep(50);
        continue;
      }

      // Run 2 MLS-MPM substeps and copy positions to staging buffer
      const encoder = this.device!.createCommandEncoder({ label: "dve-mlsmpm-step" });
      this.simulator.recordStep(encoder);
      this.simulator.recordStep(encoder); // second substep for stability
      this.simulator.recordReadbackCopy(encoder);
      this.device!.queue.submit([encoder.finish()]);

      // Wait for GPU to finish and map the staging buffer
      const posvelData = await this.simulator.awaitReadback();
      if (posvelData) {
        this.scatterReadback(posvelData, this.simulator.numParticles);
      } else {
        this.clearOutputFields();
      }

      // Yield to allow the main thread to process events between steps
      await _raf();
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function jitter() {
  return (Math.random() - 0.5) * 0.4;
}

function hashAngle(x: number, z: number) {
  const seed = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return (seed - Math.floor(seed)) * Math.PI * 2;
}
