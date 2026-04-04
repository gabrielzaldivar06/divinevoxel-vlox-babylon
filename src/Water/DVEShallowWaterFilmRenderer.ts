import { Color3 } from "@babylonjs/core/Maths/math.color";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { VertexBuffer } from "@babylonjs/core/Meshes/buffer";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";

import type {
  ShallowFilmSectionRenderData,
  ShallowVisualColumnState,
} from "@divinevoxel/vlox/Water/Shallow/index.js";
import type { DVEShallowWaterLocalFluidContributionState } from "./DVEShallowWaterCompositeController.js";

type SectionRecord = {
  key: string;
  mesh: Mesh;
  skirtMesh: Mesh | null;
  skirtQuadCount: number;
  data: ShallowFilmSectionRenderData;
  pendingDispose: boolean;
  dirty: boolean;
  gridX: number;
  gridZ: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  initialized: boolean;
  geometrySupports: Float32Array;
  displayHeights: Float32Array;
  smoothedHandoffBlends: Float32Array;
  /** deltaSeconds for use inside rebuildSection (set by update() before call). */
  frameDelta: number;
};

type VertexSample = {
  active: boolean;
  coverage: number;
  filmOpacity: number;
  localAnchor: number;
  bedY: number;
  surfaceY: number;
  thickness: number;
  settled: number;
  wetness: number;
  foam: number;
  microRipple: number;
  shoreDist: number;
  flowX: number;
  flowZ: number;
  flowSpeed: number;
  mergeBlend: number;
  deepBlend: number;
  handoffBlend: number;
  turbidity: number;
};

type LocalFluidSample = {
  flowX: number;
  flowZ: number;
  flowSpeed: number;
  fill: number;
  foam: number;
};

type ShallowFilmDebugEntry = {
  activeColumnCount: number;
  sparsePath: boolean;
  activeVertices: number;
  geometrySupportedVertices: number;
  topologyOnlyVertices: number;
  renderedQuads: number;
  maxAlpha: number;
  minY: number;
  maxY: number;
};

const WATER_NORMAL_PATH = "assets/water/water-001-normal.jpg";
const FILM_SUBDIVISION = 3;
const FILM_SURFACE_OFFSET = 0.015;
const FILM_RIPPLE_SCALE = 0.00138;
const FILM_ALPHA_BIAS = 0.09;
const FILM_ALPHA_WETNESS = 0.50;
const FILM_ALPHA_FOAM = 0.09;
const FILM_ALPHA_FLOW = 0.05;
const FILM_UV_SCROLL = 0.016;
const FILM_VERTEX_SUPPORT_EPSILON = 0.0014;
const FILM_QUAD_SUPPORT_MIN_AVERAGE = 0.0044;
const FILM_TEMPORAL_HEIGHT_BLEND = 0.16;
const FILM_TEMPORAL_ALPHA_BLEND = 0.18;
const FILM_TEMPORAL_COLOR_BLEND = 0.2;
const FILM_SAMPLE_RADIUS = 3.1;
const FILM_SPARSE_SAMPLE_RADIUS = 1.35;
const FILM_TOPOLOGY_DILATION = 0.28;
const FILM_CORNER_SUPPORT_BIAS = 0.12;
const FILM_FEATHER_BLEND = 0.74;
const FILM_SPARSE_ACTIVE_COLUMN_THRESHOLD = 64;
const FILM_SPARSE_LOCAL_ANCHOR_MIN = 0.065;
const FILM_SPARSE_MAX_LIFT = 0.085;
const FILM_MAX_QUAD_HEIGHT_SPAN = 1.8;
const FILM_EDGE_HEIGHT_PULL = 0.56;
const FILM_EDGE_ALPHA_SOFTEN = 0.88;
const FILM_EDGE_MAX_VERTICAL_DROP = 0.18;
const FILM_SKIRT_MAX_DEPTH = 1.2;
const FILM_EDGE_FEATHER_ALPHA = 0.14;
const FILM_HANDOFF_BLEND_RISE_TAU = 0.08;
const FILM_HANDOFF_BLEND_FALL_TAU = 0.2;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function getShallowFilmDebugStore() {
  const globalScope = globalThis as any;
  if (!globalScope.__DVE_SHALLOW_FILM_DEBUG__) {
    globalScope.__DVE_SHALLOW_FILM_DEBUG__ = {};
  }
  return globalScope.__DVE_SHALLOW_FILM_DEBUG__ as Record<string, ShallowFilmDebugEntry>;
}

function lerp(start: number, end: number, alpha: number) {
  return start + (end - start) * alpha;
}

function getTemporalBlend(dt: number, tau: number) {
  if (tau <= 0.0001) return 1;
  return clamp01(1 - Math.exp(-Math.max(0, dt) / tau));
}

function writeQuadIndices(
  target: Uint32Array,
  offset: number,
  x: number,
  z: number,
  gridX: number,
) {
  const i00 = z * gridX + x;
  const i10 = z * gridX + (x + 1);
  const i01 = (z + 1) * gridX + x;
  const i11 = (z + 1) * gridX + (x + 1);
  if ((x + z) % 2 === 0) {
    target[offset + 0] = i00;
    target[offset + 1] = i11;
    target[offset + 2] = i01;
    target[offset + 3] = i00;
    target[offset + 4] = i10;
    target[offset + 5] = i11;
    return;
  }
  target[offset + 0] = i00;
  target[offset + 1] = i10;
  target[offset + 2] = i01;
  target[offset + 3] = i10;
  target[offset + 4] = i11;
  target[offset + 5] = i01;
}

function writeDegenerateQuadIndices(target: Uint32Array, offset: number, anchor: number) {
  target[offset + 0] = anchor;
  target[offset + 1] = anchor;
  target[offset + 2] = anchor;
  target[offset + 3] = anchor;
  target[offset + 4] = anchor;
  target[offset + 5] = anchor;
}

type NeighborSupports = {
  north: Float32Array | null;  // section at −Z: its last row
  south: Float32Array | null;  // section at +Z: its first row
  west:  Float32Array | null;  // section at −X: its last column
  east:  Float32Array | null;  // section at +X: its first column
  neighborGridX: number;
  neighborGridZ: number;
};

/**
 * Build lateral skirt walls around the water body edge.
 * For each exposed film edge (supported on one side, open on the other),
 * emit a quad that descends from displayHeight down to terrainY.
 * Neighbor supports are used to suppress walls shared between two water sections.
 */
function buildSkirtGeometry(
  geometrySupports: Float32Array,
  renderSupports: Float32Array,
  displayHeights: Float32Array,
  displayAlphas: Float32Array,
  thicknesses: Float32Array,
  gridX: number,
  gridZ: number,
  originX: number,
  originZ: number,
  terrainY: number,
  neighbors: NeighborSupports | null,
): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; colors: Float32Array; indices: Uint32Array } | null {
  const eps = FILM_VERTEX_SUPPORT_EPSILON;
  const topoEps = eps * 0.5; // softer threshold for topology-dilated supports
  // Upper bound on quads: all edges of all border vertices × 2 sides
  const maxQuads = 4 * (gridX + gridZ) * 2 + 8;
  const posArr   = new Float32Array(maxQuads * 4 * 3);
  const normArr  = new Float32Array(maxQuads * 4 * 3);
  const uvArr    = new Float32Array(maxQuads * 4 * 2);
  const colArr   = new Float32Array(maxQuads * 4 * 4);
  const idxArr   = new Uint32Array(maxQuads * 6);
  let vBase = 0;
  let iBase = 0;

  // Emit a wall quad: v0=(x0,y0t,z0) at top, v1=(x1,y1t,z1) at top,
  // both descend to terrainY. (nx,nz) is the outward horizontal normal.
  function emitWall(
    x0: number, y0t: number, z0: number,
    x1: number, y1t: number, z1: number,
    nx: number, nz: number,
    a0: number, a1: number,
    wallBot: number,
  ) {
    const p = vBase * 3;
    const u = vBase * 2;
    const c = vBase * 4;
    posArr[p + 0] = x0; posArr[p + 1] = y0t;    posArr[p + 2] = z0;
    posArr[p + 3] = x1; posArr[p + 4] = y1t;    posArr[p + 5] = z1;
    posArr[p + 6] = x1; posArr[p + 7] = wallBot; posArr[p + 8] = z1;
    posArr[p + 9] = x0; posArr[p + 10] = wallBot; posArr[p + 11] = z0;
    for (let k = 0; k < 4; k++) {
      normArr[p + k * 3 + 0] = nx;
      normArr[p + k * 3 + 1] = 0;
      normArr[p + k * 3 + 2] = nz;
    }
    uvArr[u + 0] = 0; uvArr[u + 1] = 1;
    uvArr[u + 2] = 1; uvArr[u + 3] = 1;
    uvArr[u + 4] = 1; uvArr[u + 5] = 0;
    uvArr[u + 6] = 0; uvArr[u + 7] = 0;
    // top: water blue; bottom: transparent, darker
    colArr[c + 0]  = 0.05; colArr[c + 1]  = 0.15; colArr[c + 2]  = 0.24; colArr[c + 3]  = a0 * 0.92;
    colArr[c + 4]  = 0.05; colArr[c + 5]  = 0.15; colArr[c + 6]  = 0.24; colArr[c + 7]  = a1 * 0.92;
    colArr[c + 8]  = 0.02; colArr[c + 9]  = 0.07; colArr[c + 10] = 0.12; colArr[c + 11] = 0;
    colArr[c + 12] = 0.02; colArr[c + 13] = 0.07; colArr[c + 14] = 0.12; colArr[c + 15] = 0;
    idxArr[iBase + 0] = vBase;     idxArr[iBase + 1] = vBase + 1; idxArr[iBase + 2] = vBase + 2;
    idxArr[iBase + 3] = vBase;     idxArr[iBase + 4] = vBase + 2; idxArr[iBase + 5] = vBase + 3;
    vBase += 4;
    iBase += 6;
  }

  const nGridX = neighbors?.neighborGridX ?? gridX;
  const nGridZ = neighbors?.neighborGridZ ?? gridZ;

  // Helper: read neighbor support at given neighbor-local index
  const nSupport = (arr: Float32Array | null, idx: number) =>
    arr ? (arr[idx] ?? 0) : 0;

  // Horizontal edge pairs (x varies, z fixed) → ±Z walls
  for (let z = 0; z < gridZ; z++) {
    for (let x = 0; x < gridX - 1; x++) {
      const iA = z * gridX + x;
      const iB = z * gridX + (x + 1);
      // Use renderSupports (topology-dilated) to decide whether to emit this edge
      if (renderSupports[iA] <= topoEps || renderSupports[iB] <= topoEps) continue;
      const wX0 = originX + x / FILM_SUBDIVISION;
      const wX1 = originX + (x + 1) / FILM_SUBDIVISION;
      const wZ  = originZ + z / FILM_SUBDIVISION;
      // Cap skirt depth: at most FILM_SKIRT_MAX_DEPTH below surface
      const topY = Math.min(displayHeights[iA], displayHeights[iB]);
      const wallBot = Math.max(terrainY, topY - FILM_SKIRT_MAX_DEPTH);
      // -Z face
      let backOk: boolean;
      if (z > 0) {
        backOk = renderSupports[(z - 1) * gridX + x]       > topoEps
              && renderSupports[(z - 1) * gridX + (x + 1)] > topoEps;
      } else {
        // z === 0: check north neighbor's last row
        const ni0 = (nGridZ - 1) * nGridX + x;
        const ni1 = (nGridZ - 1) * nGridX + (x + 1);
        backOk = nSupport(neighbors?.north ?? null, ni0) > eps
              && nSupport(neighbors?.north ?? null, ni1) > eps;
      }
      if (!backOk) {
        emitWall(wX0, displayHeights[iA], wZ, wX1, displayHeights[iB], wZ, 0, -1,
          displayAlphas[iA], displayAlphas[iB], wallBot);
      }
      // +Z face
      let frontOk: boolean;
      if (z < gridZ - 1) {
        frontOk = renderSupports[(z + 1) * gridX + x]       > topoEps
               && renderSupports[(z + 1) * gridX + (x + 1)] > topoEps;
      } else {
        // z === gridZ - 1: check south neighbor's first row
        const ni0 = x;
        const ni1 = x + 1;
        frontOk = nSupport(neighbors?.south ?? null, ni0) > eps
               && nSupport(neighbors?.south ?? null, ni1) > eps;
      }
      if (!frontOk) {
        emitWall(wX1, displayHeights[iB], wZ, wX0, displayHeights[iA], wZ, 0, 1,
          displayAlphas[iB], displayAlphas[iA], wallBot);
      }
    }
  }

  // Vertical edge pairs (z varies, x fixed) → ±X walls
  for (let x = 0; x < gridX; x++) {
    for (let z = 0; z < gridZ - 1; z++) {
      const iA = z * gridX + x;
      const iB = (z + 1) * gridX + x;
      if (renderSupports[iA] <= topoEps || renderSupports[iB] <= topoEps) continue;
      const wX  = originX + x / FILM_SUBDIVISION;
      const wZ0 = originZ + z / FILM_SUBDIVISION;
      const wZ1 = originZ + (z + 1) / FILM_SUBDIVISION;
      // Cap skirt depth
      const topY = Math.min(displayHeights[iA], displayHeights[iB]);
      const wallBot = Math.max(terrainY, topY - FILM_SKIRT_MAX_DEPTH);
      // -X face
      let leftOk: boolean;
      if (x > 0) {
        leftOk = renderSupports[z * gridX       + (x - 1)] > topoEps
              && renderSupports[(z + 1) * gridX + (x - 1)] > topoEps;
      } else {
        // x === 0: check west neighbor's last column
        const ni0 = z * nGridX + (nGridX - 1);
        const ni1 = (z + 1) * nGridX + (nGridX - 1);
        leftOk = nSupport(neighbors?.west ?? null, ni0) > eps
              && nSupport(neighbors?.west ?? null, ni1) > eps;
      }
      if (!leftOk) {
        emitWall(wX, displayHeights[iB], wZ1, wX, displayHeights[iA], wZ0, -1, 0,
          displayAlphas[iB], displayAlphas[iA], wallBot);
      }
      // +X face
      let rightOk: boolean;
      if (x < gridX - 1) {
        rightOk = renderSupports[z * gridX       + (x + 1)] > topoEps
               && renderSupports[(z + 1) * gridX + (x + 1)] > topoEps;
      } else {
        // x === gridX - 1: check east neighbor's first column
        const ni0 = z * nGridX;
        const ni1 = (z + 1) * nGridX;
        rightOk = nSupport(neighbors?.east ?? null, ni0) > eps
               && nSupport(neighbors?.east ?? null, ni1) > eps;
      }
      if (!rightOk) {
        emitWall(wX, displayHeights[iA], wZ0, wX, displayHeights[iB], wZ1, 1, 0,
          displayAlphas[iA], displayAlphas[iB], wallBot);
      }
    }
  }

  if (vBase === 0) return null;
  return {
    positions: posArr.slice(0, vBase * 3),
    normals:   normArr.slice(0, vBase * 3),
    uvs:       uvArr.slice(0, vBase * 2),
    colors:    colArr.slice(0, vBase * 4),
    indices:   idxArr.slice(0, iBase),
  };
}

function sampleField(
  field: Float32Array,
  width: number,
  height: number,
  fx: number,
  fz: number,
) {
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const x1 = x0 + 1;
  const z1 = z0 + 1;
  const tx = fx - x0;
  const tz = fz - z0;

  const read = (x: number, z: number) => {
    if (x < 0 || z < 0 || x >= width || z >= height) return 0;
    return field[x * height + z] ?? 0;
  };

  const v00 = read(x0, z0);
  const v10 = read(x1, z0);
  const v01 = read(x0, z1);
  const v11 = read(x1, z1);
  return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), tz);
}

function sampleLocalFluid(
  state: DVEShallowWaterLocalFluidContributionState | null,
  worldX: number,
  worldZ: number,
): LocalFluidSample {
  if (
    !state ||
    state.width <= 0 ||
    state.height <= 0 ||
    state.velocityXField.length < state.width * state.height ||
    state.velocityZField.length < state.width * state.height ||
    state.fillField.length < state.width * state.height ||
    state.foamField.length < state.width * state.height
  ) {
    return { flowX: 0, flowZ: 0, flowSpeed: 0, fill: 0, foam: 0 };
  }

  const fx = worldX - state.originX;
  const fz = worldZ - state.originZ;
  if (fx < 0 || fz < 0 || fx >= state.width - 1 || fz >= state.height - 1) {
    return { flowX: 0, flowZ: 0, flowSpeed: 0, fill: 0, foam: 0 };
  }

  const flowX = sampleField(state.velocityXField, state.width, state.height, fx, fz);
  const flowZ = sampleField(state.velocityZField, state.width, state.height, fx, fz);
  const fill = sampleField(state.fillField, state.width, state.height, fx, fz);
  const foam = sampleField(state.foamField, state.width, state.height, fx, fz);
  return {
    flowX,
    flowZ,
    flowSpeed: Math.hypot(flowX, flowZ),
    fill: clamp01(fill),
    foam: clamp01(foam),
  };
}

function ensureTopology(record: SectionRecord, sizeX: number, sizeZ: number) {
  const quadX = sizeX * FILM_SUBDIVISION;
  const quadZ = sizeZ * FILM_SUBDIVISION;
  const gridX = quadX + 1;
  const gridZ = quadZ + 1;
  const vertexCount = gridX * gridZ;
  const indexCount = quadX * quadZ * 6;
  if (
    record.gridX === gridX &&
    record.gridZ === gridZ &&
    record.positions.length === vertexCount * 3 &&
    record.indices.length === indexCount
  ) {
    return;
  }

  record.gridX = gridX;
  record.gridZ = gridZ;
  record.positions = new Float32Array(vertexCount * 3);
  record.normals = new Float32Array(vertexCount * 3);
  record.uvs = new Float32Array(vertexCount * 2);
  record.colors = new Float32Array(vertexCount * 4);
  record.indices = new Uint32Array(indexCount);
  record.displayHeights = new Float32Array(vertexCount);
  record.smoothedHandoffBlends = new Float32Array(vertexCount);
  record.initialized = false;

  let indexOffset = 0;
  for (let z = 0; z < quadZ; z++) {
    for (let x = 0; x < quadX; x++) {
      writeDegenerateQuadIndices(record.indices, indexOffset, z * gridX + x);
      indexOffset += 6;
    }
  }
}

function rebuildDynamicIndices(
  record: SectionRecord,
  sizeX: number,
  sizeZ: number,
  gridX: number,
  geometrySupports: Float32Array,
  heights: Float32Array,
) {
  let indexOffset = 0;
  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      const i00 = z * gridX + x;
      const i10 = z * gridX + (x + 1);
      const i01 = (z + 1) * gridX + x;
      const i11 = (z + 1) * gridX + (x + 1);
      const g00 = geometrySupports[i00];
      const g10 = geometrySupports[i10];
      const g01 = geometrySupports[i01];
      const g11 = geometrySupports[i11];
      const h00 = heights[i00];
      const h10 = heights[i10];
      const h01 = heights[i01];
      const h11 = heights[i11];
      const maxGeometrySupport = Math.max(g00, g10, g01, g11);
      const diagonalBridge = Math.max(Math.min(g00, g11), Math.min(g10, g01));
      const supportedVertices =
        (g00 > FILM_VERTEX_SUPPORT_EPSILON ? 1 : 0) +
        (g10 > FILM_VERTEX_SUPPORT_EPSILON ? 1 : 0) +
        (g01 > FILM_VERTEX_SUPPORT_EPSILON ? 1 : 0) +
        (g11 > FILM_VERTEX_SUPPORT_EPSILON ? 1 : 0);
      const averageSupport = (g00 + g10 + g01 + g11) * 0.25;
      const heightSpan =
        Math.max(h00, h10, h01, h11) - Math.min(h00, h10, h01, h11);
      const supportEnvelope =
        averageSupport * 0.66 +
        maxGeometrySupport * 0.22 +
        diagonalBridge * FILM_CORNER_SUPPORT_BIAS;
      const fragileEdgeQuad = supportedVertices < 3 && averageSupport < 0.075;
      const allowedHeightSpan = fragileEdgeQuad
        ? Math.min(FILM_MAX_QUAD_HEIGHT_SPAN, 0.34)
        : FILM_MAX_QUAD_HEIGHT_SPAN;

      if (
        heightSpan <= allowedHeightSpan &&
        ((supportedVertices >= 2 && supportEnvelope >= FILM_QUAD_SUPPORT_MIN_AVERAGE * (fragileEdgeQuad ? 1.35 : 0.84)) ||
          (diagonalBridge >= (fragileEdgeQuad ? 0.05 : 0.02) &&
            maxGeometrySupport >= (fragileEdgeQuad ? 0.018 : FILM_VERTEX_SUPPORT_EPSILON)) ||
          maxGeometrySupport >= 0.048)
      ) {
        writeQuadIndices(record.indices, indexOffset, x, z, gridX);
      } else {
        writeDegenerateQuadIndices(record.indices, indexOffset, i00);
      }
      indexOffset += 6;
    }
  }
}

function sampleColumn(
  columns: ShallowVisualColumnState[],
  sizeX: number,
  sizeZ: number,
  x: number,
  z: number,
) {
  if (x < 0 || z < 0 || x >= sizeX || z >= sizeZ) {
    return null;
  }
  return columns[z * sizeX + x] ?? null;
}

type NeighborFilmData = {
  north: ShallowFilmSectionRenderData | null;
  south: ShallowFilmSectionRenderData | null;
  west: ShallowFilmSectionRenderData | null;
  east: ShallowFilmSectionRenderData | null;
};

function sampleColumnCross(
  film: ShallowFilmSectionRenderData,
  neighbors: NeighborFilmData | null,
  x: number,
  z: number,
): ShallowVisualColumnState | null {
  if (x >= 0 && x < film.sizeX && z >= 0 && z < film.sizeZ) {
    return sampleColumn(film.columns, film.sizeX, film.sizeZ, x, z);
  }
  if (!neighbors) return null;
  if (x < 0 && neighbors.west) {
    const w = neighbors.west;
    return sampleColumn(w.columns, w.sizeX, w.sizeZ, w.sizeX + x, z);
  }
  if (x >= film.sizeX && neighbors.east) {
    const e = neighbors.east;
    return sampleColumn(e.columns, e.sizeX, e.sizeZ, x - film.sizeX, z);
  }
  if (z < 0 && neighbors.north) {
    const n = neighbors.north;
    return sampleColumn(n.columns, n.sizeX, n.sizeZ, x, n.sizeZ + z);
  }
  if (z >= film.sizeZ && neighbors.south) {
    const s = neighbors.south;
    return sampleColumn(s.columns, s.sizeX, s.sizeZ, x, z - film.sizeZ);
  }
  return null;
}

function sampleVertex(
  film: ShallowFilmSectionRenderData,
  sampleX: number,
  sampleZ: number,
  neighbors: NeighborFilmData | null = null,
  sampleRadius = FILM_SAMPLE_RADIUS,
  localAnchorMin = 0.015,
): VertexSample | null {
  let totalWeight = 0;
  let localAnchorWeight = 0;
  let localAnchorCoverage = 0;
  let bedY = 0;
  let surfaceY = 0;
  let coverage = 0;
  let filmOpacity = 0;
  let thickness = 0;
  let settled = 0;
  let wetness = 0;
  let foam = 0;
  let microRipple = 0;
  let shoreDist = 0;
  let flowX = 0;
  let flowZ = 0;
  let flowSpeed = 0;
  let mergeBlend = 0;
  let deepBlend = 0;
  let handoffBlend = 0;
  let turbidity = 0;

  const accumulate = (
    column: ShallowVisualColumnState | null,
    weightScale: number,
    offsetX: number,
    offsetZ: number,
  ) => {
    if (!column?.active || column.coverage <= 0) return;
    const flow01 = clamp01(column.flowSpeed * 0.7);
    let anisotropy = 1;
    if (flow01 > 0.0001) {
      const parallel = Math.abs(offsetX * column.flowX + offsetZ * column.flowZ);
      const orthogonal = Math.abs(offsetX * -column.flowZ + offsetZ * column.flowX);
      anisotropy += flow01 * Math.max(0, 0.18 + parallel * 0.08 - orthogonal * 0.12);
    }
    const weight =
      Math.max(
        0.035,
        column.coverage * (0.82 + column.mergeBlend * 0.18) + column.edgeStrength * 0.12,
      ) *
      weightScale *
      anisotropy;
    totalWeight += weight;
    if (Math.hypot(offsetX, offsetZ) <= 1.2) {
      localAnchorWeight += weight;
      localAnchorCoverage += column.coverage * weight;
    }
    bedY += column.bedY * weight;
    surfaceY += column.visualSurfaceY * weight;
    coverage += column.coverage * weight;
    filmOpacity += column.filmOpacity * weight;
    thickness += column.thickness * weight;
    settled += column.settled * weight;
    wetness += column.wetness * weight;
    foam += column.foam * weight;
    microRipple += column.microRipple * weight;
    shoreDist += column.shoreDist * weight;
    flowX += column.flowX * weight;
    flowZ += column.flowZ * weight;
    flowSpeed += column.flowSpeed * weight;
    mergeBlend += column.mergeBlend * weight;
    deepBlend += column.deepBlend * weight;
    handoffBlend += column.handoffBlend * weight;
    turbidity += (column.turbidity ?? 0) * weight;
  };

  const minX = Math.floor(sampleX) - 2;
  const minZ = Math.floor(sampleZ) - 2;
  const maxX = Math.ceil(sampleX) + 2;
  const maxZ = Math.ceil(sampleZ) + 2;

  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      const centerX = x + 0.5;
      const centerZ = z + 0.5;
      const dx = centerX - sampleX;
      const dz = centerZ - sampleZ;
      const distance = Math.hypot(dx, dz);
      if (distance > sampleRadius) continue;
      const radial = Math.max(0, 1 - distance / sampleRadius);
      const weightScale = radial * radial;
      if (weightScale <= 0.0001) continue;
      accumulate(
        sampleColumnCross(film, neighbors, x, z),
        weightScale,
        dx,
        dz,
      );
    }
  }

  if (totalWeight <= 0.0001) return null;

  const localAnchor =
    localAnchorWeight > 0.0001 ? clamp01(localAnchorCoverage / localAnchorWeight) : 0;
  if (localAnchor <= localAnchorMin) {
    return null;
  }

  return {
    active: true,
    coverage: coverage / totalWeight,
    filmOpacity: filmOpacity / totalWeight,
    localAnchor,
    bedY: bedY / totalWeight,
    surfaceY: surfaceY / totalWeight,
    thickness: thickness / totalWeight,
    settled: settled / totalWeight,
    wetness: wetness / totalWeight,
    foam: foam / totalWeight,
    microRipple: microRipple / totalWeight,
    shoreDist: shoreDist / totalWeight,
    flowX: flowX / totalWeight,
    flowZ: flowZ / totalWeight,
    flowSpeed: flowSpeed / totalWeight,
    mergeBlend: mergeBlend / totalWeight,
    deepBlend: deepBlend / totalWeight,
    handoffBlend: handoffBlend / totalWeight,
    turbidity: turbidity / totalWeight,
  };
}

function buildSmoothedSupports(
  source: Float32Array,
  gridX: number,
  gridZ: number,
) {
  const out = new Float32Array(source.length);
  for (let z = 0; z < gridZ; z++) {
    for (let x = 0; x < gridX; x++) {
      let totalWeight = 0;
      let totalValue = 0;
      let maxNeighbor = 0;
      const read = (rx: number, rz: number) => {
        if (rx < 0 || rz < 0 || rx >= gridX || rz >= gridZ) return 0;
        return source[rz * gridX + rx];
      };
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= gridX || nz >= gridZ) continue;
          const distance = Math.hypot(dx, dz);
          const weight = 1 / (1 + distance * 1.18);
          totalWeight += weight;
          const sample = source[nz * gridX + nx];
          totalValue += sample * weight;
          maxNeighbor = Math.max(maxNeighbor, sample);
        }
      }
      const index = z * gridX + x;
      const blurred = totalWeight > 0.0001 ? totalValue / totalWeight : source[index];
      const own = source[index];
      const cornerBridge = Math.max(
        Math.min(read(x - 1, z), read(x, z - 1)),
        Math.min(read(x + 1, z), read(x, z - 1)),
        Math.min(read(x - 1, z), read(x, z + 1)),
        Math.min(read(x + 1, z), read(x, z + 1)),
      );
      const expanded = Math.max(
        own,
        own * 0.58 + blurred * 0.42,
        maxNeighbor * FILM_TOPOLOGY_DILATION,
        cornerBridge * 0.76,
      );
      out[index] = clamp01(expanded * 0.72 + blurred * 0.2 + maxNeighbor * 0.04 + own * 0.04);
    }
  }
  return out;
}

function buildTopologySupports(
  source: Float32Array,
  gridX: number,
  gridZ: number,
) {
  const out = new Float32Array(source.length);
  const read = (x: number, z: number) => {
    if (x < 0 || z < 0 || x >= gridX || z >= gridZ) return 0;
    return source[z * gridX + x];
  };

  for (let z = 0; z < gridZ; z++) {
    for (let x = 0; x < gridX; x++) {
      let totalWeight = 0;
      let totalValue = 0;
      let maxNeighbor = 0;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= gridX || nz >= gridZ) continue;
          const distance = Math.hypot(dx, dz);
          const weight = 1 / (1 + distance * 1.35);
          const sample = source[nz * gridX + nx];
          totalWeight += weight;
          totalValue += sample * weight;
          maxNeighbor = Math.max(maxNeighbor, sample);
        }
      }
      const own = source[z * gridX + x];
      const blurred = totalWeight > 0.0001 ? totalValue / totalWeight : own;
      const elbowBridge = Math.max(
        Math.min(read(x - 1, z), read(x, z - 1)),
        Math.min(read(x + 1, z), read(x, z - 1)),
        Math.min(read(x - 1, z), read(x, z + 1)),
        Math.min(read(x + 1, z), read(x, z + 1)),
      );
      const diagonalBridge = Math.max(
        Math.min(read(x - 1, z - 1), Math.max(read(x - 1, z), read(x, z - 1))),
        Math.min(read(x + 1, z - 1), Math.max(read(x + 1, z), read(x, z - 1))),
        Math.min(read(x - 1, z + 1), Math.max(read(x - 1, z), read(x, z + 1))),
        Math.min(read(x + 1, z + 1), Math.max(read(x + 1, z), read(x, z + 1))),
      );
      out[z * gridX + x] = clamp01(
        Math.max(
          own * 0.88 + blurred * 0.12,
          blurred * 0.94,
          elbowBridge * 0.84,
          diagonalBridge * 0.78,
          maxNeighbor * 0.22,
        ),
      );
    }
  }
  return out;
}

function buildSmoothedHeights(
  source: Float32Array,
  supports: Float32Array,
  gridX: number,
  gridZ: number,
) {
  const out = new Float32Array(source.length);
  for (let z = 0; z < gridZ; z++) {
    for (let x = 0; x < gridX; x++) {
      const index = z * gridX + x;
      const ownSupport = supports[index];
      if (ownSupport <= 0.0001) {
        out[index] = source[index];
        continue;
      }
      let totalWeight = 0;
      let totalValue = 0;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= gridX || nz >= gridZ) continue;
          const sampleIndex = nz * gridX + nx;
          const support = supports[sampleIndex];
          if (support <= 0.0001) continue;
          const distance = Math.hypot(dx, dz);
          const weight = (1 / (1 + distance * 1.2)) * support;
          totalWeight += weight;
          totalValue += source[sampleIndex] * weight;
        }
      }
      const blurred = totalWeight > 0.0001 ? totalValue / totalWeight : source[index];
      out[index] = lerp(source[index], blurred, 0.74);
    }
  }
  return out;
}

function sampleFeatherHeight(
  heights: Float32Array,
  supports: Float32Array,
  bedHeights: Float32Array,
  gridX: number,
  gridZ: number,
  vx: number,
  vz: number,
  terrainY: number,
) {
  let totalWeight = 0;
  let totalHeight = 0;
  let totalBedY = 0;
  const localIndex = vz * gridX + vx;
  const localBedY = Number.isFinite(bedHeights[localIndex])
    ? bedHeights[localIndex]
    : terrainY;

  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = vx + dx;
      const nz = vz + dz;
      if (nx < 0 || nz < 0 || nx >= gridX || nz >= gridZ) continue;
      const index = nz * gridX + nx;
      const support = supports[index];
      if (support <= 0.001) continue;
      const distance = Math.hypot(dx, dz);
      const weight = support / (1 + distance * 0.85);
      totalWeight += weight;
      totalHeight += heights[index] * weight;
      totalBedY += (Number.isFinite(bedHeights[index]) ? bedHeights[index] : terrainY) * weight;
    }
  }

  if (totalWeight <= 0.0001) {
    return localBedY + FILM_SURFACE_OFFSET * 0.35;
  }

  const supportedHeight = totalHeight / totalWeight;
  const supportedBedY = totalBedY / totalWeight;
  const featherHeight = lerp(
    Math.max(localBedY, supportedBedY) + FILM_SURFACE_OFFSET * 0.35,
    supportedHeight,
    0.86,
  );
  return Math.max(supportedHeight - FILM_EDGE_MAX_VERTICAL_DROP, featherHeight);
}

function sampleFeatherInfluence(
  supports: Float32Array,
  gridX: number,
  gridZ: number,
  vx: number,
  vz: number,
) {
  let totalWeight = 0;
  let totalSupport = 0;

  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = vx + dx;
      const nz = vz + dz;
      if (nx < 0 || nz < 0 || nx >= gridX || nz >= gridZ) continue;
      const index = nz * gridX + nx;
      const support = supports[index];
      if (support <= 0.001) continue;
      const distance = Math.hypot(dx, dz);
      const weight = 1 / (1 + distance * 0.85);
      totalWeight += weight;
      totalSupport += support * weight;
    }
  }

  if (totalWeight <= 0.0001) return 0;
  return clamp01(totalSupport / totalWeight);
}

function sampleEdgeExposure(
  geometrySupports: Float32Array,
  renderSupports: Float32Array,
  gridX: number,
  gridZ: number,
  vx: number,
  vz: number,
  neighborGeoSupports?: {
    north: Float32Array | null;
    south: Float32Array | null;
    west: Float32Array | null;
    east: Float32Array | null;
    neighborGridX: number;
    neighborGridZ: number;
  } | null,
) {
  const index = vz * gridX + vx;
  const own = geometrySupports[index];
  if (own <= 0.001) return 0;

  // Helper: get geometry support at (nx, nz), possibly from a neighbor section.
  const getNeighborGeo = (nx: number, nz: number): number => {
    if (nx >= 0 && nx < gridX && nz >= 0 && nz < gridZ) {
      return geometrySupports[nz * gridX + nx];
    }
    if (!neighborGeoSupports) return 0;
    const ngx = neighborGeoSupports.neighborGridX;
    const ngz = neighborGeoSupports.neighborGridZ;
    if (nx < 0 && neighborGeoSupports.west) {
      const nnx = ngx + nx; // e.g. nx=-1 → last column of west
      if (nnx >= 0 && nz >= 0 && nnx < ngx && nz < ngz)
        return neighborGeoSupports.west[nz * ngx + nnx];
    }
    if (nx >= gridX && neighborGeoSupports.east) {
      const nnx = nx - gridX;
      if (nnx >= 0 && nz >= 0 && nnx < ngx && nz < ngz)
        return neighborGeoSupports.east[nz * ngx + nnx];
    }
    if (nz < 0 && neighborGeoSupports.north) {
      const nnz = ngz + nz;
      if (nx >= 0 && nnz >= 0 && nx < ngx && nnz < ngz)
        return neighborGeoSupports.north[nnz * ngx + nx];
    }
    if (nz >= gridZ && neighborGeoSupports.south) {
      const nnz = nz - gridZ;
      if (nx >= 0 && nnz >= 0 && nx < ngx && nnz < ngz)
        return neighborGeoSupports.south[nnz * ngx + nx];
    }
    return 0; // truly open (no neighbor section covers this direction)
  };

  let totalWeight = 0;
  let geometryTotal = 0;
  let renderTotal = 0;
  let directOpen = 0;
  let directWeight = 0;

  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dz === 0) continue;
      const nx = vx + dx;
      const nz = vz + dz;
      const dist = Math.abs(dx) + Math.abs(dz);
      const isDirect = dist === 1;
      if (nx < 0 || nz < 0 || nx >= gridX || nz >= gridZ) {
        if (isDirect) {
          directWeight += 1;
          const neighborGeo = getNeighborGeo(nx, nz);
          if (neighborGeo <= 0.001) {
            directOpen += 1;
          }
        } else if (dist === 2) {
          directWeight += 0.45;
          const neighborGeo = getNeighborGeo(nx, nz);
          if (neighborGeo <= 0.001) {
            directOpen += 0.45;
          }
        }
        continue;
      }
      const sampleIndex = nz * gridX + nx;
      const weight = isDirect ? 1 : dist === 2 ? 0.45 : 0.22;
      const geometry = geometrySupports[sampleIndex];
      const render = renderSupports[sampleIndex];
      totalWeight += weight;
      geometryTotal += geometry * weight;
      renderTotal += Math.max(geometry, render) * weight;
      if (isDirect) {
        directWeight += 1;
        if (geometry <= 0.001) directOpen += 1;
      } else if (dist === 2) {
        directWeight += 0.45;
        if (geometry <= 0.001) directOpen += 0.45;
      }
    }
  }

  if (totalWeight <= 0.0001) return 1;

  const geometryAverage = geometryTotal / totalWeight;
  const renderAverage = renderTotal / totalWeight;
  const openness = directWeight > 0 ? directOpen / directWeight : 0;
  const supportDrop = clamp01((own - geometryAverage) / Math.max(0.08, own));
  const topologyHalo = clamp01((renderAverage - geometryAverage) * 1.8);
  return clamp01(openness * 0.76 + supportDrop * 0.66 + topologyHalo * 0.12);
}

function makeMaterial(scene: Scene) {
  const material = new PBRMaterial("dve_shallow_film_material", scene);
  material.albedoColor = new Color3(0.14, 0.33, 0.45);
  material.emissiveColor = new Color3(0.006, 0.014, 0.022);
  material.roughness = 0.04;
  material.metallic = 0;
  material.indexOfRefraction = 1.33;
  material.alpha = 0.88;
  material.backFaceCulling = false;
  // forceDepthWrite must be false so the continuous water mesh can show through
  // transparent/handoff zones of the shallow film. With true, depth writes block
  // the underlying continuous surface from rendering even at alpha=0.
  material.forceDepthWrite = false;
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  material.alphaCutOff = 0.02;
  material.environmentIntensity = 1.35;
  material.useRadianceOverAlpha = true;
  material.useSpecularOverAlpha = true;
  material.subSurface.isRefractionEnabled = true;
  material.subSurface.refractionIntensity = 0.18;
  (material as any).useVertexColors = true;
  (material as any).hasVertexAlpha = true;

  try {
    const bump = new Texture(
      WATER_NORMAL_PATH,
      scene,
      false,
      true,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    bump.wrapU = Texture.WRAP_ADDRESSMODE;
    bump.wrapV = Texture.WRAP_ADDRESSMODE;
    bump.uScale = 12;
    bump.vScale = 12;
    bump.level = 0.15;
    material.bumpTexture = bump;

    // Second normal layer — same texture, different scale + opposite scroll direction
    const bump2 = new Texture(
      WATER_NORMAL_PATH,
      scene,
      false,
      true,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    bump2.wrapU = Texture.WRAP_ADDRESSMODE;
    bump2.wrapV = Texture.WRAP_ADDRESSMODE;
    bump2.uScale = 7;
    bump2.vScale = 7;
    material.detailMap.texture = bump2;
    material.detailMap.isEnabled = true;
    material.detailMap.diffuseBlendLevel = 0;
    material.detailMap.roughnessBlendLevel = 0;
    material.detailMap.bumpLevel = 0.10;
  } catch {
    // Optional texture only.
  }

  return material;
}

export type DVEShallowWaterFilmSectionData = ShallowFilmSectionRenderData;

export class DVEShallowWaterFilmRenderer {
  private readonly sections = new Map<string, SectionRecord>();
  /** Maps "${originX}|${originZ}" → sectionKey for fast neighbor lookup */
  private readonly originIndex = new Map<string, string>();
  private readonly material: PBRMaterial;
  private readonly scene: Scene;
  private disposed = false;
  private time = 0;
  private uvOffsetU = 0;
  private uvOffsetV = 0;
  /** Second normal layer scrolls in the opposite direction for surface detail breakup */
  private uvOffsetU2 = 0;
  private uvOffsetV2 = 0;
  private localFluidContributions: DVEShallowWaterLocalFluidContributionState | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
    this.material = makeMaterial(scene);
  }

  setLocalFluidContributions(
    state: DVEShallowWaterLocalFluidContributionState | null,
  ) {
    this.localFluidContributions = state;
  }

  updateSection(sectionKey: string, data: DVEShallowWaterFilmSectionData) {
    let record = this.sections.get(sectionKey);
    if (!record) {
      const mesh = new Mesh(`dve_shallow_film_${sectionKey}`, this.scene);
      mesh.isPickable = false;
      mesh.renderingGroupId = 1;
      mesh.receiveShadows = false;
      mesh.material = this.material;
      record = {
        key: sectionKey,
        mesh,
        skirtMesh: null,
        skirtQuadCount: 0,
        data,
        pendingDispose: false,
        dirty: true,
        gridX: 0,
        gridZ: 0,
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        uvs: new Float32Array(0),
        colors: new Float32Array(0),
        indices: new Uint32Array(0),
        initialized: false,
        geometrySupports: new Float32Array(0),
        displayHeights: new Float32Array(0),
        smoothedHandoffBlends: new Float32Array(0),
        frameDelta: 0,
      };
      this.sections.set(sectionKey, record);
      this.originIndex.set(`${data.originX}|${data.originZ}`, sectionKey);
      return;
    }

    if (record.data.originX !== data.originX || record.data.originZ !== data.originZ) {
      this.originIndex.delete(`${record.data.originX}|${record.data.originZ}`);
      this.originIndex.set(`${data.originX}|${data.originZ}`, sectionKey);
    }
    record.data = data;
    record.pendingDispose = false;
    record.dirty = true;
  }

  removeSection(sectionKey: string) {
    const record = this.sections.get(sectionKey);
    if (!record) return;
    this.originIndex.delete(`${record.data.originX}|${record.data.originZ}`);
    record.pendingDispose = true;
    record.mesh.setEnabled(false);
    if (record.skirtMesh) record.skirtMesh.setEnabled(false);
    delete getShallowFilmDebugStore()[sectionKey];
  }

  update(deltaSeconds: number, activeSectionKeys?: ReadonlySet<string>) {
    if (this.disposed) return;
    this.time += deltaSeconds;

    let flowX = 0;
    let flowZ = 0;
    let flowWeight = 0;
    for (const [key, record] of this.sections) {
      if (record.pendingDispose || (activeSectionKeys && !activeSectionKeys.has(key))) {
        continue;
      }
      for (const column of record.data.columns) {
        if (!column.active || column.coverage <= 0) continue;
        const weight = column.coverage * Math.max(0.1, column.flowSpeed);
        flowX += column.flowX * weight;
        flowZ += column.flowZ * weight;
        flowWeight += weight;
      }
    }

    const avgFlowX = flowWeight > 0.0001 ? flowX / flowWeight : 0;
    const avgFlowZ = flowWeight > 0.0001 ? flowZ / flowWeight : 0;
    this.uvOffsetU += (avgFlowX * FILM_UV_SCROLL + 0.0012) * deltaSeconds;
    this.uvOffsetV += (avgFlowZ * FILM_UV_SCROLL + 0.0009) * deltaSeconds;
    // Second layer scrolls in reverse direction for detail breakup
    this.uvOffsetU2 -= (avgFlowX * FILM_UV_SCROLL * 0.65 + 0.0008) * deltaSeconds;
    this.uvOffsetV2 += (avgFlowZ * FILM_UV_SCROLL * 0.45 + 0.0006) * deltaSeconds;

    // ── Per-material animation driven by average volume maturity ─────────────
    // Compute avg deepBlend and mergeBlend across active sections for material-level tuning.
    let avgDeep = 0; let avgMerge = 0; let matCount = 0;
    for (const [, rec] of this.sections) {
      if (rec.pendingDispose || (activeSectionKeys && !activeSectionKeys.has(rec.key))) continue;
      for (const col of rec.data.columns) {
        if (!col.active || col.coverage <= 0) continue;
        avgDeep  += col.deepBlend;
        avgMerge += col.mergeBlend;
        matCount += 1;
      }
    }
    if (matCount > 0) { avgDeep /= matCount; avgMerge /= matCount; }
    const avgMaturity = clamp01(avgDeep * 0.55 + avgMerge * 0.30 + 0.15 * Math.min(1, matCount / 80));

    // Roughness: puddles are rough (0.06), lakes are nearly mirror-smooth (0.02)
    this.material.roughness = lerp(0.06, 0.02, avgMaturity);
    // Environment intensity: lakes catch more sky reflection
    this.material.environmentIntensity = lerp(1.1, 2.2, avgMaturity);

    // Bump (normal map): puddles use high-frequency ripples (uScale 14), lakes use
    // broad low-frequency swells (uScale 6) that look like rolling ocean surface.
    const bump = this.material.bumpTexture as import("@babylonjs/core/Materials/Textures/texture").Texture | null;
    if (bump) {
      bump.uOffset = this.uvOffsetU * 4;
      bump.vOffset = this.uvOffsetV * 4;
      bump.uScale = lerp(14, 5, avgMaturity);
      bump.vScale = lerp(14, 5, avgMaturity);
      bump.level  = lerp(0.22, 0.08, avgMaturity); // smoother normals for calm lake
    }
    const bump2 = this.material.detailMap.texture as import("@babylonjs/core/Materials/Textures/texture").Texture | null;
    if (bump2) {
      bump2.uOffset = this.uvOffsetU2 * 3;
      bump2.vOffset = this.uvOffsetV2 * 3;
      bump2.uScale = lerp(9, 4, avgMaturity);
      bump2.vScale = lerp(9, 4, avgMaturity);
      this.material.detailMap.bumpLevel = lerp(0.10, 0.04, avgMaturity);
    }

    const toDispose: string[] = [];
    for (const [key, record] of this.sections) {
      if (record.pendingDispose || (activeSectionKeys && !activeSectionKeys.has(key))) {
        record.mesh.setEnabled(false);
        toDispose.push(key);
        continue;
      }
      // Always rebuild initialized sections every frame: ripple heights and UV
      // scroll are time-based and must be recomputed continuously for animation.
      // Only skip if never initialized (first frame will run regardless).
      if (!record.dirty && !record.initialized) continue;
      record.frameDelta = deltaSeconds;
      this.rebuildSection(record);
      record.dirty = false;
    }

    // Border stitch pass: enforce matching vertex heights at shared section edges.
    this.stitchBorderVertices();

    for (const key of toDispose) {
      const record = this.sections.get(key);
      if (!record) continue;
      record.mesh.dispose();
      if (record.skirtMesh) record.skirtMesh.dispose();
      this.sections.delete(key);
      delete getShallowFilmDebugStore()[key];
    }
  }

  /**
   * For each pair of adjacent sections, enforce identical Y positions on the shared border
   * vertices. This eliminates topological seams caused by independently smoothed heights.
   * We stitch east-border of A with west-border of B, and south-border of A with north-border of B.
   */
  private stitchBorderVertices() {
    for (const record of this.sections.values()) {
      if (record.pendingDispose || !record.initialized) continue;
      const film = record.data;
      const { originX, originZ, sizeX, sizeZ } = film;
      const gridX = record.gridX;
      const gridZ = record.gridZ;

      // --- East border: last column of this section vs first column of eastern neighbor ---
      const eastKey = this.originIndex.get(`${originX + sizeX}|${originZ}`);
      if (eastKey) {
        const eastRec = this.sections.get(eastKey);
        if (eastRec && !eastRec.pendingDispose && eastRec.initialized && eastRec.gridZ === gridZ) {
          const eGridX = eastRec.gridX;
          let posChanged = false;
          for (let vz = 0; vz < gridZ; vz++) {
            const idxA = (vz * gridX + (gridX - 1)) * 3 + 1; // Y of last column in A
            const idxB = (vz * eGridX + 0) * 3 + 1;           // Y of first column in B
            const yA = record.positions[idxA];
            const yB = eastRec.positions[idxB];
            if (yA === 0 && yB === 0) continue;
            const avg = (yA + yB) * 0.5;
            if (yA !== avg) { record.positions[idxA] = avg; posChanged = true; }
            if (yB !== avg) { eastRec.positions[idxB] = avg; }
          }
          if (posChanged) {
            record.mesh.updateVerticesData(VertexBuffer.PositionKind, record.positions, false, false);
          }
          eastRec.mesh.updateVerticesData(VertexBuffer.PositionKind, eastRec.positions, false, false);
        }
      }

      // --- South border: last row of this section vs first row of southern neighbor ---
      const southKey = this.originIndex.get(`${originX}|${originZ + sizeZ}`);
      if (southKey) {
        const southRec = this.sections.get(southKey);
        if (southRec && !southRec.pendingDispose && southRec.initialized && southRec.gridX === gridX) {
          const sGridX = southRec.gridX;
          let posChanged = false;
          for (let vx = 0; vx < gridX; vx++) {
            const idxA = ((gridZ - 1) * gridX + vx) * 3 + 1; // Y of last row in A
            const idxB = (0 * sGridX + vx) * 3 + 1;           // Y of first row in B
            const yA = record.positions[idxA];
            const yB = southRec.positions[idxB];
            if (yA === 0 && yB === 0) continue;
            const avg = (yA + yB) * 0.5;
            if (yA !== avg) { record.positions[idxA] = avg; posChanged = true; }
            if (yB !== avg) { southRec.positions[idxB] = avg; }
          }
          if (posChanged) {
            record.mesh.updateVerticesData(VertexBuffer.PositionKind, record.positions, false, false);
          }
          southRec.mesh.updateVerticesData(VertexBuffer.PositionKind, southRec.positions, false, false);
        }
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.sections.values()) {
      record.mesh.dispose();
      if (record.skirtMesh) record.skirtMesh.dispose();
    }
    this.sections.clear();
    this.material.dispose();
  }

  private rebuildSection(record: SectionRecord) {
    const film = record.data;
    const { sizeX, sizeZ, originX, originZ } = film;
    if (sizeX <= 0 || sizeZ <= 0 || film.activeColumnCount <= 0) {
      record.mesh.setEnabled(false);
      if (record.skirtMesh) record.skirtMesh.setEnabled(false);
      delete getShallowFilmDebugStore()[record.key];
      return;
    }

    ensureTopology(record, sizeX, sizeZ);

    const gridX = record.gridX;
    const gridZ = record.gridZ;
    const vertexCount = gridX * gridZ;
    const useSparseSupportField =
      film.activeColumnCount <= FILM_SPARSE_ACTIVE_COLUMN_THRESHOLD;
    const frameDt = record.frameDelta > 0 ? record.frameDelta : 1 / 60;
    const handoffRiseBlend = getTemporalBlend(frameDt, FILM_HANDOFF_BLEND_RISE_TAU);
    const handoffFallBlend = getTemporalBlend(frameDt, FILM_HANDOFF_BLEND_FALL_TAU);
    const heights = new Float32Array(vertexCount);
    const supports = new Float32Array(vertexCount);
    const bedHeights = new Float32Array(vertexCount);
    const thicknesses = new Float32Array(vertexCount);
    const settledValues = new Float32Array(vertexCount);
    const shoreValues = new Float32Array(vertexCount);
    const foamValues = new Float32Array(vertexCount);
    const wetnessValues = new Float32Array(vertexCount);
    const turbidityValues = new Float32Array(vertexCount);
    const flowXValues = new Float32Array(vertexCount);
    const flowZValues = new Float32Array(vertexCount);
    const mergeBlendValues = new Float32Array(vertexCount);
    const deepBlendValues = new Float32Array(vertexCount);
    const handoffBlendValues = new Float32Array(vertexCount);

    let activeVertexCount = 0;
    let maxAlpha = 0;

    const getNeighborFilm = (ox: number, oz: number): ShallowFilmSectionRenderData | null => {
      const nk = this.originIndex.get(`${ox}|${oz}`);
      if (!nk) return null;
      const nr = this.sections.get(nk);
      return nr && !nr.pendingDispose ? nr.data : null;
    };
    const getNeighborRecord = (ox: number, oz: number): SectionRecord | null => {
      const nk = this.originIndex.get(`${ox}|${oz}`);
      if (!nk) return null;
      const nr = this.sections.get(nk);
      return nr && !nr.pendingDispose ? nr : null;
    };
    const neighborFilmData: NeighborFilmData = {
      north: getNeighborFilm(originX, originZ - sizeZ),
      south: getNeighborFilm(originX, originZ + sizeZ),
      west:  getNeighborFilm(originX - sizeX, originZ),
      east:  getNeighborFilm(originX + sizeX, originZ),
    };
    const neighborGeoSupports = {
      north: getNeighborRecord(originX, originZ - sizeZ)?.geometrySupports ?? null,
      south: getNeighborRecord(originX, originZ + sizeZ)?.geometrySupports ?? null,
      west:  getNeighborRecord(originX - sizeX, originZ)?.geometrySupports ?? null,
      east:  getNeighborRecord(originX + sizeX, originZ)?.geometrySupports ?? null,
      neighborGridX: gridX,
      neighborGridZ: gridZ,
    };

    for (let vz = 0; vz < gridZ; vz++) {
      for (let vx = 0; vx < gridX; vx++) {
        const vertexIndex = vz * gridX + vx;
        const localX = vx / FILM_SUBDIVISION;
        const localZ = vz / FILM_SUBDIVISION;
        const sample = sampleVertex(
          film,
          localX,
          localZ,
          neighborFilmData,
          useSparseSupportField ? FILM_SPARSE_SAMPLE_RADIUS : FILM_SAMPLE_RADIUS,
          useSparseSupportField ? FILM_SPARSE_LOCAL_ANCHOR_MIN : 0.015,
        );
        if (!sample) continue;
        const previousHandoffBlend =
          record.smoothedHandoffBlends[vertexIndex] ?? sample.handoffBlend;
        const handoffBlend = lerp(
          previousHandoffBlend,
          sample.handoffBlend,
          sample.handoffBlend >= previousHandoffBlend
            ? handoffRiseBlend
            : handoffFallBlend,
        );
        record.smoothedHandoffBlends[vertexIndex] = handoffBlend;
        const localFluid = sampleLocalFluid(
          this.localFluidContributions,
          originX + localX,
          originZ + localZ,
        );
        const combinedFlowSpeed = Math.max(sample.flowSpeed, localFluid.flowSpeed);

        // Near the handoff boundary water accelerates toward the deeper body;
        // boost effective flow speed slightly to amplify directional wave activity.
        const handoffBoost = handoffBlend; // [0,1] temporally damped proximity to continuous water
        const stableFlow = Math.min(0.85, combinedFlowSpeed * (1 + handoffBoost * 0.45));
        const stableFluidFill = localFluid.fill * 0.55;
        const stableFluidFoam = localFluid.foam * 0.42;

        // ── Volume maturity: 0 = puddle/thin film, 1 = lake/river body ─────────
        // Combines depth (thickness), how established the patch is (deepBlend),
        // and how merged/wide it is (mergeBlend). Used to evolve all visual traits.
        const volumeMaturity = clamp01(
          sample.deepBlend * 0.48 +
          sample.mergeBlend * 0.28 +
          clamp01(sample.thickness / 2.2) * 0.24,
        );

        // Ripple behaviour:
        // – Puddle: fast, small, high-frequency splash ripples.
        // – Lake:   slow, large, low-frequency ocean swell.
        // Near the handoff zone, amplitude and speed are boosted further to
        // simulate the water rushing and churning as it joins the larger body.
        const rippleAmplitude = lerp(0.55, 3.2, volumeMaturity) * (1 + handoffBoost * 0.80);
        const primarySpeed   = lerp(1.55, 0.52, volumeMaturity) * (1 + handoffBoost * 0.60); // rad/s for primary wave
        const transverseSpeed = lerp(0.72, 0.28, volumeMaturity) * (1 + handoffBoost * 0.35); // rad/s for cross wave
        const swellFrequency  = lerp(0.84, 0.38, volumeMaturity); // spatial frequency

        // Flow-directional ripple: primary crests travel along flow; transverse
        // ripples run perpendicular. Falls back to fixed-angle when water is still.
        const worldX = originX + localX;
        const worldZ = originZ + localZ;
        const fX = stableFlow > 0.05 ? sample.flowX : 0.45;
        const fZ = stableFlow > 0.05 ? sample.flowZ : 0.52;
        const flowPhase = worldX * fX * swellFrequency + worldZ * fZ * swellFrequency;
        const transPhase = worldX * (-fZ) * (swellFrequency * 0.52) + worldZ * fX * (swellFrequency * 0.52);
        // Damp ripples per-vertex as each cell hands off to continuous water.
        // Higher handoffBlend = closer to the continuous body = quieter surface.
        // This is per-vertex so only cells physically adjacent to continuous water
        // calm down — cells further away keep their full motion.
        const rippleDamp = 1 - handoffBlend * 0.88;
        // Primary + transverse waves base
        const baseRipple =
          Math.sin(
            flowPhase + this.time * (primarySpeed + stableFlow * 0.55),
          ) *
            FILM_RIPPLE_SCALE * rippleAmplitude *
            (0.18 +
              sample.microRipple * (0.52 - sample.mergeBlend * 0.1) +
              stableFluidFill * 0.14) +
          Math.cos(
            transPhase + this.time * transverseSpeed,
          ) *
            FILM_RIPPLE_SCALE * rippleAmplitude *
            0.32 *
            (0.16 + sample.foam * 0.42 + stableFluidFoam * 0.24) *
            (1 - handoffBlend * 0.12);

        // Surge wave: directional rush toward the deeper body. Higher spatial
        // frequency and ~1.8x faster than the primary wave. Active only near
        // the handoff boundary so the shallow borderland looks like it is
        // accelerating and feeding into the continuous water volume.
        const surgeFreq = swellFrequency * 1.7;
        const surgePhase = worldX * fX * surgeFreq + worldZ * fZ * surgeFreq;
        const surgeRipple = handoffBoost > 0.05
          ? Math.sin(surgePhase + this.time * (primarySpeed * 1.85 + stableFlow * 0.9))
              * FILM_RIPPLE_SCALE * rippleAmplitude
              * 0.52 * handoffBoost
              * (0.22 + sample.mergeBlend * 0.32 + sample.deepBlend * 0.16)
          : 0;

        const ripple =
          (baseRipple + surgeRipple) * rippleDamp * (useSparseSupportField ? 0.18 : 1);

        const patchLift =
          sample.thickness *
          (sample.mergeBlend * 0.16 + sample.deepBlend * 0.24 + handoffBlend * 0.22) *
          (useSparseSupportField ? 0.12 : 1);

        let targetHeight =
          sample.surfaceY +
          FILM_SURFACE_OFFSET +
          patchLift +
          stableFluidFill * 0.0016 +
          ripple;
        if (useSparseSupportField) {
          targetHeight = Math.min(
            targetHeight,
            sample.surfaceY + FILM_SURFACE_OFFSET + FILM_SPARSE_MAX_LIFT,
          );
        }
        // Alpha grows progressively with volume maturity: a thin puddle is nearly
        // transparent; a deep lake body is nearly fully opaque.
        const maturityAlphaBoost = volumeMaturity * 0.28;
        const targetAlpha =
          clamp01(
          FILM_ALPHA_BIAS +
            sample.filmOpacity * (FILM_ALPHA_WETNESS + sample.wetness * 0.12) +
            Math.max(sample.foam, stableFluidFoam) * FILM_ALPHA_FOAM +
            stableFlow * FILM_ALPHA_FLOW +
            stableFluidFill * 0.045 +
            sample.mergeBlend * 0.032 +
            sample.deepBlend * 0.048 -
            handoffBlend * 0.028 +
            sample.turbidity * 0.12 +
            maturityAlphaBoost,
        ) *
          clamp01(
            sample.coverage * (0.84 + sample.mergeBlend * 0.12 + sample.deepBlend * 0.06),
          ) *
          clamp01(0.2 + sample.localAnchor * 0.95);
        const previousHeight =
          record.initialized ? record.positions[vertexIndex * 3 + 1] : targetHeight;
        const previousAlpha =
          record.initialized ? record.colors[vertexIndex * 4 + 3] : targetAlpha;
        const heightBlend = clamp01(
          (useSparseSupportField ? 0.72 : FILM_TEMPORAL_HEIGHT_BLEND) +
            sample.mergeBlend * 0.1 +
            sample.deepBlend * 0.08 +
            Math.min(0.08, combinedFlowSpeed * 0.04),
        );
        const alphaBlend = clamp01(
          (useSparseSupportField ? 0.76 : FILM_TEMPORAL_ALPHA_BLEND) +
            sample.mergeBlend * 0.08 +
            sample.deepBlend * 0.06,
        );
        const height = lerp(previousHeight, targetHeight, heightBlend);
        const alpha = lerp(previousAlpha, targetAlpha, alphaBlend);
        const targetSupport = clamp01(
          (sample.coverage +
            sample.mergeBlend * 0.18 +
            sample.deepBlend * 0.12 +
            handoffBlend * 0.06 +
            stableFluidFill * 0.08) *
            clamp01(0.16 + sample.localAnchor * 1.05),
        );

        heights[vertexIndex] = height;
        supports[vertexIndex] = targetSupport;
        bedHeights[vertexIndex] = sample.bedY;
        thicknesses[vertexIndex] = sample.thickness;
        settledValues[vertexIndex] = sample.settled;
        shoreValues[vertexIndex] = sample.shoreDist;
        foamValues[vertexIndex] = Math.max(sample.foam, localFluid.foam * 0.82);
        wetnessValues[vertexIndex] = clamp01(sample.wetness + localFluid.fill * 0.22);
        turbidityValues[vertexIndex] = sample.turbidity;
        flowXValues[vertexIndex] =
          combinedFlowSpeed > 0.0001
            ? (sample.flowX * sample.flowSpeed + localFluid.flowX * 0.6) /
              Math.max(0.0001, sample.flowSpeed + 0.6)
            : localFluid.flowX;
        flowZValues[vertexIndex] =
          combinedFlowSpeed > 0.0001
            ? (sample.flowZ * sample.flowSpeed + localFluid.flowZ * 0.6) /
              Math.max(0.0001, sample.flowSpeed + 0.6)
            : localFluid.flowZ;
        mergeBlendValues[vertexIndex] = sample.mergeBlend;
        deepBlendValues[vertexIndex] = sample.deepBlend;
        handoffBlendValues[vertexIndex] = handoffBlend;

        record.positions[vertexIndex * 3 + 0] = originX + localX;
        record.positions[vertexIndex * 3 + 1] = height;
        record.positions[vertexIndex * 3 + 2] = originZ + localZ;
        record.colors[vertexIndex * 4 + 3] = alpha;
        maxAlpha = Math.max(maxAlpha, alpha);
        activeVertexCount += 1;
      }
    }

    if (activeVertexCount <= 0 || maxAlpha <= 0.01) {
      record.mesh.setEnabled(false);
      if (record.skirtMesh) record.skirtMesh.setEnabled(false);
      delete getShallowFilmDebugStore()[record.key];
      return;
    }

    const smoothedSupports = buildSmoothedSupports(supports, gridX, gridZ);
    const topologySupports = buildTopologySupports(smoothedSupports, gridX, gridZ);
    const geometrySupports = smoothedSupports;
    const renderSupports = useSparseSupportField ? smoothedSupports : topologySupports;
    // Cache renderSupports for neighbor skirt suppression (topology-dilated, smoother boundaries)
    record.geometrySupports = renderSupports;
    const smoothedHeights = buildSmoothedHeights(
      heights,
      geometrySupports,
      gridX,
      gridZ,
    );
    const displayHeights = new Float32Array(vertexCount);
    const displayAlphas = new Float32Array(vertexCount);
    const edgeExposureValues = new Float32Array(vertexCount);

    // No section-level temporal lerp needed — handoffBlend is already a smooth
    // runtime value that changes gradually as water flows out of the section.
    // Per-vertex dissolve is driven directly by handoffBlend so each cell
    // completes its fade independently and the transition always finishes.

    rebuildDynamicIndices(
      record,
      sizeX * FILM_SUBDIVISION,
      sizeZ * FILM_SUBDIVISION,
      gridX,
      geometrySupports,
      smoothedHeights,
    );

    for (let vz = 0; vz < gridZ; vz++) {
      for (let vx = 0; vx < gridX; vx++) {
        const index = vz * gridX + vx;
        const geometrySupport = geometrySupports[index];
        const support = renderSupports[index];

        if (geometrySupport > 0.001) {
          const featherHeight = sampleFeatherHeight(
            smoothedHeights,
            geometrySupports,
            bedHeights,
            gridX,
            gridZ,
            vx,
            vz,
            film.terrainY,
          );
          const mergeBlend = mergeBlendValues[index];
          const deepBlend = deepBlendValues[index];
          const handoffBlend = handoffBlendValues[index];
          const smoothedSurfaceHeight = lerp(
            heights[index],
            smoothedHeights[index],
            clamp01(0.52 + mergeBlend * 0.18 + deepBlend * 0.2 + handoffBlend * 0.08),
          );
          const supportBlend = clamp01(
            geometrySupport * FILM_FEATHER_BLEND + mergeBlend * 0.08 + deepBlend * 0.06,
          );
          const baseDisplayHeight = lerp(featherHeight, smoothedSurfaceHeight, supportBlend);
          const edgeExposure = sampleEdgeExposure(
            geometrySupports,
            renderSupports,
            gridX,
            gridZ,
            vx,
            vz,
            neighborGeoSupports,
          );
          const edgePull = clamp01(
            edgeExposure *
              (FILM_EDGE_HEIGHT_PULL - geometrySupport * 0.12 + mergeBlend * 0.04 + deepBlend * 0.05),
          );
          displayHeights[index] = Math.max(
            baseDisplayHeight - FILM_EDGE_MAX_VERTICAL_DROP,
            lerp(baseDisplayHeight, featherHeight, edgePull),
          );
          if (useSparseSupportField) {
            displayHeights[index] = Math.min(
              displayHeights[index],
              heights[index] + FILM_SPARSE_MAX_LIFT,
            );
          }
          // Dissolve per-vertex as each cell's handoffBlend approaches 1.
          // Cubic smoothstep on per-vertex handoffBlend:
          //   handoffBlend < 0.20 → fully visible (far from continuous water)
          //   handoffBlend > 0.85 → fully transparent (directly adjacent / handed off)
          // This ensures the transition always completes naturally without getting
          // stuck at a partial fade driven by a section-level average.
          const _hT = clamp01((handoffBlend - 0.20) / (0.85 - 0.20));
          const localHandoffFade = _hT * _hT * (3 - 2 * _hT);
          displayAlphas[index] = Math.max(
            0,
            record.colors[index * 4 + 3]
              * (1 - edgeExposure * FILM_EDGE_ALPHA_SOFTEN)
              * (1 - localHandoffFade),
          );
          edgeExposureValues[index] = edgeExposure;
          continue;
        }

        const featherInfluence = support > 0.001
          ? sampleFeatherInfluence(geometrySupports, gridX, gridZ, vx, vz)
          : 0;
        displayHeights[index] = sampleFeatherHeight(
          smoothedHeights,
          geometrySupports,
          bedHeights,
          gridX,
          gridZ,
          vx,
          vz,
          film.terrainY,
        );
        displayAlphas[index] =
          support > 0.001
            ? clamp01(featherInfluence * support * FILM_EDGE_FEATHER_ALPHA)
            : 0;
      }
    }

    // Store displayHeights on the record so neighbors can read them for normal computation.
    record.displayHeights.set(displayHeights);

    const getDisplayHeight = (vx: number, vz: number, fallback: number) => {
      // Cross-section lookup: when vx/vz goes out of bounds, sample from neighbor section.
      if (vx >= 0 && vx < gridX && vz >= 0 && vz < gridZ) {
        const index = vz * gridX + vx;
        return renderSupports[index] > 0.001 ? displayHeights[index] : fallback;
      }
      // Determine which neighbor to sample from.
      let neighborFilm: ShallowFilmSectionRenderData | null = null;
      let nx = vx;
      let nz = vz;
      if (vx < 0 && neighborFilmData.west) {
        neighborFilm = neighborFilmData.west;
        nx = neighborFilm.sizeX * FILM_SUBDIVISION + vx;
        nz = vz;
      } else if (vx >= gridX && neighborFilmData.east) {
        neighborFilm = neighborFilmData.east;
        nx = vx - gridX;
        nz = vz;
      } else if (vz < 0 && neighborFilmData.north) {
        neighborFilm = neighborFilmData.north;
        nx = vx;
        nz = neighborFilm.sizeZ * FILM_SUBDIVISION + vz;
      } else if (vz >= gridZ && neighborFilmData.south) {
        neighborFilm = neighborFilmData.south;
        nx = vx;
        nz = vz - gridZ;
      }
      if (!neighborFilm) return fallback;
      const nk = this.originIndex.get(`${neighborFilm.originX}|${neighborFilm.originZ}`);
      if (!nk) return fallback;
      const nr = this.sections.get(nk);
      if (!nr || nr.pendingDispose) return fallback;
      const neighborGridX = neighborFilm.sizeX * FILM_SUBDIVISION + 1;
      const neighborGridZ = neighborFilm.sizeZ * FILM_SUBDIVISION + 1;
      if (nx < 0 || nz < 0 || nx >= neighborGridX || nz >= neighborGridZ) return fallback;
      return nr.displayHeights[nz * neighborGridX + nx] ?? fallback;
    };

    let geometrySupportedVertices = 0;
    let topologyOnlyVertices = 0;
    let minDisplayY = Number.POSITIVE_INFINITY;
    let maxDisplayY = Number.NEGATIVE_INFINITY;

    for (let vz = 0; vz < gridZ; vz++) {
      for (let vx = 0; vx < gridX; vx++) {
        const index = vz * gridX + vx;
        const posOffset = index * 3;
        const uvOffset = index * 2;
        const colorOffset = index * 4;
        const geometrySupport = geometrySupports[index];
        const support = renderSupports[index];
        const center = displayHeights[index];

        if (geometrySupport > 0.001) {
          geometrySupportedVertices += 1;
          const hl = getDisplayHeight(vx - 1, vz, center);
          const hr = getDisplayHeight(vx + 1, vz, center);
          const hd = getDisplayHeight(vx, vz - 1, center);
          const hu = getDisplayHeight(vx, vz + 1, center);
          const nx = -(hr - hl) * 0.8;
          const ny = 2.0;
          const nz = -(hu - hd) * 0.8;
          const len = Math.hypot(nx, ny, nz) || 1;
          record.normals[posOffset + 0] = nx / len;
          record.normals[posOffset + 1] = ny / len;
          record.normals[posOffset + 2] = nz / len;

          const flowX = flowXValues[index];
          const flowZ = flowZValues[index];
          const u = (vx / FILM_SUBDIVISION) / Math.max(1, sizeX);
          const v = (vz / FILM_SUBDIVISION) / Math.max(1, sizeZ);
          record.uvs[uvOffset + 0] = u + flowX * 0.02 + this.uvOffsetU;
          record.uvs[uvOffset + 1] = v + flowZ * 0.02 + this.uvOffsetV;

          const thickness = thicknesses[index];
          const shoreBias = clamp01(1 - shoreValues[index] / 4);
          const settled = settledValues[index];
          const foam = foamValues[index];
          const wetness = wetnessValues[index];
          const turbidity = turbidityValues[index];
          const absorption = Math.exp(-thickness * 2.8);
          const mergeBlend = mergeBlendValues[index];
          const deepBlend = deepBlendValues[index];
          const handoffBlend = handoffBlendValues[index];
          const displayHeight = displayHeights[index];
          record.positions[posOffset + 1] = displayHeight;
          minDisplayY = Math.min(minDisplayY, displayHeight);
          maxDisplayY = Math.max(maxDisplayY, displayHeight);
          // ── Progressive color based on volume maturity ───────────────────────
          // Puddle:  light cyan-turquoise, absorption-driven.
          // Pond:    blue-green, richer.
          // Lake:    deep blue-indigo, dark core, hint of abyssal depth.
          const volumeMaturity = clamp01(
            deepBlend * 0.48 + mergeBlend * 0.28 + clamp01(thickness / 2.2) * 0.24,
          );
          // Clear water: blue-green from depth absorption.
          // Turbid water: warmer/browner — less blue, slight earthy shift.
          const turbidMix = turbidity * 0.42;
          // As body matures: colour base shifts from turquoise toward deep blue-indigo.
          const puddleR = lerp(0.055, 0.14, 1 - absorption);
          const puddleG = lerp(0.16, 0.36, 1 - absorption);
          const puddleB = lerp(0.24, 0.50, 1 - absorption);
          // Lake target: darker, deep-ocean blue (almost navy at max depth)
          const lakeR = lerp(0.01, 0.04, 1 - absorption);
          const lakeG = lerp(0.06, 0.18, 1 - absorption);
          const lakeB = lerp(0.28, 0.56, 1 - absorption);
          const baseR = lerp(puddleR, lakeR, volumeMaturity);
          const baseG = lerp(puddleG, lakeG, volumeMaturity);
          const baseB = lerp(puddleB, lakeB, volumeMaturity);
          const waterR = baseR + turbidMix * lerp(0.14, 0.08, volumeMaturity);
          const waterG = baseG - turbidMix * lerp(0.06, 0.03, volumeMaturity);
          const waterB = baseB - turbidMix * lerp(0.20, 0.08, volumeMaturity);
          const highlight = clamp01(
            foam * (0.18 - mergeBlend * 0.05) +
              shoreBias * (0.08 - mergeBlend * 0.03) +
              (1 - settled) * 0.04 +
              deepBlend * 0.03,
          );
          const targetR = clamp01(lerp(waterR, 0.26, highlight));
          const targetG = clamp01(lerp(waterG, 0.4, highlight));
          const targetB = clamp01(
            lerp(
              waterB,
              0.54,
              highlight * 0.36 + wetness * 0.035 + deepBlend * 0.04 - handoffBlend * 0.025,
            ),
          );
          const colorBlend = clamp01(
            FILM_TEMPORAL_COLOR_BLEND +
              mergeBlend * 0.08 +
              deepBlend * 0.06,
          );
          const prevR = record.initialized ? record.colors[colorOffset + 0] : targetR;
          const prevG = record.initialized ? record.colors[colorOffset + 1] : targetG;
          const prevB = record.initialized ? record.colors[colorOffset + 2] : targetB;
          record.colors[colorOffset + 0] = lerp(prevR, targetR, colorBlend);
          record.colors[colorOffset + 1] = lerp(prevG, targetG, colorBlend);
          record.colors[colorOffset + 2] = lerp(prevB, targetB, colorBlend);
          record.colors[colorOffset + 3] = displayAlphas[index];
        } else {
          if (support > 0.001) {
            topologyOnlyVertices += 1;
          }
          const featherInfluence = support > 0.001
            ? sampleFeatherInfluence(geometrySupports, gridX, gridZ, vx, vz)
            : 0;
          const hl = getDisplayHeight(vx - 1, vz, center);
          const hr = getDisplayHeight(vx + 1, vz, center);
          const hd = getDisplayHeight(vx, vz - 1, center);
          const hu = getDisplayHeight(vx, vz + 1, center);
          const nx = -(hr - hl) * 0.65;
          const ny = 2.0;
          const nz = -(hu - hd) * 0.65;
          const len = Math.hypot(nx, ny, nz) || 1;
          record.normals[posOffset + 0] = nx / len;
          record.normals[posOffset + 1] = ny / len;
          record.normals[posOffset + 2] = nz / len;
          record.uvs[uvOffset + 0] = (vx / FILM_SUBDIVISION) / Math.max(1, sizeX);
          record.uvs[uvOffset + 1] = (vz / FILM_SUBDIVISION) / Math.max(1, sizeZ);
          record.colors[colorOffset + 0] = lerp(0.03, 0.08, featherInfluence);
          record.colors[colorOffset + 1] = lerp(0.08, 0.18, featherInfluence);
          record.colors[colorOffset + 2] = lerp(0.12, 0.28, featherInfluence);
          record.colors[colorOffset + 3] = displayAlphas[index];
          record.positions[posOffset + 0] = originX + vx / FILM_SUBDIVISION;
          const displayHeight = displayHeights[index];
          record.positions[posOffset + 1] = displayHeight;
          minDisplayY = Math.min(minDisplayY, displayHeight);
          maxDisplayY = Math.max(maxDisplayY, displayHeight);
          record.positions[posOffset + 2] = originZ + vz / FILM_SUBDIVISION;
        }
      }
    }

    if (!record.initialized) {
      const vertexData = new VertexData();
      vertexData.positions = Array.from(record.positions);
      vertexData.normals = Array.from(record.normals);
      vertexData.uvs = Array.from(record.uvs);
      vertexData.colors = Array.from(record.colors);
      vertexData.indices = Array.from(record.indices);
      vertexData.applyToMesh(record.mesh, true);
      record.initialized = true;
    } else {
      record.mesh.updateVerticesData(VertexBuffer.PositionKind, record.positions, false, false);
      record.mesh.updateVerticesData(VertexBuffer.NormalKind, record.normals, false, false);
      record.mesh.updateVerticesData(VertexBuffer.UVKind, record.uvs, false, false);
      record.mesh.updateVerticesData(VertexBuffer.ColorKind, record.colors, false, false);
      record.mesh.setIndices(record.indices as any);
    }

    record.mesh.refreshBoundingInfo();
    record.mesh.setEnabled(true);

    // Skirts removed: lateral wall geometry was artificial and visually jarring.
    if (record.skirtMesh) {
      record.skirtMesh.setEnabled(false);
    }

    let renderedQuads = 0;
    for (let offset = 0; offset < record.indices.length; offset += 6) {
      if (record.indices[offset] !== record.indices[offset + 1]) {
        renderedQuads += 1;
      }
    }
    getShallowFilmDebugStore()[record.key] = {
      activeColumnCount: film.activeColumnCount,
      sparsePath: useSparseSupportField,
      activeVertices: activeVertexCount,
      geometrySupportedVertices,
      topologyOnlyVertices,
      renderedQuads,
      maxAlpha,
      minY: Number.isFinite(minDisplayY) ? minDisplayY : film.terrainY,
      maxY: Number.isFinite(maxDisplayY) ? maxDisplayY : film.terrainY,
    };
  }
}
