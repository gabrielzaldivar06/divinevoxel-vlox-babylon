/**
 * DVEWaterComputeRefiner — Phase 9 GPU Compute backend for DVE water.
 *
 * Moves the two hot CPU loops from DVEWaterHybridBridge to WebGPU compute shaders:
 *   cs_simulate : velocity advection, mass transfer, foam decay, pressure update
 *   cs_pack     : derive display signals, water-class classification, encode RGBA
 *
 * Pipeline (per simulation step):
 *   CPU rebuildTargets()  →  uploadTargets / uploadSimState
 *   GPU cs_simulate       →  updated sim state (fill, vx, vz, foam, pressure)
 *   GPU cs_pack           →  4 × RGBA u8 packed textures
 *   async CPU readback    →  packedBase/Dynamic/Flow/Debug  (one frame latency)
 *   DVEWaterHybridBridge  →  RawTexture.update() override when data arrives
 *
 * The CPU simulateStep + packTextures remain active as a seamless fallback until
 * the first successful GPU readback and whenever WebGPU is unavailable.
 */

// @ts-nocheck — Raw WebGPU compute adapter; WebGPU globals (GPUBufferUsage,
// GPUShaderStage, GPUMapMode, etc.) conflict with Babylon.js's engine.d.ts
// branded types. Runtime correctness is verified via integration test.

// ─── Field indices ──────────────────────────────────────────────────────────
// Target buffer channels  (TARGET_CHANNELS fields, each FIELD_N floats)
const T_FILL = 0;
const T_VX = 1;
const T_VZ = 2;
const T_FLOW = 3;
const T_TURB = 4;
const T_SHORE = 5;
const T_INTERACT = 6;
const T_LARGE_BODY = 7;
const T_PATCH_FLOW = 8;
const T_PATCH_PHASE = 9;
const T_PRESENCE = 10;
const T_PART_FOAM = 11;
const T_PART_FLOW = 12;
const TARGET_CHANNELS = 13;

// Sim-state buffer channels (SIM_CHANNELS fields, each FIELD_N floats)
const S_FILL = 0;
const S_VX = 1;
const S_VZ = 2;
const S_FOAM = 3;
const S_PRESSURE = 4;
const SIM_CHANNELS = 5;

// Packed-output channels (PACK_TEXTURES × FIELD_N u32, RGBA encoded as u8×4)
const PACK_TEXTURES = 4;

// Grid dimensions
const FIELD_SIZE = 256;
const FIELD_N = FIELD_SIZE * FIELD_SIZE; // 65 536

// Buffer sizes in bytes
const TARGET_BUF_BYTES = TARGET_CHANNELS * FIELD_N * 4;
const SIM_BUF_BYTES = SIM_CHANNELS * FIELD_N * 4;
const PACKED_BUF_BYTES = PACK_TEXTURES * FIELD_N * 4; // u32 per pixel
const PARAMS_BUF_BYTES = 16; // 4 × f32 : delta, elapsed, pad, pad

// ─── WGSL Source ─────────────────────────────────────────────────────────────
function buildWGSL(): string {
  return /* wgsl */ `
// ── Simulation constants ──────────────────────────────────────────────────────
const W                    : u32 = 256u;
const H                    : u32 = 256u;
const N                    : u32 = 65536u;   // W * H

const T_FILL               : u32 = 0u;
const T_VX                 : u32 = 1u;
const T_VZ                 : u32 = 2u;
const T_FLOW               : u32 = 3u;
const T_TURB               : u32 = 4u;
const T_SHORE              : u32 = 5u;
const T_INTERACT           : u32 = 6u;
const T_LARGE_BODY         : u32 = 7u;
const T_PATCH_FLOW         : u32 = 8u;
const T_PATCH_PHASE        : u32 = 9u;
const T_PRESENCE           : u32 = 10u;
const T_PART_FOAM          : u32 = 11u;
const T_PART_FLOW          : u32 = 12u;

const S_FILL               : u32 = 0u;
const S_VX                 : u32 = 1u;
const S_VZ                 : u32 = 2u;
const S_FOAM               : u32 = 3u;
const S_PRESSURE           : u32 = 4u;

const VELOCITY_ADVECTION   : f32 = 2.2;
const VELOCITY_DAMPING     : f32 = 0.92;
const TARGET_PULL          : f32 = 0.12;
const FILL_RELAXATION      : f32 = 0.22;
const PRESSURE_RESPONSE    : f32 = 0.18;
const FOAM_DECAY           : f32 = 0.94;
const EDGE_DECAY           : f32 = 0.9;
const MASS_TRANSFER_RATE   : f32 = 4.2;
const MASS_RETENTION       : f32 = 0.985;
const MOMENTUM_RESPONSE    : f32 = 0.28;
const VELOCITY_LIMIT       : f32 = 1.35;
const INTERACTION_TO_FLOW  : f32 = 0.22;
const INTERACTION_TO_FOAM  : f32 = 0.3;
const INTERACTION_TO_PRES  : f32 = 0.2;
const FLOW_PULSE_SCALE     : f32 = 0.08;

// ── Uniform parameters ────────────────────────────────────────────────────────
struct Params {
  delta   : f32,
  elapsed : f32,
  _pad0   : f32,
  _pad1   : f32,
}

// ── Bindings ──────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<storage, read>       targetIn  : array<f32>;   // TARGET_CHANNELS * N
@group(0) @binding(1) var<storage, read>       simIn     : array<f32>;   // SIM_CHANNELS * N  (cs_simulate)
@group(0) @binding(2) var<storage, read_write> simOut    : array<f32>;   // SIM_CHANNELS * N  (cs_simulate writes; cs_pack reads)
@group(0) @binding(3) var<storage, read_write> packedOut : array<u32>;   // PACK_TEXTURES * N
@group(0) @binding(4) var<uniform>             params    : Params;

// ── Helpers ───────────────────────────────────────────────────────────────────
fn clamp01(v : f32) -> f32 { return clamp(v, 0.0, 1.0); }
fn clampVel(v : f32) -> f32 { return clamp(v, -VELOCITY_LIMIT, VELOCITY_LIMIT); }

fn fractF32(v : f32) -> f32 { return v - floor(v); }

// sign of a, falling back to sign of b, then sign of c (matches JS || coalesce)
fn signOr3(a : f32, b : f32, c : f32) -> f32 {
  if (a != 0.0) { return sign(a); }
  if (b != 0.0) { return sign(b); }
  return sign(c);
}

// Bilinear sample of a channel from simIn
fn sampleSimIn(ch : u32, sx : f32, sz : f32) -> f32 {
  let cx = clamp(sx, 0.0, f32(W) - 1.001);
  let cz = clamp(sz, 0.0, f32(H) - 1.001);
  let x0 = u32(cx);
  let z0 = u32(cz);
  let x1 = min(W - 1u, x0 + 1u);
  let z1 = min(H - 1u, z0 + 1u);
  let tx = cx - f32(x0);
  let tz = cz - f32(z0);
  let base = ch * N;
  let a = simIn[base + x0 * H + z0];
  let b = simIn[base + x1 * H + z0];
  let c = simIn[base + x0 * H + z1];
  let d = simIn[base + x1 * H + z1];
  return mix(mix(a, b, tx), mix(c, d, tx), tz);
}

// Pack four [0,1] f32 values into a single u32 as little-endian RGBA u8
fn packRGBA(r : f32, g : f32, b : f32, a : f32) -> u32 {
  let ri = u32(clamp(r * 255.0 + 0.5, 0.0, 255.0));
  let gi = u32(clamp(g * 255.0 + 0.5, 0.0, 255.0));
  let bi = u32(clamp(b * 255.0 + 0.5, 0.0, 255.0));
  let ai = u32(clamp(a * 255.0 + 0.5, 0.0, 255.0));
  return (ri & 0xffu) | ((gi & 0xffu) << 8u) | ((bi & 0xffu) << 16u) | ((ai & 0xffu) << 24u);
}

// ── cs_simulate ───────────────────────────────────────────────────────────────
// Implements DVEWaterHybridBridge.simulateStep() on the GPU.
// Each invocation processes one cell (x, z) of the 256×256 hybrid grid.
// Reads:  targetIn, simIn (current state)
// Writes: simOut (next state)
@compute @workgroup_size(8, 8, 1)
fn cs_simulate(@builtin(global_invocation_id) gid : vec3<u32>) {
  let x = gid.x;
  let z = gid.y;
  if (x >= W || z >= H) { return; }

  let idx  = x * H + z;
  let dt   = params.delta;

  // ── Read current sim state ──────────────────────────────────────────────────
  let fill = simIn[S_FILL * N + idx];
  let vx   = simIn[S_VX   * N + idx];
  let vz   = simIn[S_VZ   * N + idx];

  // ── Read target state ───────────────────────────────────────────────────────
  let tFill   = targetIn[T_FILL    * N + idx];
  let rawTVX  = targetIn[T_VX      * N + idx];
  let rawTVZ  = targetIn[T_VZ      * N + idx];
  let tFlow   = targetIn[T_FLOW    * N + idx];
  let tVX     = rawTVX * tFlow;  // targetVelocityX * targetFlow
  let tVZ     = rawTVZ * tFlow;
  let tPres   = targetIn[T_PRESENCE * N + idx];

  // ── Clamped neighbour indices (clamp to boundary = no-flow BC) ─────────────
  let lX = select(x, x - 1u, x > 0u);
  let rX = select(x, x + 1u, x + 1u < W);
  let uZ = select(z, z - 1u, z > 0u);
  let dZ = select(z, z + 1u, z + 1u < H);

  let lFill = simIn[S_FILL * N + lX * H + z ];
  let rFill = simIn[S_FILL * N + rX * H + z ];
  let uFill = simIn[S_FILL * N + x  * H + uZ];
  let dFill = simIn[S_FILL * N + x  * H + dZ];

  // ── Mass transfer (pair contributions) ─────────────────────────────────────
  // For each of the four adjacent pairs that include this cell, compute the net
  // mass delta using the same applyPairTransfer logic as the CPU path.
  var netMass = 0.0;

  // RIGHT pair: (x,z) is FROM, (x+1,z) is TO
  if (x + 1u < W) {
    let rVX   = simIn[S_VX * N + rX * H + z];
    let rTVX  = targetIn[T_VX * N + rX * H + z] * targetIn[T_FLOW * N + rX * H + z];
    let pVel  = (vx + rVX)  * 0.5;
    let pTVel = (tVX + rTVX) * 0.5;
    let drive = (fill - rFill) * 0.55 + pVel * 0.34 + pTVel * MOMENTUM_RESPONSE;
    netMass  -= clamp(drive * MASS_TRANSFER_RATE * dt, -(rFill * 0.5), fill  * 0.5);
  }

  // DOWN pair: (x,z) is FROM, (x,z+1) is TO
  if (z + 1u < H) {
    let dVZ   = simIn[S_VZ * N + x * H + dZ];
    let dTVZ  = targetIn[T_VZ * N + x * H + dZ] * targetIn[T_FLOW * N + x * H + dZ];
    let pVel  = (vz + dVZ)  * 0.5;
    let pTVel = (tVZ + dTVZ) * 0.5;
    let drive = (fill - dFill) * 0.55 + pVel * 0.34 + pTVel * MOMENTUM_RESPONSE;
    netMass  -= clamp(drive * MASS_TRANSFER_RATE * dt, -(dFill * 0.5), fill  * 0.5);
  }

  // LEFT pair: (x-1,z) is FROM, (x,z) is TO
  if (x > 0u) {
    let lVX   = simIn[S_VX * N + lX * H + z];
    let lTVX  = targetIn[T_VX * N + lX * H + z] * targetIn[T_FLOW * N + lX * H + z];
    let pVel  = (lVX + vx)  * 0.5;
    let pTVel = (lTVX + tVX) * 0.5;
    let drive = (lFill - fill) * 0.55 + pVel * 0.34 + pTVel * MOMENTUM_RESPONSE;
    netMass  += clamp(drive * MASS_TRANSFER_RATE * dt, -(fill * 0.5), lFill * 0.5);
  }

  // UP pair: (x,z-1) is FROM, (x,z) is TO
  if (z > 0u) {
    let uVZ   = simIn[S_VZ * N + x * H + uZ];
    let uTVZ  = targetIn[T_VZ * N + x * H + uZ] * targetIn[T_FLOW * N + x * H + uZ];
    let pVel  = (uVZ + vz)  * 0.5;
    let pTVel = (uTVZ + tVZ) * 0.5;
    let drive = (uFill - fill) * 0.55 + pVel * 0.34 + pTVel * MOMENTUM_RESPONSE;
    netMass  += clamp(drive * MASS_TRANSFER_RATE * dt, -(fill * 0.5), uFill * 0.5);
  }

  // ── Advection ───────────────────────────────────────────────────────────────
  let sampleX  = f32(x) - vx * VELOCITY_ADVECTION * dt;
  let sampleZ  = f32(z) - vz * VELOCITY_ADVECTION * dt;
  let advFill  = sampleSimIn(S_FILL, sampleX, sampleZ);
  let advFoam  = sampleSimIn(S_FOAM, sampleX, sampleZ);

  // ── Pressure ────────────────────────────────────────────────────────────────
  let neighborAvg = (lFill + rFill + uFill + dFill) * 0.25;
  let pressure    = (neighborAvg - advFill + netMass * 2.2) * PRESSURE_RESPONSE;

  // ── Velocity update ─────────────────────────────────────────────────────────
  let interaction  = targetIn[T_INTERACT * N + idx];
  let shoreDamping = 1.0 - targetIn[T_SHORE * N + idx] * 0.24;
  let gradX        = (lFill - rFill) * 0.5;
  let gradZ        = (uFill - dFill) * 0.5;
  let presenceMix  = select(0.03, TARGET_PULL, tPres > 0.0);

  var nVX = vx * VELOCITY_DAMPING + tVX * presenceMix + gradX * 0.2;
  var nVZ = vz * VELOCITY_DAMPING + tVZ * presenceMix + gradZ * 0.2;
  nVX += pressure * signOr3(gradX, tVX, 1.0) * 0.08;
  nVZ += pressure * signOr3(gradZ, tVZ, 1.0) * 0.08;
  nVX += netMass * 0.9;
  nVZ += netMass * 0.9;
  nVX += tVX * interaction * INTERACTION_TO_FLOW;
  nVZ += tVZ * interaction * INTERACTION_TO_FLOW;
  nVX *= shoreDamping;
  nVZ *= shoreDamping;
  nVX = clampVel(nVX);
  nVZ = clampVel(nVZ);

  // ── Fill update ─────────────────────────────────────────────────────────────
  let fillRelax = select(0.08, FILL_RELAXATION, tPres > 0.0);
  var nFill = (
    advFill * (1.0 - fillRelax) +
    neighborAvg * 0.12 +
    tFill * fillRelax +
    fill  * MASS_RETENTION +
    netMass + pressure
  ) * 0.5;
  if (tPres <= 0.0) { nFill *= EDGE_DECAY; }
  nFill = clamp01(nFill);

  // ── Foam update ─────────────────────────────────────────────────────────────
  let speed = sqrt(nVX * nVX + nVZ * nVZ);
  let foamSource =
    targetIn[T_TURB      * N + idx] * 0.24 +
    targetIn[T_SHORE     * N + idx] * 0.18 +
    speed                            * 0.12 +
    interaction                      * INTERACTION_TO_FOAM +
    abs(pressure)                    * 0.9  +
    targetIn[T_PART_FOAM * N + idx]  * 0.9;
  let nFoam = clamp01(max(advFoam * FOAM_DECAY, foamSource));

  // ── Pressure output ─────────────────────────────────────────────────────────
  let nPressure = clamp01(
    abs(pressure)  * 2.6 +
    abs(netMass)   * 3.1 +
    interaction    * INTERACTION_TO_PRES
  );

  // ── Write simOut ────────────────────────────────────────────────────────────
  simOut[S_FILL     * N + idx] = nFill;
  simOut[S_VX       * N + idx] = nVX;
  simOut[S_VZ       * N + idx] = nVZ;
  simOut[S_FOAM     * N + idx] = nFoam;
  simOut[S_PRESSURE * N + idx] = nPressure;
}

// ── cs_pack ───────────────────────────────────────────────────────────────────
// Implements DVEWaterHybridBridge.packTextures() on the GPU.
// Reads:  targetIn, simOut (written by cs_simulate)
// Writes: packedOut  (four RGBA textures encoded as u32 per pixel)
//
// Phase-9 addition: per-cell water-class classification signal replaces raw
// patchFlow in dynamicOut.a, steering the SSFR composition stack toward the
// correct water type (river = high SSFR, lake = high patch, coastal = mixed).
@compute @workgroup_size(8, 8, 1)
fn cs_pack(@builtin(global_invocation_id) gid : vec3<u32>) {
  let x = gid.x;
  let z = gid.y;
  if (x >= W || z >= H) { return; }

  let idx = x * H + z;

  // ── Sim state (written by cs_simulate) ─────────────────────────────────────
  let fill     = clamp01(simOut[S_FILL     * N + idx]);
  let vx       =         simOut[S_VX       * N + idx];
  let vz       =         simOut[S_VZ       * N + idx];
  let foam     = clamp01(simOut[S_FOAM     * N + idx]);
  let pressure = clamp01(simOut[S_PRESSURE * N + idx]);

  // ── Target fields ───────────────────────────────────────────────────────────
  let tFlow      = targetIn[T_FLOW       * N + idx];
  let tTurb      = targetIn[T_TURB       * N + idx];
  let tShore     = targetIn[T_SHORE      * N + idx];
  let interaction= targetIn[T_INTERACT   * N + idx];
  let largeBody  = clamp01(targetIn[T_LARGE_BODY * N + idx]);
  let patchFlow  = clamp01(targetIn[T_PATCH_FLOW * N + idx]);
  let patchPhase = targetIn[T_PATCH_PHASE * N + idx];
  let tPresence  = targetIn[T_PRESENCE   * N + idx];
  let partFoam   = targetIn[T_PART_FOAM  * N + idx];
  let partFlow   = targetIn[T_PART_FLOW  * N + idx];

  // ── Clamped neighbours for curl ─────────────────────────────────────────────
  let lX = select(x, x - 1u, x > 0u);
  let rX = select(x, x + 1u, x + 1u < W);
  let uZ = select(z, z - 1u, z > 0u);
  let dZ = select(z, z + 1u, z + 1u < H);

  let lVZ = simOut[S_VZ * N + lX * H + z ];
  let rVZ = simOut[S_VZ * N + rX * H + z ];
  let uVX = simOut[S_VX * N + x  * H + uZ];
  let dVX = simOut[S_VX * N + x  * H + dZ];
  let curl  = abs((rVZ - lVZ) - (dVX - uVX));

  // ── Derived signals ─────────────────────────────────────────────────────────
  let speed = clamp01(sqrt(vx * vx + vz * vz));

  let pulse = fractF32(
    params.elapsed * (0.22 + speed * 0.35 + patchFlow * 0.18 + largeBody * 0.08) +
    f32(x) * 0.013 + f32(z) * 0.017 +
    patchPhase * 0.43
  );

  let targetFoam  = clamp01(tTurb * 0.35 + tShore * 0.24);
  let stableFoam  = clamp01(targetFoam + foam * 0.35 + tFlow * 0.08 + patchFlow * 0.05 + largeBody * 0.02);
  let dynamicFoam = clamp01(foam * 0.85 + partFoam + pulse * FLOW_PULSE_SCALE * (speed + patchFlow * 0.35));
  let dynamicFlow = clamp01(speed * 0.62 + tFlow * 0.24 + patchFlow * 0.14 + partFlow);
  let calmness    = clamp01(1.0 - min(1.0, speed * 0.8 + foam * 0.42 + tTurb * 0.3) + largeBody * 0.18);
  let agitation   = clamp01(curl * 0.25 + foam * 0.28 + partFlow * 0.4 + interaction * 0.42 + largeBody * 0.08);

  let encodedVX = clamp01(vx / (VELOCITY_LIMIT * 2.0) + 0.5);
  let encodedVZ = clamp01(vz / (VELOCITY_LIMIT * 2.0) + 0.5);

  // ── Water-class classification (Phase 9) ────────────────────────────────────
  // Compute per-cell class signals from simulation state and bias patchFlow so
  // the SSFR composition stack in DVEWaterMaterialPlugin behaves correctly for
  // each water archetype (river, lake, coastal).
  let riverSignal   = clamp01((tFlow * 0.5 + tTurb * 0.5) * (1.0 - largeBody * 0.6));
  let lakeSignal    = largeBody * (1.0 - tShore * 0.7) * (1.0 - tTurb * 0.5);
  let coastalSignal = tShore * (0.5 + largeBody * 0.5);
  // Rivers and coastal zones push patchFlow up (more SSFR / energetic rendering).
  // Lakes keep it lower (large-body patch rendering stays dominant).
  let classRefinedPatchFlow = clamp01(
    patchFlow * 0.6 +
    riverSignal   * 0.25 +
    coastalSignal * 0.15
  );

  // ── Write four packed textures ───────────────────────────────────────────────
  // base:    R=stableFoam, G=dynamicFlow, B=calmness,   A=fill
  packedOut[0u * N + idx] = packRGBA(
    clamp01(stableFoam + interaction * 0.18),
    dynamicFlow,
    calmness,
    fill
  );

  // dynamic: R=dynamicFoam, G=dynamicFlow, B=agitation, A=classRefinedPatchFlow
  packedOut[1u * N + idx] = packRGBA(
    clamp01(dynamicFoam + interaction * 0.2),
    clamp01(dynamicFlow + interaction * 0.16),
    agitation,
    classRefinedPatchFlow
  );

  // flow:    R=encodedVX,  G=encodedVZ,   B=speed,      A=pressure
  packedOut[2u * N + idx] = packRGBA(
    encodedVX,
    encodedVZ,
    clamp01(speed    + interaction * 0.12),
    clamp01(pressure + interaction * 0.12)
  );

  // debug:   R=largeBody,  G=shore,       B=interaction, A=presence
  packedOut[3u * N + idx] = packRGBA(
    largeBody,
    clamp01(tShore),
    interaction,
    clamp01(tPresence)
  );
}
`;
}

// ─── DVEWaterComputeRefiner ───────────────────────────────────────────────────

/**
 * WebGPU compute backend that replaces DVEWaterHybridBridge.simulateStep() and
 * packTextures() with two parallel GPU compute passes.
 *
 * Usage:
 *   1. await refiner.init()
 *   2. refiner.uploadTargets(...)    — every simulation step
 *   3. refiner.uploadSimState(...)   — every simulation step
 *   4. refiner.refine(dt, elapsed)  — submits GPU work + schedules async readback
 *   5. Next frame: if (refiner.packedDataReady) apply packedBase/Dynamic/Flow/Debug
 */
export class DVEWaterComputeRefiner {
  private _device: GPUDevice | null = null;
  private _pipeline1: GPUComputePipeline | null = null;  // cs_simulate
  private _pipeline2: GPUComputePipeline | null = null;  // cs_pack
  private _bindGroupLayout: GPUBindGroupLayout | null = null;

  // GPU buffers
  private _targetBuf: GPUBuffer | null = null;   // write (upload from CPU)
  private _simInBuf: GPUBuffer | null = null;    // write (upload current state)
  private _simOutBuf: GPUBuffer | null = null;   // read_write (cs_simulate output / cs_pack input)
  private _packedBuf: GPUBuffer | null = null;   // read_write (cs_pack output)
  private _paramsBuf: GPUBuffer | null = null;   // uniform
  private _stagingBuf: GPUBuffer | null = null;  // async readback

  // Single bind group shared by both passes; each pass only uses the bindings it needs
  private _bindGroup: GPUBindGroup | null = null;

  // Readback state
  private _readbackInFlight = false;
  packedDataReady = false;

  /** true once init() succeeded and all GPU resources are allocated */
  ready = false;

  // ── CPU-side output arrays (populated by async readback) ──────────────────
  /** Updated simulation state read back from GPU (float, FIELD_N values each) */
  readonly simFill = new Float32Array(FIELD_N);
  readonly simVX = new Float32Array(FIELD_N);
  readonly simVZ = new Float32Array(FIELD_N);
  readonly simFoam = new Float32Array(FIELD_N);
  readonly simPressure = new Float32Array(FIELD_N);

  /** Packed RGBA texture data read back from GPU (Uint8Array, FIELD_N × 4 bytes each) */
  readonly packedBase = new Uint8Array(FIELD_N * 4);
  readonly packedDynamic = new Uint8Array(FIELD_N * 4);
  readonly packedFlow = new Uint8Array(FIELD_N * 4);
  readonly packedDebug = new Uint8Array(FIELD_N * 4);

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async init(): Promise<boolean> {
    if (typeof navigator === "undefined" || !("gpu" in (navigator as any))) {
      return false;
    }
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (!adapter) return false;
      this._device = await adapter.requestDevice() as GPUDevice;
      this._buildResources();
      this.ready = true;
      return true;
    } catch (e) {
      console.warn("[DVEWaterComputeRefiner] init() failed:", e);
      return false;
    }
  }

  private _buildResources(): void {
    const device = this._device!;

    // ── GPU buffers ─────────────────────────────────────────────────────────
    this._targetBuf = device.createBuffer({
      label: "dve-water-refiner-target",
      size: TARGET_BUF_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false,
    });
    this._simInBuf = device.createBuffer({
      label: "dve-water-refiner-sim-in",
      size: SIM_BUF_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false,
    });
    this._simOutBuf = device.createBuffer({
      label: "dve-water-refiner-sim-out",
      size: SIM_BUF_BYTES,
      // Needs COPY_SRC for readback and STORAGE for shader access
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      mappedAtCreation: false,
    });
    this._packedBuf = device.createBuffer({
      label: "dve-water-refiner-packed",
      size: PACKED_BUF_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      mappedAtCreation: false,
    });
    this._paramsBuf = device.createBuffer({
      label: "dve-water-refiner-params",
      size: PARAMS_BUF_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false,
    });
    this._stagingBuf = device.createBuffer({
      label: "dve-water-refiner-staging",
      // simOut + packedOut concatenated for a single readback copy
      size: SIM_BUF_BYTES + PACKED_BUF_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false,
    });

    // ── Bind group layout ────────────────────────────────────────────────────
    this._bindGroupLayout = device.createBindGroupLayout({
      label: "dve-water-refiner-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });

    // ── Compute pipelines ────────────────────────────────────────────────────
    const module = device.createShaderModule({
      label: "dve-water-refiner-wgsl",
      code: buildWGSL(),
    });
    const pipelineLayout = device.createPipelineLayout({
      label: "dve-water-refiner-layout",
      bindGroupLayouts: [this._bindGroupLayout],
    });

    this._pipeline1 = device.createComputePipeline({
      label: "dve-water-refiner-simulate",
      layout: pipelineLayout,
      compute: { module, entryPoint: "cs_simulate" },
    });
    this._pipeline2 = device.createComputePipeline({
      label: "dve-water-refiner-pack",
      layout: pipelineLayout,
      compute: { module, entryPoint: "cs_pack" },
    });

    // ── Single shared bind group ─────────────────────────────────────────────
    // cs_simulate: reads binding 1 (simIn), writes binding 2 (simOut)
    // cs_pack:     reads binding 2 (simOut), writes binding 3 (packedOut)
    // Both shaders share this single bind group; unused bindings are simply ignored.
    this._bindGroup = device.createBindGroup({
      label: "dve-water-refiner-bg",
      layout: this._bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this._targetBuf } },
        { binding: 1, resource: { buffer: this._simInBuf } },
        { binding: 2, resource: { buffer: this._simOutBuf } },
        { binding: 3, resource: { buffer: this._packedBuf } },
        { binding: 4, resource: { buffer: this._paramsBuf } },
      ],
    });
  }

  // ─── Upload helpers ─────────────────────────────────────────────────────────

  /**
   * Upload all 13 target fields (output of rebuildTargets) to the GPU.
   * Call once per simulation step, before refine().
   */
  uploadTargets(
    fill: Float32Array,
    vx: Float32Array,
    vz: Float32Array,
    flow: Float32Array,
    turbulence: Float32Array,
    shore: Float32Array,
    interaction: Float32Array,
    largeBody: Float32Array,
    patchFlow: Float32Array,
    patchPhase: Float32Array,
    presence: Float32Array,
    particleFoam: Float32Array,
    particleFlow: Float32Array,
  ): void {
    if (!this._device || !this._targetBuf) return;
    const combined = new Float32Array(TARGET_CHANNELS * FIELD_N);
    const channels = [fill, vx, vz, flow, turbulence, shore, interaction, largeBody, patchFlow, patchPhase, presence, particleFoam, particleFlow];
    for (let i = 0; i < TARGET_CHANNELS; i++) {
      combined.set(channels[i], i * FIELD_N);
    }
    this._device.queue.writeBuffer(this._targetBuf, 0, combined);
  }

  /**
   * Upload the current simulation state (output of last simulateStep) to the GPU.
   * Call once per simulation step, before refine().
   */
  uploadSimState(
    fill: Float32Array,
    vx: Float32Array,
    vz: Float32Array,
    foam: Float32Array,
    pressure: Float32Array,
  ): void {
    if (!this._device || !this._simInBuf) return;
    const combined = new Float32Array(SIM_CHANNELS * FIELD_N);
    combined.set(fill,     S_FILL     * FIELD_N);
    combined.set(vx,       S_VX       * FIELD_N);
    combined.set(vz,       S_VZ       * FIELD_N);
    combined.set(foam,     S_FOAM     * FIELD_N);
    combined.set(pressure, S_PRESSURE * FIELD_N);
    this._device.queue.writeBuffer(this._simInBuf, 0, combined);
  }

  // ─── Compute dispatch ───────────────────────────────────────────────────────

  /**
   * Dispatch both compute passes and schedule an async CPU readback.
   * @param delta       Fixed simulation timestep in seconds (SIMULATION_STEP)
   * @param elapsed     Accumulated elapsed simulation time (used for pulse animation)
   */
  refine(delta: number, elapsed: number): void {
    if (!this._device || !this._pipeline1 || !this._pipeline2 || !this._bindGroup) return;

    // Upload uniform params
    const paramsData = new Float32Array([delta, elapsed, 0, 0]);
    this._device.queue.writeBuffer(this._paramsBuf!, 0, paramsData);

    const workgroups = Math.ceil(FIELD_SIZE / 8); // 32 × 32 with 8×8 workgroup

    const encoder = this._device.createCommandEncoder({ label: "dve-water-refiner-enc" });

    // Pass 1: cs_simulate — reads simIn/targetIn, writes simOut
    {
      const pass = encoder.beginComputePass({ label: "dve-refiner-simulate" });
      pass.setPipeline(this._pipeline1);
      pass.setBindGroup(0, this._bindGroup);
      pass.dispatchWorkgroups(workgroups, workgroups, 1);
      pass.end();
    }

    // Pass 2: cs_pack — reads simOut/targetIn, writes packedOut
    // WebGPU guarantees all writes from pass 1 are visible to pass 2 (separate compute passes)
    {
      const pass = encoder.beginComputePass({ label: "dve-refiner-pack" });
      pass.setPipeline(this._pipeline2);
      pass.setBindGroup(0, this._bindGroup);
      pass.dispatchWorkgroups(workgroups, workgroups, 1);
      pass.end();
    }

    const canScheduleReadback = !!this._stagingBuf && !this._readbackInFlight;
    if (canScheduleReadback) {
      // Copy outputs to staging buffer for CPU readback only when the staging
      // buffer is not still mapped by the previous readback.
      encoder.copyBufferToBuffer(this._simOutBuf!, 0, this._stagingBuf!, 0, SIM_BUF_BYTES);
      encoder.copyBufferToBuffer(this._packedBuf!, 0, this._stagingBuf!, SIM_BUF_BYTES, PACKED_BUF_BYTES);
    }

    this._device.queue.submit([encoder.finish()]);

    if (canScheduleReadback) {
      this._scheduleReadback();
    }
  }

  private _scheduleReadback(): void {
    if (this._readbackInFlight || !this._stagingBuf) return;
    this._readbackInFlight = true;
    this.packedDataReady = false;

    this._stagingBuf.mapAsync(GPUMapMode.READ).then(() => {
      const mapped = this._stagingBuf!.getMappedRange();

      // ── Sim state (bytes 0 .. SIM_BUF_BYTES) ────────────────────────────────
      const simData = new Float32Array(mapped, 0, SIM_CHANNELS * FIELD_N);
      this.simFill.set(simData.subarray(S_FILL     * FIELD_N, (S_FILL     + 1) * FIELD_N));
      this.simVX.set(  simData.subarray(S_VX       * FIELD_N, (S_VX       + 1) * FIELD_N));
      this.simVZ.set(  simData.subarray(S_VZ       * FIELD_N, (S_VZ       + 1) * FIELD_N));
      this.simFoam.set(simData.subarray(S_FOAM     * FIELD_N, (S_FOAM     + 1) * FIELD_N));
      this.simPressure.set(simData.subarray(S_PRESSURE * FIELD_N, (S_PRESSURE + 1) * FIELD_N));

      // ── Packed textures (bytes SIM_BUF_BYTES .. end) ─────────────────────────
      // Each texture is FIELD_N u32 values = FIELD_N * 4 bytes.
      // In little-endian the u32 packs as [R, G, B, A] when read as Uint8Array.
      const packStart = SIM_BUF_BYTES;
      const packBytes = new Uint8Array(mapped, packStart, PACK_TEXTURES * FIELD_N * 4);
      this.packedBase.set(   packBytes.subarray(0             * FIELD_N * 4, 1 * FIELD_N * 4));
      this.packedDynamic.set(packBytes.subarray(1             * FIELD_N * 4, 2 * FIELD_N * 4));
      this.packedFlow.set(   packBytes.subarray(2             * FIELD_N * 4, 3 * FIELD_N * 4));
      this.packedDebug.set(  packBytes.subarray(3             * FIELD_N * 4, 4 * FIELD_N * 4));

      this._stagingBuf!.unmap();
      this._readbackInFlight = false;
      this.packedDataReady = true;
    }).catch(() => {
      // GPU device was lost or context invalidated; silently degrade to CPU path
      this._readbackInFlight = false;
    });
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────────

  dispose(): void {
    this._targetBuf?.destroy();
    this._simInBuf?.destroy();
    this._simOutBuf?.destroy();
    this._packedBuf?.destroy();
    this._paramsBuf?.destroy();
    this._stagingBuf?.destroy();
    this._targetBuf = null;
    this._simInBuf = null;
    this._simOutBuf = null;
    this._packedBuf = null;
    this._paramsBuf = null;
    this._stagingBuf = null;
    this._device = null;
    this.ready = false;
    this.packedDataReady = false;
  }
}
