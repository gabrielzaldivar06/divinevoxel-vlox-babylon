/**
 * DissolutionSplatEmitter — Fase 3 Entregable 3.1, 3.2, 3.5, 3.8
 *
 * Scans a section's vertex buffer (stride 28) for sub-vertices with high
 * dissolutionProximity (padding[3] > threshold). For each candidate it emits
 * a SplatInstance that inherits the texel color at that UV position,
 * is sized by porosity, and faded by proximity.
 *
 * Physics-driven spread: adhesion controls extra splats beyond the voxel
 * edge. Drip splats: for adhesion > 0.7 on downward faces, vertical chains
 * of splats simulate goteo.
 */

import { SplatInstance } from "./DVEGaussianSplatRenderer";
import {
  classifyTerrainMaterial,
  TerrainMaterialFamily,
} from "../Matereials/PBR/MaterialFamilyProfiles";

/** Per-material physics data needed for splat emission. */
export interface SplatPhysics {
  adhesion: number;
  porosity: number;
  shearStrength: number;
}

// Vertex layout constants (stride 28 floats)
const STRIDE = 28;
const POS_X = 0;
const POS_Y = 1;
const POS_Z = 2;
const DISSOLUTION_PROXIMITY = 3; // padding[3]
const NORMAL_X = 4;
const NORMAL_Y = 5;
const NORMAL_Z = 6;
const TEX_INDEX_X = 8;
const UV_U = 12;
const UV_V = 13;
const WORLD_CTX_R = 14; // worldContext — used as color fallback
const WORLD_CTX_G = 15;
const WORLD_CTX_B = 16;

const PROXIMITY_THRESHOLD = 0.35;
const MAX_SPLATS_PER_SECTION = 800;
const NORMAL_OFFSET = 0.05;

/**
 * Determine the splat shapeType from the material family.
 *  0 = circular (default)
 *  1 = irregular (soil)
 *  2 = angular (rock)
 *  3 = elongated (flora)
 */
function shapeForFamily(family: string): number {
  switch (family) {
    case TerrainMaterialFamily.Soil:
      return 1;
    case TerrainMaterialFamily.Rock:
      return 2;
    case TerrainMaterialFamily.Flora:
      return 3;
    default:
      return 0;
  }
}

/**
 * Attempt to sample the texel color from the atlas canvas.
 * If no atlas is available or sampling fails, returns null so the caller
 * can use the worldContext fallback.
 */
let _atlasCanvas: HTMLCanvasElement | null = null;
let _atlasCtx: CanvasRenderingContext2D | null = null;
let _atlasWidth = 0;
let _atlasHeight = 0;

export function setAtlasSource(canvas: HTMLCanvasElement) {
  _atlasCanvas = canvas;
  _atlasCtx = canvas.getContext("2d", { willReadFrequently: true });
  _atlasWidth = canvas.width;
  _atlasHeight = canvas.height;
}

function sampleAtlasColor(
  u: number,
  v: number,
  _textureIndex: number
): [number, number, number] | null {
  if (!_atlasCtx || !_atlasWidth) return null;
  const px = Math.min(Math.floor(u * _atlasWidth), _atlasWidth - 1);
  const py = Math.min(Math.floor((1 - v) * _atlasHeight), _atlasHeight - 1);
  const pixel = _atlasCtx.getImageData(px, py, 1, 1).data;
  return [pixel[0], pixel[1], pixel[2]];
}

export interface EmitOptions {
  /** World-space offset for the section (location x, y, z). */
  sectionOrigin: [number, number, number];
  /** Material string id (e.g. "dve_dirt"). */
  materialId: string;
  /** Per-material physics. Null → skip physics-driven spread / drip. */
  physics: SplatPhysics | null;
}

/**
 * Emit splats from a vertex buffer.
 * Returns an array of SplatInstance capped at MAX_SPLATS_PER_SECTION.
 */
export function emitDissolutionSplats(
  vertices: Float32Array,
  options: EmitOptions
): SplatInstance[] {
  const classification = classifyTerrainMaterial(options.materialId);

  // Skip materials that should NOT generate dissolution splats
  if (classification.isLiquid || classification.isTransparent) return [];

  const family = classification.family;
  const shape = shapeForFamily(family);

  const vertexCount = (vertices.length / STRIDE) | 0;
  const [ox, oy, oz] = options.sectionOrigin;

  const adhesion = options.physics?.adhesion ?? 0;
  const porosity = options.physics?.porosity ?? 0;

  // Collect candidates with their dissolutionProximity for budget sorting
  type Candidate = {
    px: number;
    py: number;
    pz: number;
    nx: number;
    ny: number;
    nz: number;
    proximity: number;
    color: [number, number, number];
    porosity: number;
    shape: number;
  };

  const candidates: Candidate[] = [];

  for (let i = 0; i < vertexCount; i++) {
    const base = i * STRIDE;
    const proximity = vertices[base + DISSOLUTION_PROXIMITY];
    if (proximity < PROXIMITY_THRESHOLD) continue;

    // World position
    const px = vertices[base + POS_X] + ox;
    const py = vertices[base + POS_Y] + oy;
    const pz = vertices[base + POS_Z] + oz;

    // Normal
    const nx = vertices[base + NORMAL_X];
    const ny = vertices[base + NORMAL_Y];
    const nz = vertices[base + NORMAL_Z];

    // Color: try atlas, fallback to worldContext
    const u = vertices[base + UV_U];
    const v = vertices[base + UV_V];
    const texIdx = vertices[base + TEX_INDEX_X];
    let color = sampleAtlasColor(u, v, texIdx);
    if (!color) {
      // Fallback: use worldContext as rough color (0-1 → 0-255)
      color = [
        Math.min(255, Math.max(0, (vertices[base + WORLD_CTX_R] * 255) | 0)),
        Math.min(255, Math.max(0, (vertices[base + WORLD_CTX_G] * 255) | 0)),
        Math.min(255, Math.max(0, (vertices[base + WORLD_CTX_B] * 255) | 0)),
      ];
    }

    candidates.push({
      px,
      py,
      pz,
      nx,
      ny,
      nz,
      proximity,
      color,
      porosity,
      shape,
    });
  }

  // Budget enforcement: sort descending by proximity, trim
  if (candidates.length > MAX_SPLATS_PER_SECTION) {
    candidates.sort((a, b) => b.proximity - a.proximity);
    candidates.length = MAX_SPLATS_PER_SECTION;
  }

  const splats: SplatInstance[] = [];
  const dripBudget = MAX_SPLATS_PER_SECTION - candidates.length;
  let dripCount = 0;

  for (const c of candidates) {
    // Base splat — slightly outside the surface
    const scale = 0.2 + c.porosity * 0.3;
    const opacity = 1.0 - c.proximity;

    splats.push({
      position: [
        c.px + c.nx * NORMAL_OFFSET,
        c.py + c.ny * NORMAL_OFFSET,
        c.pz + c.nz * NORMAL_OFFSET,
      ],
      scale,
      opacity: Math.max(0.05, opacity),
      color: c.color,
      shape: c.shape,
      normal: [c.nx, c.ny, c.nz], // G03: pass through vertex normal for per-splat N·L
    });

    // Physics spread: adhesion pushes splats further out
    if (adhesion > 0.3) {
      const extraSpread = adhesion * 0.3;
      splats.push({
        position: [
          c.px + c.nx * (NORMAL_OFFSET + extraSpread),
          c.py + c.ny * (NORMAL_OFFSET + extraSpread),
          c.pz + c.nz * (NORMAL_OFFSET + extraSpread),
        ],
        scale: scale * 0.7,
        opacity: Math.max(0.05, opacity * 0.6),
        color: c.color,
        shape: c.shape,
        normal: [c.nx, c.ny, c.nz], // G03
      });
    }

    // Drip splats: adhesion > 0.7 on downward faces
    if (adhesion > 0.7 && c.ny < -0.5 && dripCount < dripBudget) {
      const dripLength = Math.min(
        3,
        Math.floor((adhesion - 0.7) * 10)
      );
      for (let d = 1; d <= dripLength && dripCount < dripBudget; d++) {
        const t = d / (dripLength + 1);
        splats.push({
          position: [c.px, c.py - d * 0.15, c.pz],
          scale: scale * (1.0 - t),
          opacity: Math.max(0.05, opacity * (1.0 - t * 0.5)),
          color: c.color,
          shape: 1, // irregular for drips
          normal: [0, -1, 0], // G03: drips face downward
        });
        dripCount++;
      }
    }

    // R18: Grass blade billboards for top-facing flora vertices.
    // Uses a deterministic per-position seed to avoid emitting blades on every vertex.
    const bladeSeed = Math.abs(Math.sin(c.px * 3.7 + c.py * 5.1 + c.pz * 2.9)) % 1.0;
    if (
      classification.isFlora &&
      c.ny > 0.7 &&
      bladeSeed < 0.20 &&
      splats.length < MAX_SPLATS_PER_SECTION - 6
    ) {
      for (let b = 0; b < 6; b++) {
        const theta = (b / 6) * Math.PI * 2;
        const r = 0.08 + (b % 3) * 0.06;
        splats.push({
          position: [
            c.px + Math.cos(theta) * r,
            c.py + 0.08,
            c.pz + Math.sin(theta) * r,
          ],
          scale: 0.15 + b * 0.022,
          opacity: 0.72,
          color: c.color,
          shape: 4, // R18: blade shape
          normal: [0, 1, 0],
        });
      }
    }
  }

  // Final budget cap (spread + drips could exceed)
  if (splats.length > MAX_SPLATS_PER_SECTION) {
    splats.length = MAX_SPLATS_PER_SECTION;
  }

  return splats;
}

/**
 * R12: Collect the top-N highest-erosion world positions from a vertex buffer.
 * Used by ErosionParticleEmitter to spawn ambient dust at active erosion zones.
 * @param vertices - Section vertex buffer (stride 28)
 * @param sectionOrigin - World-space offset [x, y, z]
 * @param maxCount - Maximum positions to return (default 30)
 */
export function getHighErosionPositions(
  vertices: Float32Array,
  sectionOrigin: [number, number, number],
  maxCount = 30
): [number, number, number][] {
  const [ox, oy, oz] = sectionOrigin;
  const vertexCount = (vertices.length / STRIDE) | 0;

  // Collect candidates above threshold sorted by proximity
  const candidates: { pos: [number, number, number]; prox: number }[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const base = i * STRIDE;
    const proximity = vertices[base + DISSOLUTION_PROXIMITY];
    if (proximity < PROXIMITY_THRESHOLD) continue;
    candidates.push({
      pos: [
        vertices[base + POS_X] + ox,
        vertices[base + POS_Y] + oy,
        vertices[base + POS_Z] + oz,
      ],
      prox: proximity,
    });
  }

  candidates.sort((a, b) => b.prox - a.prox);
  if (candidates.length > maxCount) candidates.length = maxCount;
  return candidates.map((c) => c.pos);
}
