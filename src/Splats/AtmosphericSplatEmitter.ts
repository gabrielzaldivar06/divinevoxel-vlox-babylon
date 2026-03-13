/**
 * AtmosphericSplatEmitter — Stretch Goal S1
 *
 * Emits ambient atmospheric splats (dust, spores, mineral haze, energy wisps)
 * in the air surrounding dissolution zones. These are static splats that float
 * near organic surface boundaries, creating depth and atmosphere.
 *
 * Particles are:
 *  - Positioned using seeded random around high-dissolution vertices
 *  - Offset from the surface into the air (normal direction + random spread)
 *  - Very small (0.01–0.06 scale) and transparent (0.05–0.35 opacity)
 *  - Per-family styled: soil→dust, flora→spores, rock→mineral dust, exotic→wisps
 *  - Altitude-biased: density varies with world Y
 */

import { SplatInstance } from "./DVEGaussianSplatRenderer";
import {
  classifyTerrainMaterial,
  TerrainMaterialFamily,
} from "../Matereials/PBR/MaterialFamilyProfiles";

// Vertex buffer layout (stride 28)
const STRIDE = 28;
const POS_X = 0;
const POS_Y = 1;
const POS_Z = 2;
const DISSOLUTION_PROXIMITY = 3;
const NORMAL_X = 4;
const NORMAL_Y = 5;
const NORMAL_Z = 6;
const WORLD_CTX_R = 14;
const WORLD_CTX_G = 15;
const WORLD_CTX_B = 16;

const PROXIMITY_THRESHOLD = 0.4;
const MAX_ATMOSPHERIC_PER_SECTION = 30;

/** Per-family atmospheric profile. */
interface AtmosphericProfile {
  /** Max splats emitted per qualifying section. */
  maxCount: number;
  /** Base particle scale range [min, max]. */
  scaleRange: [number, number];
  /** Base opacity range [min, max]. */
  opacityRange: [number, number];
  /** How far from the surface particles float [min, max] in voxel units. */
  floatRange: [number, number];
  /** Lateral scatter radius in voxel units. */
  lateralSpread: number;
  /** Splat shape (0=circular, 1=irregular, 3=elongated). */
  shape: number;
  /** RGB tint applied to the base color [0–255]. */
  tint: [number, number, number];
  /** Altitude density curve: [optimal_Y, falloff]. Higher falloff = narrower band. */
  altitudeCurve: [number, number];
}

function getAtmosphericProfile(family: string): AtmosphericProfile {
  switch (family) {
    case TerrainMaterialFamily.Soil:
    case TerrainMaterialFamily.Cultivated:
      return {
        maxCount: 12,
        scaleRange: [0.02, 0.05],
        opacityRange: [0.08, 0.25],
        floatRange: [0.3, 1.5],
        lateralSpread: 0.8,
        shape: 1, // irregular dust
        tint: [180, 160, 130],
        altitudeCurve: [30, 0.02], // ground-level preference
      };
    case TerrainMaterialFamily.Flora:
      return {
        maxCount: 18,
        scaleRange: [0.015, 0.04],
        opacityRange: [0.06, 0.2],
        floatRange: [0.5, 2.0],
        lateralSpread: 1.2,
        shape: 0, // circular spores/pollen
        tint: [200, 220, 150],
        altitudeCurve: [50, 0.015], // canopy-level preference
      };
    case TerrainMaterialFamily.Rock:
      return {
        maxCount: 6,
        scaleRange: [0.01, 0.03],
        opacityRange: [0.05, 0.15],
        floatRange: [0.2, 1.0],
        lateralSpread: 0.5,
        shape: 2, // angular mineral dust
        tint: [160, 160, 170],
        altitudeCurve: [20, 0.01], // low/cavern
      };
    case TerrainMaterialFamily.Wood:
      return {
        maxCount: 8,
        scaleRange: [0.02, 0.04],
        opacityRange: [0.07, 0.2],
        floatRange: [0.3, 1.2],
        lateralSpread: 0.6,
        shape: 3, // elongated sawdust
        tint: [170, 140, 100],
        altitudeCurve: [40, 0.02],
      };
    case TerrainMaterialFamily.Exotic:
      return {
        maxCount: 10,
        scaleRange: [0.03, 0.06],
        opacityRange: [0.12, 0.35],
        floatRange: [0.5, 2.5],
        lateralSpread: 1.5,
        shape: 0, // circular wisps
        tint: [180, 140, 220],
        altitudeCurve: [40, 0.008], // broad altitude range
      };
    default:
      return {
        maxCount: 5,
        scaleRange: [0.02, 0.04],
        opacityRange: [0.06, 0.18],
        floatRange: [0.3, 1.2],
        lateralSpread: 0.6,
        shape: 0,
        tint: [180, 180, 180],
        altitudeCurve: [30, 0.02],
      };
  }
}

/**
 * Deterministic hash for seeded random per-vertex atmospheric offset.
 * Returns pseudo-random float in [0, 1).
 */
function hashSeed(a: number, b: number, c: number, salt: number): number {
  let h = ((a * 73856093) ^ (b * 19349663) ^ (c * 83492791) ^ (salt * 56843531)) | 0;
  h = ((h >> 13) ^ h);
  h = (h * (h * h * 15731 + 789221) + 1376312589) | 0;
  return (h & 0x7fffffff) / 0x7fffffff;
}

/**
 * Altitude density multiplier: Gaussian falloff around optimal Y.
 */
function altitudeDensity(worldY: number, optimalY: number, falloff: number): number {
  const dy = worldY - optimalY;
  return Math.exp(-dy * dy * falloff);
}

export interface AtmosphericEmitOptions {
  sectionOrigin: [number, number, number];
  materialId: string;
}

/**
 * Scan a vertex buffer and emit atmospheric ambient splats around dissolution zones.
 */
export function emitAtmosphericSplats(
  vertices: Float32Array,
  options: AtmosphericEmitOptions
): SplatInstance[] {
  const classification = classifyTerrainMaterial(options.materialId);
  if (classification.isLiquid || classification.isTransparent) return [];

  const profile = getAtmosphericProfile(classification.family);
  const vertexCount = (vertices.length / STRIDE) | 0;
  const [ox, oy, oz] = options.sectionOrigin;

  // Collect candidate vertices in the dissolution zone
  type Candidate = {
    wx: number;
    wy: number;
    wz: number;
    nx: number;
    ny: number;
    nz: number;
    proximity: number;
    colorR: number;
    colorG: number;
    colorB: number;
  };

  const candidates: Candidate[] = [];

  for (let i = 0; i < vertexCount; i++) {
    const base = i * STRIDE;
    const proximity = vertices[base + DISSOLUTION_PROXIMITY];
    if (proximity < PROXIMITY_THRESHOLD) continue;

    candidates.push({
      wx: vertices[base + POS_X] + ox,
      wy: vertices[base + POS_Y] + oy,
      wz: vertices[base + POS_Z] + oz,
      nx: vertices[base + NORMAL_X],
      ny: vertices[base + NORMAL_Y],
      nz: vertices[base + NORMAL_Z],
      proximity,
      colorR: Math.min(255, Math.max(0, (vertices[base + WORLD_CTX_R] * 255) | 0)),
      colorG: Math.min(255, Math.max(0, (vertices[base + WORLD_CTX_G] * 255) | 0)),
      colorB: Math.min(255, Math.max(0, (vertices[base + WORLD_CTX_B] * 255) | 0)),
    });
  }

  if (candidates.length === 0) return [];

  // Subsample candidates deterministically to stay within budget
  const maxSplats = Math.min(profile.maxCount, MAX_ATMOSPHERIC_PER_SECTION);
  const step = Math.max(1, Math.floor(candidates.length / maxSplats));

  const splats: SplatInstance[] = [];
  const [optY, falloff] = profile.altitudeCurve;

  for (let ci = 0; ci < candidates.length && splats.length < maxSplats; ci += step) {
    const c = candidates[ci];

    // Altitude-based density: skip some particles at non-optimal heights
    const altDensity = altitudeDensity(c.wy, optY, falloff);
    const r0 = hashSeed(c.wx | 0, c.wy | 0, c.wz | 0, 0);
    if (r0 > altDensity * 0.8 + 0.2) continue;

    // Random offsets for position
    const r1 = hashSeed(c.wx | 0, c.wy | 0, c.wz | 0, 1);
    const r2 = hashSeed(c.wx | 0, c.wy | 0, c.wz | 0, 2);
    const r3 = hashSeed(c.wx | 0, c.wy | 0, c.wz | 0, 3);
    const r4 = hashSeed(c.wx | 0, c.wy | 0, c.wz | 0, 4);
    const r5 = hashSeed(c.wx | 0, c.wy | 0, c.wz | 0, 5);

    // Float distance from surface along normal
    const floatDist =
      profile.floatRange[0] +
      r1 * (profile.floatRange[1] - profile.floatRange[0]);

    // Lateral scatter (perpendicular to normal)
    const theta = r2 * Math.PI * 2;
    const lateralR = r3 * profile.lateralSpread;

    // Build a rough tangent from normal
    const absNx = Math.abs(c.nx);
    const absNy = Math.abs(c.ny);
    let tx: number, ty: number, tz: number;
    if (absNx < absNy) {
      // tangent = cross(normal, X)
      tx = 0;
      ty = -c.nz;
      tz = c.ny;
    } else {
      // tangent = cross(normal, Y)
      tx = c.nz;
      ty = 0;
      tz = -c.nx;
    }
    const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tLen;
    ty /= tLen;
    tz /= tLen;

    // Bitangent = cross(normal, tangent)
    const bx = c.ny * tz - c.nz * ty;
    const by = c.nz * tx - c.nx * tz;
    const bz = c.nx * ty - c.ny * tx;

    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    const px =
      c.wx +
      c.nx * floatDist +
      (tx * cosT + bx * sinT) * lateralR;
    const py =
      c.wy +
      c.ny * floatDist +
      (ty * cosT + by * sinT) * lateralR;
    const pz =
      c.wz +
      c.nz * floatDist +
      (tz * cosT + bz * sinT) * lateralR;

    // Scale and opacity from profile ranges
    const scale =
      profile.scaleRange[0] +
      r4 * (profile.scaleRange[1] - profile.scaleRange[0]);
    const opacity =
      profile.opacityRange[0] +
      r5 * (profile.opacityRange[1] - profile.opacityRange[0]);

    // Color: blend surface color with family tint (70% tint, 30% surface)
    const color: [number, number, number] = [
      Math.min(255, ((profile.tint[0] * 0.7 + c.colorR * 0.3) | 0)),
      Math.min(255, ((profile.tint[1] * 0.7 + c.colorG * 0.3) | 0)),
      Math.min(255, ((profile.tint[2] * 0.7 + c.colorB * 0.3) | 0)),
    ];

    splats.push({
      position: [px, py, pz],
      scale: scale * (0.5 + altDensity * 0.5),
      opacity: opacity * altDensity,
      color,
      shape: profile.shape,
    });
  }

  return splats;
}
