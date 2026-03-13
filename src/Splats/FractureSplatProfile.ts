/**
 * FractureSplatProfile — Fase 5 Entregable 5.1
 *
 * Defines fracture particle profiles per material family.
 * Profiles dictate: splat count, ejection velocity, lifetime,
 * gravity, shape, and scale based on the material's shearStrength.
 */

import { TerrainMaterialFamily } from "../Matereials/PBR/MaterialFamilyProfiles";

export interface FractureProfile {
  /** Number of splats to emit per destroyed voxel. */
  count: number;
  /** Radial ejection speed (m/s). */
  velocity: number;
  /** Time before splat fades to zero opacity (seconds). */
  lifetime: number;
  /** Downward acceleration (m/s²). */
  gravity: number;
  /** Splat shape: 0=circular, 1=irregular, 2=angular, 3=elongated. */
  shape: number;
  /** Base splat scale (world-space radius). */
  scale: number;
  /** Upward velocity bias factor (0-1). */
  upwardBias: number;
}

/**
 * Get fracture profile for a material family.
 * Fine-tuned per family for visual fidelity — see master plan §5.1.
 */
export function getFractureProfile(family: string): FractureProfile {
  switch (family) {
    case TerrainMaterialFamily.Soil:
    case TerrainMaterialFamily.Cultivated:
      // Soft materials: many particles, slow, diffuse cloud
      return {
        count: 40,
        velocity: 2,
        lifetime: 2,
        gravity: 3,
        shape: 1, // irregular
        scale: 0.12,
        upwardBias: 0.3,
      };
    case TerrainMaterialFamily.Flora:
      // Leaves/vines: float slowly, elongated strips
      return {
        count: 30,
        velocity: 1.5,
        lifetime: 2.5,
        gravity: 2,
        shape: 3, // elongated
        scale: 0.1,
        upwardBias: 0.5,
      };
    case TerrainMaterialFamily.Wood:
      // Splinters: moderate speed, angular
      return {
        count: 20,
        velocity: 3.5,
        lifetime: 1.5,
        gravity: 5,
        shape: 2, // angular
        scale: 0.08,
        upwardBias: 0.25,
      };
    case TerrainMaterialFamily.Rock:
      // Hard fragments: fast, angular, heavy
      return {
        count: 25,
        velocity: 4,
        lifetime: 1.5,
        gravity: 6,
        shape: 2, // angular
        scale: 0.09,
        upwardBias: 0.2,
      };
    case TerrainMaterialFamily.Exotic:
      // Exotic: mid speed, circular (energy-like)
      return {
        count: 20,
        velocity: 5,
        lifetime: 1.2,
        gravity: 4,
        shape: 0, // circular
        scale: 0.07,
        upwardBias: 0.35,
      };
    default:
      return {
        count: 15,
        velocity: 3,
        lifetime: 1.5,
        gravity: 5,
        shape: 0,
        scale: 0.08,
        upwardBias: 0.25,
      };
  }
}

/**
 * Adjust profile based on raw shearStrength value.
 * Low shear → more particles, slower. High shear → fewer, faster.
 */
export function adjustProfileByShear(
  base: FractureProfile,
  shearStrength: number
): FractureProfile {
  if (shearStrength < 30) {
    // Very soft (clay, mud)
    return {
      ...base,
      count: Math.min(base.count + 15, 60),
      velocity: base.velocity * 0.7,
      gravity: base.gravity * 0.7,
    };
  }
  if (shearStrength > 200) {
    // Very hard (obsidian, deepslate)
    return {
      ...base,
      count: Math.max(base.count - 10, 10),
      velocity: base.velocity * 1.5,
      gravity: base.gravity * 1.3,
      lifetime: base.lifetime * 0.7,
    };
  }
  return base;
}
