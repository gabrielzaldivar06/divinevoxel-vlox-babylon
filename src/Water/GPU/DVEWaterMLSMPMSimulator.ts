/**
 * DVEWaterMLSMPMSimulator — GPU MLS-MPM fluid simulator for DVE water surfaces.
 *
 * Directly adapted from the WebGPU-Ocean reference implementation (CzzzzH/MLS-MPM).
 * Uses raw WebGPU compute pipelines (GPUDevice), independent of Babylon.js rendering.
 *
 * Domain layout (sim-cell coordinates):
 *   X: 0 .. SIM_X-1   mapped to clip-space X over 256 world voxels
 *   Y: 0 .. SIM_Y-1   thin vertical slab, gravity keeps particles near the floor
 *   Z: 0 .. SIM_Z-1   mapped to clip-space Z over 256 world voxels
 *
 * Particle struct (80 bytes):
 *   [0..11]  position vec3f  [12..15] pad
 *   [16..27] velocity vec3f  [28..31] pad
 *   [32..79] C mat3x3f  (48 bytes, column-major, 3×vec4f in WGSL)
 *
 * PosVel struct (32 bytes):
 *   [0..11]  position vec3f  [12..15] pad
 *   [16..27] velocity vec3f  [28..31] pad
 */

// @ts-nocheck — Raw WebGPU compute adapter; WebGPU globals (GPUBufferUsage,
// GPUMapMode, etc.) conflict with Babylon.js's engine.d.ts branded types.
// Runtime correctness is verified via integration test, not static types.

import {
  clearGridWGSL,
  p2g1WGSL,
  p2g2WGSL,
  updateGridWGSL,
  g2pWGSL,
  copyPositionWGSL,
} from "./DVEWaterMLSMPMShaders.js";

export const PARTICLE_STRUCT_SIZE = 80;
export const POSVEL_STRUCT_SIZE = 32;
const CELL_STRUCT_SIZE = 16;

export interface MLSMPMSeedParticle {
  /** Sim-space X position (0..SIM_X). */
  x: number;
  /** Sim-space Y position (0..SIM_Y). */
  y: number;
  /** Sim-space Z position (0..SIM_Z). */
  z: number;
  /** Sim-space velocity X (sim-cells / dt). */
  vx: number;
  /** Sim-space velocity Y. */
  vy: number;
  /** Sim-space velocity Z. */
  vz: number;
}

export class DVEWaterMLSMPMSimulator {
  // Grid dimensions — 64×8×64 maps 256 world voxels at 4:1 scale with 2-cell margins
  static readonly SIM_X = 64;
  static readonly SIM_Y = 8;
  static readonly SIM_Z = 64;
  static readonly MAX_PARTICLES = 16384;

  // Physical constants
  readonly stiffness: number;
  readonly restDensity: number;
  readonly dynamicViscosity: number;
  readonly dt: number;
  readonly gravityY: number;
  readonly fpMultiplier: number;

  numParticles = 0;
  gridCount = DVEWaterMLSMPMSimulator.SIM_X * DVEWaterMLSMPMSimulator.SIM_Y * DVEWaterMLSMPMSimulator.SIM_Z;

  private device: GPUDevice;

  // GPU buffers
  particleBuffer: GPUBuffer;
  posvelBuffer: GPUBuffer;
  private cellBuffer: GPUBuffer;
  private realBoxSizeBuffer: GPUBuffer;
  private initBoxSizeBuffer: GPUBuffer;

  // Compute pipelines
  private clearGridPipeline: GPUComputePipeline;
  private p2g1Pipeline: GPUComputePipeline;
  private p2g2Pipeline: GPUComputePipeline;
  private updateGridPipeline: GPUComputePipeline;
  private g2pPipeline: GPUComputePipeline;
  private copyPositionPipeline: GPUComputePipeline;

  // Bind groups
  private clearGridBG: GPUBindGroup;
  private p2g1BG: GPUBindGroup;
  private p2g2BG: GPUBindGroup;
  private updateGridBG: GPUBindGroup;
  private g2pBG: GPUBindGroup;
  private copyPositionBG: GPUBindGroup;

  // Readback staging — one buffer to avoid allocation every frame
  private stagingBuffer: GPUBuffer;

  constructor(
    device: GPUDevice,
    opts: {
      stiffness?: number;
      restDensity?: number;
      dynamicViscosity?: number;
      dt?: number;
      gravityY?: number;
      fpMultiplier?: number;
    } = {}
  ) {
    this.device = device;
    this.stiffness = opts.stiffness ?? 3.0;
    this.restDensity = opts.restDensity ?? 4.0;
    this.dynamicViscosity = opts.dynamicViscosity ?? 0.1;
    this.dt = opts.dt ?? 0.2;
    this.gravityY = opts.gravityY ?? -0.15; // gentle surface gravity
    this.fpMultiplier = opts.fpMultiplier ?? 1e7;

    const { SIM_X, SIM_Y, SIM_Z, MAX_PARTICLES } = DVEWaterMLSMPMSimulator;
    const FP = this.fpMultiplier;
    const DT = this.dt;

    // ---- Buffers --------------------------------------------------------
    this.particleBuffer = device.createBuffer({
      label: "dve-mlsmpm-particles",
      size: PARTICLE_STRUCT_SIZE * MAX_PARTICLES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false,
    });
    this.posvelBuffer = device.createBuffer({
      label: "dve-mlsmpm-posvel",
      size: POSVEL_STRUCT_SIZE * MAX_PARTICLES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      mappedAtCreation: false,
    });
    this.cellBuffer = device.createBuffer({
      label: "dve-mlsmpm-cells",
      size: CELL_STRUCT_SIZE * SIM_X * SIM_Y * SIM_Z,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false,
    });
    this.stagingBuffer = device.createBuffer({
      label: "dve-mlsmpm-staging",
      size: POSVEL_STRUCT_SIZE * MAX_PARTICLES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false,
    });

    const boxBytesAligned = 16;
    this.realBoxSizeBuffer = device.createBuffer({
      label: "dve-mlsmpm-real-box",
      size: boxBytesAligned,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false,
    });
    this.initBoxSizeBuffer = device.createBuffer({
      label: "dve-mlsmpm-init-box",
      size: boxBytesAligned,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false,
    });
    // Both real/init box size = full sim grid dimensions
    const boxData = new Float32Array([SIM_X, SIM_Y, SIM_Z]);
    device.queue.writeBuffer(this.realBoxSizeBuffer, 0, boxData);
    device.queue.writeBuffer(this.initBoxSizeBuffer, 0, boxData);

    // ---- Pipelines -------------------------------------------------------
    this.clearGridPipeline = device.createComputePipeline({
      label: "dve-mlsmpm-clearGrid",
      layout: "auto",
      compute: { module: device.createShaderModule({ code: clearGridWGSL }), entryPoint: "clearGrid" },
    });

    this.p2g1Pipeline = device.createComputePipeline({
      label: "dve-mlsmpm-p2g1",
      layout: "auto",
      compute: {
        module: device.createShaderModule({ code: p2g1WGSL }),
        entryPoint: "p2g_1",
        constants: { fixed_point_multiplier: FP },
      },
    });

    this.p2g2Pipeline = device.createComputePipeline({
      label: "dve-mlsmpm-p2g2",
      layout: "auto",
      compute: {
        module: device.createShaderModule({ code: p2g2WGSL }),
        entryPoint: "p2g_2",
        constants: {
          fixed_point_multiplier: FP,
          stiffness: this.stiffness,
          rest_density: this.restDensity,
          dynamic_viscosity: this.dynamicViscosity,
          dt: DT,
        },
      },
    });

    this.updateGridPipeline = device.createComputePipeline({
      label: "dve-mlsmpm-updateGrid",
      layout: "auto",
      compute: {
        module: device.createShaderModule({ code: updateGridWGSL }),
        entryPoint: "updateGrid",
        constants: {
          fixed_point_multiplier: FP,
          dt: DT,
          gravity_y: this.gravityY,
        },
      },
    });

    this.g2pPipeline = device.createComputePipeline({
      label: "dve-mlsmpm-g2p",
      layout: "auto",
      compute: {
        module: device.createShaderModule({ code: g2pWGSL }),
        entryPoint: "g2p",
        constants: { fixed_point_multiplier: FP, dt: DT },
      },
    });

    this.copyPositionPipeline = device.createComputePipeline({
      label: "dve-mlsmpm-copyPos",
      layout: "auto",
      compute: { module: device.createShaderModule({ code: copyPositionWGSL }), entryPoint: "copyPosition" },
    });

    // ---- Bind groups (persistent — buffers don't change) -----------------
    this.clearGridBG = device.createBindGroup({
      layout: this.clearGridPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cellBuffer } }],
    });
    this.p2g1BG = device.createBindGroup({
      layout: this.p2g1Pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.cellBuffer } },
        { binding: 2, resource: { buffer: this.initBoxSizeBuffer } },
      ],
    });
    this.p2g2BG = device.createBindGroup({
      layout: this.p2g2Pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.cellBuffer } },
        { binding: 2, resource: { buffer: this.initBoxSizeBuffer } },
      ],
    });
    this.updateGridBG = device.createBindGroup({
      layout: this.updateGridPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cellBuffer } },
        { binding: 1, resource: { buffer: this.realBoxSizeBuffer } },
        { binding: 2, resource: { buffer: this.initBoxSizeBuffer } },
      ],
    });
    this.g2pBG = device.createBindGroup({
      layout: this.g2pPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.cellBuffer } },
        { binding: 2, resource: { buffer: this.realBoxSizeBuffer } },
        { binding: 3, resource: { buffer: this.initBoxSizeBuffer } },
      ],
    });
    this.copyPositionBG = device.createBindGroup({
      layout: this.copyPositionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.posvelBuffer } },
      ],
    });
  }

  /**
   * Upload seed particles into the GPU particle buffer and record the count.
   * Clamps to MAX_PARTICLES silently.
   */
  seed(particles: MLSMPMSeedParticle[]): void {
    const n = Math.min(particles.length, DVEWaterMLSMPMSimulator.MAX_PARTICLES);
    if (n === 0) {
      this.numParticles = 0;
      return;
    }
    this.numParticles = n;

    const rawBuf = new ArrayBuffer(n * PARTICLE_STRUCT_SIZE);
    const view = new Float32Array(rawBuf);
    for (let i = 0; i < n; i++) {
      const base = (i * PARTICLE_STRUCT_SIZE) / 4;
      const p = particles[i];
      // position at float[0..2], float[3] = pad
      view[base + 0] = p.x;
      view[base + 1] = p.y;
      view[base + 2] = p.z;
      // velocity at float[4..6], float[7] = pad
      view[base + 4] = p.vx;
      view[base + 5] = p.vy;
      view[base + 6] = p.vz;
      // C matrix (floats 8..19) already zero from new ArrayBuffer
    }
    this.device.queue.writeBuffer(this.particleBuffer, 0, rawBuf);
  }

  /**
   * Record MLS-MPM substep compute commands onto the provided encoder.
   * Call this once per substep; use 2 substeps per frame for stability.
   */
  recordStep(commandEncoder: GPUCommandEncoder): void {
    if (this.numParticles === 0) {
      return;
    }
    const pass = commandEncoder.beginComputePass();

    // Clear grid
    pass.setPipeline(this.clearGridPipeline);
    pass.setBindGroup(0, this.clearGridBG);
    pass.dispatchWorkgroups(Math.ceil(this.gridCount / 64));

    // P2G pass 1 — scatter momentum (atomic operations)
    pass.setPipeline(this.p2g1Pipeline);
    pass.setBindGroup(0, this.p2g1BG);
    pass.dispatchWorkgroups(Math.ceil(this.numParticles / 64));

    // P2G pass 2 — scatter pressure stress
    pass.setPipeline(this.p2g2Pipeline);
    pass.setBindGroup(0, this.p2g2BG);
    pass.dispatchWorkgroups(Math.ceil(this.numParticles / 64));

    // Update grid velocities (momentum → velocity + gravity + boundary)
    pass.setPipeline(this.updateGridPipeline);
    pass.setBindGroup(0, this.updateGridBG);
    pass.dispatchWorkgroups(Math.ceil(this.gridCount / 64));

    // G2P — gather grid velocity → APIC update + advection
    pass.setPipeline(this.g2pPipeline);
    pass.setBindGroup(0, this.g2pBG);
    pass.dispatchWorkgroups(Math.ceil(this.numParticles / 64));

    // Copy positions to posvelBuffer for readback
    pass.setPipeline(this.copyPositionPipeline);
    pass.setBindGroup(0, this.copyPositionBG);
    pass.dispatchWorkgroups(Math.ceil(this.numParticles / 64));

    pass.end();
  }

  /**
   * Append a copy from posvelBuffer to stagingBuffer onto the encoder.
   * After submitting the encoder, call awaitReadback() to get the data.
   */
  recordReadbackCopy(commandEncoder: GPUCommandEncoder): void {
    const byteSize = POSVEL_STRUCT_SIZE * this.numParticles;
    if (byteSize === 0) {
      return;
    }
    commandEncoder.copyBufferToBuffer(this.posvelBuffer, 0, this.stagingBuffer, 0, byteSize);
  }

  /**
   * Map the staging buffer and return a copy of the particle posvel data.
   * Must only be called after the command encoder containing recordReadbackCopy
   * has been submitted and the GPU work has completed.
   * Returns null if no particles or mapping fails.
   */
  async awaitReadback(): Promise<Float32Array | null> {
    if (this.numParticles === 0) {
      return null;
    }
    const byteSize = POSVEL_STRUCT_SIZE * this.numParticles;
    try {
      await this.stagingBuffer.mapAsync(GPUMapMode.READ, 0, byteSize);
      const raw = this.stagingBuffer.getMappedRange(0, byteSize);
      // Copy before unmap — Float32Array view is invalid after unmap
      const copy = new Float32Array(raw.byteLength / 4);
      copy.set(new Float32Array(raw));
      this.stagingBuffer.unmap();
      return copy;
    } catch {
      // Buffer might not be ready (GPU not finished); caller should retry next frame
      try { this.stagingBuffer.unmap(); } catch { /* ignore */ }
      return null;
    }
  }

  /** Release all GPU resources. */
  dispose(): void {
    this.particleBuffer.destroy();
    this.posvelBuffer.destroy();
    this.cellBuffer.destroy();
    this.realBoxSizeBuffer.destroy();
    this.initBoxSizeBuffer.destroy();
    this.stagingBuffer.destroy();
  }
}
