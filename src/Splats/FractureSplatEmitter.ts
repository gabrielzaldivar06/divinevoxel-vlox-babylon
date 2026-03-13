/**
 * FractureSplatEmitter — Fase 5 Entregable 5.2, 5.8
 *
 * Generates dynamic fracture splats when a voxel is destroyed.
 * Input: voxel position + material family + color.
 * Output: DynamicSplatInstance[] with velocity/lifetime for physics.
 *
 * Shape variation (Entregable 5.8): soil=irregular, rock=angular,
 * flora=elongated strips that float.
 */

import { SplatInstance } from "./DVEGaussianSplatRenderer";
import {
  FractureProfile,
  getFractureProfile,
  adjustProfileByShear,
} from "./FractureSplatProfile";

/** Dynamic splat extends SplatInstance with physics. */
export interface DynamicSplatInstance extends SplatInstance {
  /** Velocity [vx, vy, vz] m/s. */
  velocity: [number, number, number];
  /** Total lifetime in seconds. */
  lifetime: number;
  /** Current age in seconds (starts at 0). */
  age: number;
  /** Gravity acceleration m/s². */
  gravity: number;
  /** Original opacity (for fade calculation). */
  baseOpacity: number;
}

// Deterministic-ish random from position seed
function hashSeed(x: number, y: number, z: number, i: number): number {
  let h = (x * 73856093) ^ (y * 19349669) ^ (z * 83492791) ^ (i * 45678901);
  h = ((h >> 16) ^ h) * 0x45d9f3b;
  h = ((h >> 16) ^ h) * 0x45d9f3b;
  h = (h >> 16) ^ h;
  return (h & 0x7fffffff) / 0x7fffffff; // 0..1
}

/**
 * Emit fracture splats for a destroyed voxel.
 *
 * @param x World X of destroyed voxel
 * @param y World Y of destroyed voxel
 * @param z World Z of destroyed voxel
 * @param family Material family string (TerrainMaterialFamily value)
 * @param shearStrength Physics shear strength
 * @param color RGB [0-255] color of the voxel
 */
export function emitFractureSplats(
  x: number,
  y: number,
  z: number,
  family: string,
  shearStrength: number,
  color: [number, number, number]
): DynamicSplatInstance[] {
  const baseProfile = getFractureProfile(family);
  const profile = adjustProfileByShear(baseProfile, shearStrength);

  const splats: DynamicSplatInstance[] = [];
  const cx = x + 0.5; // Center of voxel
  const cy = y + 0.5;
  const cz = z + 0.5;

  for (let i = 0; i < profile.count; i++) {
    const r0 = hashSeed(x, y, z, i * 7 + 0);
    const r1 = hashSeed(x, y, z, i * 7 + 1);
    const r2 = hashSeed(x, y, z, i * 7 + 2);
    const r3 = hashSeed(x, y, z, i * 7 + 3);
    const r4 = hashSeed(x, y, z, i * 7 + 4);
    const r5 = hashSeed(x, y, z, i * 7 + 5);

    // Random position within the voxel volume
    const px = cx + (r0 - 0.5) * 0.8;
    const py = cy + (r1 - 0.5) * 0.8;
    const pz = cz + (r2 - 0.5) * 0.8;

    // Radial velocity: outward from center + upward bias
    const theta = r3 * Math.PI * 2;
    const phi = r4 * Math.PI;
    const speed = profile.velocity * (0.5 + r5 * 0.5);
    const sinPhi = Math.sin(phi);
    const vx = Math.cos(theta) * sinPhi * speed;
    const vy =
      Math.abs(Math.cos(phi)) * speed * (1 + profile.upwardBias) -
      speed * 0.1;
    const vz = Math.sin(theta) * sinPhi * speed;

    // Color variation: ±15 per channel
    const colorVar = 15;
    const cr = Math.max(0, Math.min(255, color[0] + (r0 - 0.5) * colorVar * 2));
    const cg = Math.max(0, Math.min(255, color[1] + (r1 - 0.5) * colorVar * 2));
    const cb = Math.max(0, Math.min(255, color[2] + (r2 - 0.5) * colorVar * 2));

    // Scale variation: ±30%
    const scale = profile.scale * (0.7 + r3 * 0.6);

    // Opacity: 0.6-1.0
    const opacity = 0.6 + r4 * 0.4;

    splats.push({
      position: [px, py, pz],
      scale,
      opacity,
      color: [cr, cg, cb],
      shape: profile.shape,
      velocity: [vx, vy, vz],
      lifetime: profile.lifetime * (0.7 + r5 * 0.6),
      age: 0,
      gravity: profile.gravity,
      baseOpacity: opacity,
    });
  }

  return splats;
}
