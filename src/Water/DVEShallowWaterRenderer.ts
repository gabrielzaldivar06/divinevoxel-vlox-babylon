/**
 * DVEShallowWaterRenderer — Fase 2 (terrain-adaptive)
 *
 * Babylon.js mesh renderer for the ShallowWaterLayer.
 * Consumes ShallowWaterGPUData packed by ShallowWaterGPUDataPacker.
 *
 * Design (AAA-style terrain-conforming):
 *  - One Mesh per active section (16×16 columns → surface + shoreline quads).
 *  - Vertex Y = surfaceY (water table), horizontal and correct.
 *  - Wave amplitude ∝ depth (= thickness) — zero at shoreline, full in deep water.
 *  - Shore proximity (shoreDist, packed [9]) drives foam, wave falloff, alpha.
 *  - Shoreline stitching: for each column edge bordering land, emit a quad that
 *    descends from waterSurfaceY to terrainBottomY, matching the actual slope.
 *  - Normals finite-differenced over the surface heightfield.
 *  - Field offsets (SHALLOW_COLUMN_STRIDE=10):
 *    [0]=thickness [1]=surfaceY [2]=terrainBottomY [3]=spreadVX [4]=spreadVZ
 *    [5]=settled [6]=adhesion [7]=age [8]=emitterId [9]=shoreDist
 */
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Meshes/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";

import {
  type ShallowWaterGPUData,
  SHALLOW_COLUMN_STRIDE,
  decodeShallowColumnMetadata,
} from "@divinevoxel/vlox/Water/Shallow/ShallowWaterGPUDataPacker.js";

// ─────────────────────────────────────────────────────────────────
// Constants — visual tuning
// ─────────────────────────────────────────────────────────────────

/** Wet-film micro-ripple amplitude (world units). Visible movement without crashing waves. */
const RIPPLE_AMPLITUDE = 0.024;
/** Wave frequency (world units → radians). */
const RIPPLE_FREQ = 1.6;
/** Wave speed (radians per second). Perceptible gentle flow. */
const WAVE_SPEED = 1.35;
/** Minimum thickness (world units) below which a column is invisible. */
const MIN_VISIBLE_THICKNESS = 0.008;
/** Minimum ambient ripple amplitude for fully-settled pools (keeps the surface alive). */
const AMBIENT_RIPPLE_FRACTION = 0.28;

// ─── Multi-octave Gerstner ripple parameters ───────────────────
// 3 wave octaves: direction (dx,dz), frequency, amplitude, speed
const GERSTNER_WAVES = [
  { dx: 0.6, dz: 0.8, freq: 2.4, amp: 0.018, speed: 1.1 },
  { dx: -0.4, dz: 0.9, freq: 3.8, amp: 0.010, speed: 1.6 },
  { dx: 0.9, dz: -0.3, freq: 5.6, amp: 0.005, speed: 2.3 },
];

// ─── Beer-Lambert absorption coefficients (per world unit of depth) ──
// Tuned for small puddles: red absorbs fastest, blue slowest
const ABSORB_R = 2.8;
const ABSORB_G = 0.9;
const ABSORB_B = 0.4;

// ─── Fresnel approximation (Schlick) ──
// n1=1.0 (air), n2=1.33 (water) → F0 = ((1.33-1)/(1.33+1))^2 ≈ 0.02
const FRESNEL_F0 = 0.02;

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

type SectionRecord = {
  key: string;
  mesh: Mesh;
  gpuData: ShallowWaterGPUData;
  pendingDispose: boolean;
  lastUpdatedAt: number;
  /** Pre-allocated vertex buffers for updateVerticesData path (fixed topology). */
  posArr: Float32Array;
  norArr: Float32Array;
  uvArr: Float32Array;
  colArr: Float32Array;
  /** Whether applyToMesh (initial build) has been done. */
  initialized: boolean;
};

// ─────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/**
 * Sample the surfaceY of the 4 nearest column centers to vertex (x, z),
 * then bilinearly interpolate.
 * Vertex grid is (sizeX+1) × (sizeZ+1); the extra row/column extends the
 * boundary by mirroring the nearest column.
 */
function sampleSurfaceY(
  cb: Float32Array,
  sizeX: number,
  sizeZ: number,
  gx: number,
  gz: number,
): number {
  // clamp to column grid
  const cx0 = Math.max(0, Math.min(sizeX - 1, gx));
  const cz0 = Math.max(0, Math.min(sizeZ - 1, gz));
  const cx1 = Math.min(sizeX - 1, cx0 + 1);
  const cz1 = Math.min(sizeZ - 1, cz0 + 1);
  const tx = gx - cx0;
  const tz = gz - cz0;
  const s = SHALLOW_COLUMN_STRIDE;
  const y00 = cb[(cz0 * sizeX + cx0) * s + 1];
  const y10 = cb[(cz0 * sizeX + cx1) * s + 1];
  const y01 = cb[(cz1 * sizeX + cx0) * s + 1];
  const y11 = cb[(cz1 * sizeX + cx1) * s + 1];
  return lerp(lerp(y00, y10, tx), lerp(y01, y11, tx), tz);
}

function sampleTerrainBottomY(
  cb: Float32Array,
  sizeX: number,
  sizeZ: number,
  gx: number,
  gz: number,
): number {
  const cx0 = Math.max(0, Math.min(sizeX - 1, gx));
  const cz0 = Math.max(0, Math.min(sizeZ - 1, gz));
  const cx1 = Math.min(sizeX - 1, cx0 + 1);
  const cz1 = Math.min(sizeZ - 1, cz0 + 1);
  const tx = gx - cx0;
  const tz = gz - cz0;
  const s = SHALLOW_COLUMN_STRIDE;
  const y00 = cb[(cz0 * sizeX + cx0) * s + 2];
  const y10 = cb[(cz0 * sizeX + cx1) * s + 2];
  const y01 = cb[(cz1 * sizeX + cx0) * s + 2];
  const y11 = cb[(cz1 * sizeX + cx1) * s + 2];
  return lerp(lerp(y00, y10, tx), lerp(y01, y11, tx), tz);
}

function sampleShoreDist(
  cb: Float32Array,
  sizeX: number,
  sizeZ: number,
  gx: number,
  gz: number,
): number {
  const cx0 = Math.max(0, Math.min(sizeX - 1, gx));
  const cz0 = Math.max(0, Math.min(sizeZ - 1, gz));
  const cx1 = Math.min(sizeX - 1, cx0 + 1);
  const cz1 = Math.min(sizeZ - 1, cz0 + 1);
  const tx = gx - cx0;
  const tz = gz - cz0;
  const s = SHALLOW_COLUMN_STRIDE;
  const f00 = cb[(cz0 * sizeX + cx0) * s + 9];
  const f10 = cb[(cz0 * sizeX + cx1) * s + 9];
  const f01 = cb[(cz1 * sizeX + cx0) * s + 9];
  const f11 = cb[(cz1 * sizeX + cx1) * s + 9];
  return lerp(lerp(f00, f10, tx), lerp(f01, f11, tx), tz);
}

/** Generic bilinear sampler for any packed float field by stride offset. */
function sampleField(
  cb: Float32Array,
  sizeX: number,
  sizeZ: number,
  gx: number,
  gz: number,
  fieldOffset: number,
): number {
  const cx0 = Math.max(0, Math.min(sizeX - 1, gx));
  const cz0 = Math.max(0, Math.min(sizeZ - 1, gz));
  const cx1 = Math.min(sizeX - 1, cx0 + 1);
  const cz1 = Math.min(sizeZ - 1, cz0 + 1);
  const tx = gx - cx0;
  const tz = gz - cz0;
  const s = SHALLOW_COLUMN_STRIDE;
  const f00 = cb[(cz0 * sizeX + cx0) * s + fieldOffset];
  const f10 = cb[(cz0 * sizeX + cx1) * s + fieldOffset];
  const f01 = cb[(cz1 * sizeX + cx0) * s + fieldOffset];
  const f11 = cb[(cz1 * sizeX + cx1) * s + fieldOffset];
  return lerp(lerp(f00, f10, tx), lerp(f01, f11, tx), tz);
}

// ─────────────────────────────────────────────────────────────────
// Renderer class
// ─────────────────────────────────────────────────────────────────

/**
 * Base URL for water texture assets. Matches the path used by InitDVEBRPBR.
 * Falls back gracefully if the texture cannot be loaded.
 */
const WATER_NORMAL_PATH = "assets/water/water-001-normal.jpg";

/** How fast the normal-map UV scrolls per unit of spread velocity (world units/s → UV units/s). */
const NORMAL_SCROLL_RATE = 0.018;
/** Minimum ambient UV drift speed so settled pools never have a frozen normal-map. */
const NORMAL_AMBIENT_DRIFT = 0.004;

export class DVEShallowWaterRenderer {
  private readonly sections = new Map<string, SectionRecord>();
  private readonly material: PBRMaterial;
  /** Primary scrolling normal-map layer. */
  private normalTex: Texture | null = null;
  private time = 0;
  private disposed = false;

  /** Columns currently in handoff fade-out. Key = "worldX,worldZ", value = fade progress 0→1 */
  private readonly handoffFades = new Map<string, number>();

  /** Duration (seconds) of the crossfade between Layer F and Layer B */
  private static readonly HANDOFF_FADE_DURATION = 1.5;

  /** Begin fading out a column that has been handed off to Layer B */
  beginHandoffFade(worldX: number, worldZ: number): void {
    this.handoffFades.set(`${worldX},${worldZ}`, 0);
  }
  /** Accumulated UV offsets for the normal-map. */
  private uvOffU1 = 0;
  private uvOffV1 = 0;
  /** Second normal layer for dual-scroll detail. */
  private normalTex2: Texture | null = null;
  private uvOffU2 = 0;
  private uvOffV2 = 0;

  /** Cached camera position for Fresnel computation in _rebuildSection. */
  private camX = 0;
  private camY = 10;
  private camZ = 0;

  constructor(private readonly scene: Scene) {
    const mat = new PBRMaterial("dve_shallow_water_material", scene);
    // ── WaterBall-inspired realistic puddle material ──────────────────
    // Base colour: deep teal — Beer-Lambert vertex colors override per-pixel
    mat.albedoColor = new Color3(0.18, 0.42, 0.56);
    // Subtle emissive so shallow water is visible in shadow
    mat.emissiveColor = new Color3(0.01, 0.03, 0.06);
    // Very smooth water surface (low roughness = sharp reflections)
    mat.roughness = 0.08;
    mat.metallic = 0.0;
    // Water IOR
    mat.indexOfRefraction = 1.33;
    // Enable subsurface for subtle translucency
    (mat.subSurface as any).isRefractionEnabled = true;
    (mat.subSurface as any).refractionIntensity = 0.08;
    // Fresnel-driven alpha: start fairly transparent, vertex colors + Fresnel raise it
    mat.alpha = 0.75;
    mat.backFaceCulling = false;
    mat.forceDepthWrite = false;
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATESTANDBLEND;
    mat.alphaCutOff = 0.04;
    // Enable environment reflections (critical for realism)
    mat.environmentIntensity = 1.2;
    (mat as any).useVertexColors = true;
    (mat as any).hasVertexAlpha = true;
    this.material = mat;

    // ── Dual normal map layers for rich micro-ripple detail ──────────
    try {
      const nt = new Texture(WATER_NORMAL_PATH, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      nt.wrapU = Texture.WRAP_ADDRESSMODE;
      nt.wrapV = Texture.WRAP_ADDRESSMODE;
      nt.uScale = 14;
      nt.vScale = 14;
      mat.bumpTexture = nt;
      mat.bumpTexture.level = 0.22;
      this.normalTex = nt;

      // Second layer: same texture, different scale + scroll direction
      const nt2 = new Texture(WATER_NORMAL_PATH, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      nt2.wrapU = Texture.WRAP_ADDRESSMODE;
      nt2.wrapV = Texture.WRAP_ADDRESSMODE;
      nt2.uScale = 8;
      nt2.vScale = 8;
      // Babylon PBR detail map for second normal layer
      mat.detailMap.texture = nt2;
      mat.detailMap.isEnabled = true;
      mat.detailMap.diffuseBlendLevel = 0;
      mat.detailMap.roughnessBlendLevel = 0;
      mat.detailMap.bumpLevel = 0.12;
      this.normalTex2 = nt2;
    } catch {
      // Texture load failure is non-fatal
    }
  }

  // ─────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────

  updateSection(sectionKey: string, gpuData: ShallowWaterGPUData) {
    let record = this.sections.get(sectionKey);
    if (!record) {
      const sizeX = gpuData.sizeX;
      const sizeZ = gpuData.sizeZ;
      const gx = sizeX + 1;
      const gz = sizeZ + 1;
      const vertCount = gx * gz;

      const mesh = new Mesh(`dve_shallow_water_${sectionKey}`, this.scene);
      mesh.isPickable = false;
      mesh.renderingGroupId = 1;
      mesh.receiveShadows = false;
      mesh.material = this.material;

      record = {
        key: sectionKey,
        mesh,
        gpuData,
        pendingDispose: false,
        lastUpdatedAt: performance.now() * 0.001,
        posArr: new Float32Array(vertCount * 3),
        norArr: new Float32Array(vertCount * 3),
        uvArr: new Float32Array(vertCount * 2),
        colArr: new Float32Array(vertCount * 4),
        initialized: false,
      };
      this.sections.set(sectionKey, record);
    } else {
      record.gpuData = gpuData;
      record.pendingDispose = false;
      record.lastUpdatedAt = performance.now() * 0.001;
    }
  }

  removeSection(sectionKey: string) {
    const record = this.sections.get(sectionKey);
    if (!record) return;
    record.pendingDispose = true;
  }

  update(dt: number, activeKeys?: ReadonlySet<string>) {
    if (this.disposed) return;
    this.time += dt;

    // ── Advance handoff fade-out timers ──────────────────────────
    for (const [key, progress] of this.handoffFades) {
      const next = progress + dt / DVEShallowWaterRenderer.HANDOFF_FADE_DURATION;
      if (next >= 1) {
        this.handoffFades.delete(key);
      } else {
        this.handoffFades.set(key, next);
      }
    }

    // ── Compute average spread velocity across all active sections ────────
    let sumVX = 0, sumVZ = 0, activeColCount = 0;
    for (const [key, record] of this.sections) {
      if (record.pendingDispose || (activeKeys && !activeKeys.has(key))) continue;
      const { columnBuffer: cb, columnMetadata: cm, sizeX, sizeZ } = record.gpuData;
      const stride = SHALLOW_COLUMN_STRIDE;
      for (let i = 0; i < sizeX * sizeZ; i++) {
        const meta = cm[i];
        const decoded = decodeShallowColumnMetadata(meta);
        if (!decoded.active) continue;
        sumVX += cb[i * stride + 3];
        sumVZ += cb[i * stride + 4];
        activeColCount++;
      }
    }
    const avgVX = activeColCount > 0 ? sumVX / activeColCount : 0;
    const avgVZ = activeColCount > 0 ? sumVZ / activeColCount : 0;

    // ── Scroll normal-map UVs driven by real flow velocity ────────────────
    if (this.normalTex) {
      this.uvOffU1 += (avgVX * NORMAL_SCROLL_RATE + NORMAL_AMBIENT_DRIFT) * dt;
      this.uvOffV1 += (avgVZ * NORMAL_SCROLL_RATE + NORMAL_AMBIENT_DRIFT * 0.6) * dt;
      this.normalTex.uOffset = this.uvOffU1;
      this.normalTex.vOffset = this.uvOffV1;
    }
    // Second normal layer scrolls in opposite direction for detail breakup
    if (this.normalTex2) {
      this.uvOffU2 -= (avgVX * NORMAL_SCROLL_RATE * 0.7 + NORMAL_AMBIENT_DRIFT * 0.8) * dt;
      this.uvOffV2 += (avgVZ * NORMAL_SCROLL_RATE * 0.5 + NORMAL_AMBIENT_DRIFT * 0.4) * dt;
      this.normalTex2.uOffset = this.uvOffU2;
      this.normalTex2.vOffset = this.uvOffV2;
    }

    // ── Cache camera position for Fresnel in _rebuildSection ──────────
    const cam = this.scene.activeCamera;
    if (cam) {
      this.camX = cam.position.x;
      this.camY = cam.position.y;
      this.camZ = cam.position.z;
    }

    for (const [key, record] of this.sections) {
      if (record.pendingDispose || (activeKeys && !activeKeys.has(key))) {
        record.mesh.dispose();
        this.sections.delete(key);
        continue;
      }
      this._rebuildSection(record);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.sections.values()) {
      record.mesh.dispose();
    }
    this.sections.clear();
    this.normalTex?.dispose();
    this.normalTex2?.dispose();
    this.material.dispose();
  }

  // ─────────────────────────────────────────
  // Mesh builder (fixed topology, updateVerticesData path)
  // ─────────────────────────────────────────

  private _rebuildSection(record: SectionRecord) {
    const { gpuData, posArr, norArr, uvArr, colArr } = record;
    const { columnBuffer: cb, columnMetadata: cm, sizeX, sizeZ, originX, originZ } = gpuData;

    // Vertex grid is (sizeX+1) × (sizeZ+1) — fixed topology, never changes
    const gx = sizeX + 1;
    const gz = sizeZ + 1;

    // ── 1. Compute heights ─────────────────────────────────────────────
    // First pass: find average water-table Y across all active columns.
    // Inactive vertices will be placed at this level so that quads spanning the
    // active/inactive boundary stay horizontal — avoiding the "vertical clear plate"
    // artifact caused by height discontinuities between water surface and terrain.
    let waterTableY = 0;
    let activeCount = 0;
    for (let ci = 0; ci < sizeX * sizeZ; ci++) {
      const dec = decodeShallowColumnMetadata(cm[ci]);
      if (dec.active && dec.thicknessFraction >= MIN_VISIBLE_THICKNESS) {
        waterTableY += cb[ci * SHALLOW_COLUMN_STRIDE + 1]; // surfaceY
        activeCount++;
      }
    }
    waterTableY = activeCount > 0 ? waterTableY / activeCount : 0;

    const heights = new Float32Array(gx * gz);
    const alphas = new Float32Array(gx * gz);

    for (let vz = 0; vz < gz; vz++) {
      for (let vx = 0; vx < gx; vx++) {
        const cx = Math.min(vx, sizeX - 1);
        const cz = Math.min(vz, sizeZ - 1);
        const colI = cz * sizeX + cx;
        const meta = cm[colI];
        const decoded = decodeShallowColumnMetadata(meta);

        if (!decoded.active || decoded.thicknessFraction < MIN_VISIBLE_THICKNESS) {
          // Use waterTableY, NOT terrain surfaceY — keeps boundary quads horizontal.
          heights[vz * gx + vx] = waterTableY;
          alphas[vz * gx + vx] = 0;
          continue;
        }

        const baseY = sampleSurfaceY(cb, sizeX, sizeZ, cx, cz);
        const terrainY = sampleTerrainBottomY(cb, sizeX, sizeZ, cx, cz);
        const shoreDist = sampleShoreDist(cb, sizeX, sizeZ, cx, cz);
        const depth = Math.max(0, baseY - terrainY);
        const depthFade = clamp01(depth / 0.4);
        const shoreFade = clamp01(shoreDist / 4.0);

        const vVX = sampleField(cb, sizeX, sizeZ, cx, cz, 3);
        const vVZ = sampleField(cb, sizeX, sizeZ, cx, cz, 4);
        const settled = clamp01(decoded.settledFraction);
        const unsettled = 1 - settled;

        const wx = originX + vx;
        const wz = originZ + vz;

        // ── Multi-octave Gerstner ripples (3 wave directions) ────────
        // Replaces single-sine: more organic, less repetitive
        let gerstnerY = 0;
        const flowMag = Math.hypot(vVX, vVZ);
        for (let wi = 0; wi < GERSTNER_WAVES.length; wi++) {
          const w = GERSTNER_WAVES[wi];
          const phase = (w.dx * wx + w.dz * wz) * w.freq + this.time * w.speed;
          // Unsettled water: full amplitude. Settled pools: reduced but not zero.
          const ampScale = (0.3 + unsettled * 0.7) * depthFade * shoreFade;
          gerstnerY += Math.sin(phase) * w.amp * ampScale;
        }
        // Flow-driven directional ripple on top of Gerstner base
        const flowPhase = (vVX * wx + vVZ * wz) * RIPPLE_FREQ + this.time * WAVE_SPEED;
        const flowRipple = Math.sin(flowPhase) * Math.min(flowMag, 1) *
          RIPPLE_AMPLITUDE * unsettled * depthFade * shoreFade;
        // Ambient micro-shimmer for settled pools
        const ambientA = Math.sin(wx * 2.1 + this.time * 0.8) * Math.cos(wz * 1.75 + this.time * 0.65);
        const ambientRipple = ambientA * RIPPLE_AMPLITUDE * AMBIENT_RIPPLE_FRACTION *
          settled * depthFade * shoreFade * 0.5;

        const ripple = gerstnerY + flowRipple + ambientRipple;

        heights[vz * gx + vx] = baseY + ripple;

        // ── WaterBall-inspired alpha: density-proportional + Fresnel ─────
        // Beer-Lambert: thicker water → more opaque
        const densityAlpha = clamp01(1.0 - Math.exp(-decoded.thicknessFraction * 4.5));
        // Shore edge fade (organic outline, not rectangular)
        const shoreAlpha = clamp01(shoreDist / 3.0);
        // Section boundary fade
        const bx = Math.min(vx, sizeX - vx) / Math.max(sizeX * 0.15, 1);
        const bz = Math.min(vz, sizeZ - vz) / Math.max(sizeZ * 0.15, 1);
        const boundaryFade = clamp01(Math.min(bx, bz));
        const edgeFade = shoreAlpha * (0.6 + 0.4 * boundaryFade);
        // Depth modulation
        const depthMod = clamp01(0.35 + depthFade * 0.65);
        // Schlick Fresnel: more reflective at grazing angles → higher alpha
        const eyeX = this.camX - wx;
        const eyeY = this.camY - heights[vz * gx + vx];
        const eyeZ = this.camZ - wz;
        const eyeLen = Math.sqrt(eyeX * eyeX + eyeY * eyeY + eyeZ * eyeZ);
        // dot(up, viewDir) — up = (0,1,0) for water surface
        const cosTheta = eyeLen > 0.001 ? Math.abs(eyeY / eyeLen) : 1;
        const fresnel = FRESNEL_F0 + (1.0 - FRESNEL_F0) * Math.pow(1.0 - cosTheta, 5);
        // Combine: base density alpha boosted by Fresnel at grazing
        const fresnelBoost = clamp01(densityAlpha + fresnel * 0.6);
        alphas[vz * gx + vx] = clamp01(fresnelBoost * edgeFade * depthMod);

        // Apply handoff fade-out if this column is being promoted to Layer B
        const fadeKey = `${originX + cx},${originZ + cz}`;
        const fadeProgress = this.handoffFades.get(fadeKey);
        if (fadeProgress !== undefined) {
          // Smooth ease-out so puddle dissolves gracefully
          const fadeOut = 1 - fadeProgress * fadeProgress; // quadratic ease
          alphas[vz * gx + vx] *= fadeOut;
        }
      }
    }

    // ── 2. Normals ─────────────────────────────────────────────────────

    const normals = new Float32Array(gx * gz * 3);
    for (let vz = 0; vz < gz; vz++) {
      for (let vx = 0; vx < gx; vx++) {
        const hl = heights[vz * gx + Math.max(0, vx - 1)];
        const hr = heights[vz * gx + Math.min(gx - 1, vx + 1)];
        const hd = heights[Math.max(0, vz - 1) * gx + vx];
        const hu = heights[Math.min(gz - 1, vz + 1) * gx + vx];
        const nx = -(hr - hl);
        const ny = 2.0;
        const nz = -(hu - hd);
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const ni = (vz * gx + vx) * 3;
        normals[ni]     = nx / len;
        normals[ni + 1] = ny / len;
        normals[ni + 2] = nz / len;
      }
    }

    // ── 3. Fill pre-allocated vertex arrays ────────────────────────────

    let anyVisible = false;
    for (let vz = 0; vz < gz; vz++) {
      for (let vx = 0; vx < gx; vx++) {
        const vi = vz * gx + vx;
        const alpha = alphas[vi];
        const wx = originX + vx;
        const wz = originZ + vz;

        const pi = vi * 3;
        posArr[pi]     = wx;
        posArr[pi + 1] = heights[vi];
        posArr[pi + 2] = wz;

        const ni = vi * 3;
        norArr[ni]     = normals[ni];
        norArr[ni + 1] = normals[ni + 1];
        norArr[ni + 2] = normals[ni + 2];

        const ui = vi * 2;
        uvArr[ui]     = vx / sizeX;
        uvArr[ui + 1] = vz / sizeZ;

        const ci = vi * 4;
        if (alpha < 0.01) {
          // Invisible vertex: stays at grid position but fully transparent.
          // Do NOT collapse to origin — that would create giant stretched triangles
          // because all quads are always indexed.
          colArr[ci]     = 0;
          colArr[ci + 1] = 0;
          colArr[ci + 2] = 0;
          colArr[ci + 3] = 0;
        } else {
          anyVisible = true;
          const cx = Math.min(vx, sizeX - 1);
          const cz = Math.min(vz, sizeZ - 1);
          const shoreD = sampleShoreDist(cb, sizeX, sizeZ, cx, cz);
          const colMeta = decodeShallowColumnMetadata(cm[cz * sizeX + cx]);
          const thickness = colMeta.thicknessFraction;
          const settledV = clamp01(colMeta.settledFraction);

          // ── Beer-Lambert absorption: realistic depth-dependent color ──
          const beerR = Math.exp(-ABSORB_R * thickness);
          const beerG = Math.exp(-ABSORB_G * thickness);
          const beerB = Math.exp(-ABSORB_B * thickness);
          // Shallow teal → deep blue-green via absorption
          const shallowR = 0.45 * beerR;
          const shallowG = 0.78 * beerG;
          const shallowB = 0.92 * beerB;

          // Shore foam: white foam at edges
          const foamT = clamp01(1.0 - shoreD / 2.5);
          // Wave crest micro-foam: slight whitening at ripple peaks
          const surfY = sampleSurfaceY(cb, sizeX, sizeZ, cx, cz);
          const crestFoam = clamp01((heights[vi] - surfY) / (RIPPLE_AMPLITUDE * 1.5)) * 0.15;
          const totalFoam = clamp01(foamT * 0.7 + crestFoam);

          // Settled pools: slightly darker (calmer = clearer)
          const calmDarken = settledV * 0.08;
          colArr[ci]     = clamp01(lerp(shallowR - calmDarken, 1.0, totalFoam));
          colArr[ci + 1] = clamp01(lerp(shallowG - calmDarken * 0.5, 1.0, totalFoam));
          colArr[ci + 2] = clamp01(lerp(shallowB, 1.0, totalFoam * 0.6));
          colArr[ci + 3] = alpha;
        }
      }
    }

    if (!record.initialized) {
      // ── First build: fixed indices + applyToMesh once ──────────────────
      const idx: number[] = [];
      for (let vz = 0; vz < sizeZ; vz++) {
        for (let vx = 0; vx < sizeX; vx++) {
          const i00 = vz * gx + vx;
          const i10 = vz * gx + (vx + 1);
          const i01 = (vz + 1) * gx + vx;
          const i11 = (vz + 1) * gx + (vx + 1);
          if ((vx + vz) % 2 === 0) {
            idx.push(i00, i11, i01, i00, i10, i11);
          } else {
            idx.push(i00, i10, i01, i10, i11, i01);
          }
        }
      }
      const vd = new VertexData();
      vd.positions = posArr;
      vd.normals    = norArr;
      vd.uvs        = uvArr;
      vd.colors     = colArr;
      vd.indices    = idx;
      // applyToMesh with updatable=true registers the buffers for streaming updates
      vd.applyToMesh(record.mesh, true);
      record.mesh.refreshBoundingInfo();
      record.initialized = true;
      record.mesh.setEnabled(anyVisible);
    } else {
      // ── Subsequent frames: stream-update vertex data only ──────────────
      record.mesh.updateVerticesData(VertexBuffer.PositionKind, posArr, false);
      record.mesh.updateVerticesData(VertexBuffer.NormalKind,   norArr, false);
      record.mesh.updateVerticesData(VertexBuffer.ColorKind,    colArr, false);
      record.mesh.refreshBoundingInfo();
      record.mesh.setEnabled(anyVisible);
    }
  }
}
