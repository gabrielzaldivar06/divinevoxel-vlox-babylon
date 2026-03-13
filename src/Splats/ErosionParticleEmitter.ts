/**
 * ErosionParticleEmitter — R12
 *
 * Creates a BabylonJS ParticleSystem that emits ambient erosion dust at the
 * centroid of the highest-proximity vertices in a dissolving section.
 *
 * Typical workflow:
 *   1. Call getHighErosionPositions() from DissolutionSplatEmitter to get positions.
 *   2. Call createErosionDustSystem({ scene, positions, family }) to start dust.
 *   3. On section unload: ps.stop(); ps.dispose();
 */

import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import {
  TerrainMaterialFamily,
} from "../Matereials/PBR/MaterialFamilyProfiles";

// ---------------------------------------------------------------------------
// Dust colour palettes per material family
// c1 = bright/primary colour, c2 = secondary/ambient colour (both RGBA 0-1)
// ---------------------------------------------------------------------------
const DUST_COLORS: Record<
  TerrainMaterialFamily,
  {
    c1: [number, number, number, number];
    c2: [number, number, number, number];
  }
> = {
  [TerrainMaterialFamily.Rock]:      { c1: [0.78, 0.76, 0.74, 0.55], c2: [0.60, 0.58, 0.56, 0.30] },
  [TerrainMaterialFamily.Soil]:      { c1: [0.67, 0.53, 0.38, 0.50], c2: [0.52, 0.40, 0.28, 0.28] },
  [TerrainMaterialFamily.Cultivated]:{ c1: [0.55, 0.50, 0.42, 0.45], c2: [0.45, 0.40, 0.30, 0.25] },
  [TerrainMaterialFamily.Flora]:     { c1: [0.55, 0.68, 0.40, 0.40], c2: [0.42, 0.54, 0.28, 0.20] },
  [TerrainMaterialFamily.Wood]:      { c1: [0.62, 0.48, 0.32, 0.45], c2: [0.48, 0.36, 0.22, 0.22] },
  [TerrainMaterialFamily.Liquid]:    { c1: [0.55, 0.68, 0.75, 0.40], c2: [0.42, 0.54, 0.62, 0.20] },
  [TerrainMaterialFamily.Exotic]:    { c1: [0.72, 0.55, 0.88, 0.50], c2: [0.55, 0.40, 0.72, 0.28] },
  [TerrainMaterialFamily.Default]:   { c1: [0.70, 0.68, 0.66, 0.48], c2: [0.55, 0.53, 0.50, 0.26] },
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface ErosionDustOptions {
  scene: Scene;
  /** World-space erosion positions from getHighErosionPositions(). */
  positions: [number, number, number][];
  /** Material family for dust colour selection. */
  family?: TerrainMaterialFamily;
  /** Maximum simultaneous live particles (default 120). */
  capacity?: number;
  /**
   * Auto-dispose the ParticleSystem after this many milliseconds.
   * 0 (default) = never — caller is responsible for ps.stop()+ps.dispose().
   */
  autoDisposeMsec?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Per-scene cache for the minimal 1×1 white sprite used as particle texture. */
const _dotTexCache = new WeakMap<Scene, RawTexture>();

function getOrCreateDotTex(scene: Scene): RawTexture {
  let tex = _dotTexCache.get(scene);
  if (!tex) {
    tex = RawTexture.CreateRGBATexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      scene,
      false,
      false
    );
    _dotTexCache.set(scene, tex);
  }
  return tex;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates and immediately starts a BabylonJS ParticleSystem that emits soft
 * erosion dust at the centroid of the supplied world positions.
 *
 * Performance notes:
 * - emitRate is capped at 40 regardless of how many positions are supplied.
 * - BLENDMODE_ADD is used so distant particles remain cheap.
 * - The system holds at most `capacity` live particles (default 120).
 *
 * @returns The running ParticleSystem.
 */
export function createErosionDustSystem(options: ErosionDustOptions): ParticleSystem {
  const {
    scene,
    positions,
    family = TerrainMaterialFamily.Default,
    capacity = 120,
    autoDisposeMsec = 0,
  } = options;

  // Centroid of all erosion positions
  let cx = 0, cy = 0, cz = 0;
  for (const [x, y, z] of positions) { cx += x; cy += y; cz += z; }
  const n = Math.max(positions.length, 1);
  cx /= n; cy /= n; cz /= n;

  const ps = new ParticleSystem("erosionDust", capacity, scene);
  ps.particleTexture = getOrCreateDotTex(scene);

  // Sphere emitter centred on the erosion zone; radius scales with zone spread
  ps.emitter = new Vector3(cx, cy, cz);
  ps.createSphereEmitter(Math.max(positions.length * 0.04, 0.3), 1.0);

  // Dust colours from material family palette
  const palette = DUST_COLORS[family] ?? DUST_COLORS[TerrainMaterialFamily.Default];
  ps.color1    = new Color4(...palette.c1);
  ps.color2    = new Color4(...palette.c2);
  ps.colorDead = new Color4(palette.c2[0], palette.c2[1], palette.c2[2], 0.0);

  // Fine dust: very small, moderately-lived
  ps.minSize     = 0.02;
  ps.maxSize     = 0.08;
  ps.minLifeTime = 0.8;
  ps.maxLifeTime = 2.5;

  // Rate capped to avoid GPU pressure from highly-eroded sections
  ps.emitRate = Math.min(Math.ceil(positions.length * 0.8), 40);

  // Slow upward drift — dust floats away from the cracked mineral surface
  ps.gravity      = new Vector3(0, 0.25, 0);
  ps.minEmitPower = 0.05;
  ps.maxEmitPower = 0.18;
  ps.updateSpeed  = 0.025;

  // Additive blending: dusty glow at crack edges, near-zero cost when sparse
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;

  ps.start();

  if (autoDisposeMsec > 0) {
    setTimeout(() => {
      ps.stop();
      // Give lingering particles time to fade before full dispose
      setTimeout(() => ps.dispose(), 3500);
    }, autoDisposeMsec);
  }

  return ps;
}
