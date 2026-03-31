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
};

type VertexSample = {
  active: boolean;
  coverage: number;
  filmOpacity: number;
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
};

type LocalFluidSample = {
  flowX: number;
  flowZ: number;
  flowSpeed: number;
  fill: number;
  foam: number;
};

const WATER_NORMAL_PATH = "assets/water/water-001-normal.jpg";
const FILM_SUBDIVISION = 3;
const FILM_SURFACE_OFFSET = 0.0015;
const FILM_RIPPLE_SCALE = 0.00105;
const FILM_ALPHA_BIAS = 0.06;
const FILM_ALPHA_WETNESS = 0.48;
const FILM_ALPHA_FOAM = 0.09;
const FILM_ALPHA_FLOW = 0.05;
const FILM_UV_SCROLL = 0.016;
const FILM_VERTEX_SUPPORT_EPSILON = 0.0014;
const FILM_QUAD_SUPPORT_MIN_AVERAGE = 0.0044;
const FILM_TEMPORAL_HEIGHT_BLEND = 0.24;
const FILM_TEMPORAL_ALPHA_BLEND = 0.18;
const FILM_TEMPORAL_COLOR_BLEND = 0.2;
const FILM_SAMPLE_RADIUS = 3.1;
const FILM_TOPOLOGY_DILATION = 0.18;
const FILM_CORNER_SUPPORT_BIAS = 0.12;
const FILM_FEATHER_BLEND = 0.84;
const FILM_SPARSE_ACTIVE_COLUMN_THRESHOLD = 24;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function lerp(start: number, end: number, alpha: number) {
  return start + (end - start) * alpha;
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
  supports: Float32Array,
) {
  let indexOffset = 0;
  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      const i00 = z * gridX + x;
      const i10 = z * gridX + (x + 1);
      const i01 = (z + 1) * gridX + x;
      const i11 = (z + 1) * gridX + (x + 1);
      const s00 = supports[i00];
      const s10 = supports[i10];
      const s01 = supports[i01];
      const s11 = supports[i11];
      const maxSupport = Math.max(s00, s10, s01, s11);
      const diagonalBridge = Math.max(Math.min(s00, s11), Math.min(s10, s01));
      const supportedVertices =
        (s00 > FILM_VERTEX_SUPPORT_EPSILON ? 1 : 0) +
        (s10 > FILM_VERTEX_SUPPORT_EPSILON ? 1 : 0) +
        (s01 > FILM_VERTEX_SUPPORT_EPSILON ? 1 : 0) +
        (s11 > FILM_VERTEX_SUPPORT_EPSILON ? 1 : 0);
      const averageSupport = (s00 + s10 + s01 + s11) * 0.25;
      const supportEnvelope =
        averageSupport * 0.66 +
        maxSupport * 0.22 +
        diagonalBridge * FILM_CORNER_SUPPORT_BIAS;

      if (
        (supportedVertices >= 2 && supportEnvelope >= FILM_QUAD_SUPPORT_MIN_AVERAGE * 0.84) ||
        diagonalBridge >= 0.02 ||
        maxSupport >= 0.048
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

function sampleVertex(
  film: ShallowFilmSectionRenderData,
  sampleX: number,
  sampleZ: number,
): VertexSample | null {
  let totalWeight = 0;
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
  };

  const minX = Math.max(0, Math.floor(sampleX) - 2);
  const minZ = Math.max(0, Math.floor(sampleZ) - 2);
  const maxX = Math.min(film.sizeX - 1, Math.ceil(sampleX) + 2);
  const maxZ = Math.min(film.sizeZ - 1, Math.ceil(sampleZ) + 2);

  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      const centerX = x + 0.5;
      const centerZ = z + 0.5;
      const dx = centerX - sampleX;
      const dz = centerZ - sampleZ;
      const distance = Math.hypot(dx, dz);
      if (distance > FILM_SAMPLE_RADIUS) continue;
      const radial = Math.max(0, 1 - distance / FILM_SAMPLE_RADIUS);
      const weightScale = radial * radial;
      if (weightScale <= 0.0001) continue;
      accumulate(
        sampleColumn(film.columns, film.sizeX, film.sizeZ, x, z),
        weightScale,
        dx,
        dz,
      );
    }
  }

  if (totalWeight <= 0.0001) return null;

  return {
    active: true,
    coverage: coverage / totalWeight,
    filmOpacity: filmOpacity / totalWeight,
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
  gridX: number,
  gridZ: number,
  vx: number,
  vz: number,
  terrainY: number,
) {
  let totalWeight = 0;
  let totalHeight = 0;

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
    }
  }

  if (totalWeight <= 0.0001) {
    return terrainY + FILM_SURFACE_OFFSET * 0.35;
  }

  const supportedHeight = totalHeight / totalWeight;
  return lerp(terrainY + FILM_SURFACE_OFFSET * 0.35, supportedHeight, 0.86);
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

function makeMaterial(scene: Scene) {
  const material = new PBRMaterial("dve_shallow_film_material", scene);
  material.albedoColor = new Color3(0.14, 0.33, 0.45);
  material.emissiveColor = new Color3(0.006, 0.014, 0.022);
  material.roughness = 0.08;
  material.metallic = 0;
  material.indexOfRefraction = 1.33;
  material.alpha = 0.72;
  material.backFaceCulling = true;
  material.forceDepthWrite = false;
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATESTANDBLEND;
  material.alphaCutOff = 0.02;
  material.environmentIntensity = 1.12;
  material.useRadianceOverAlpha = true;
  material.useSpecularOverAlpha = true;
  material.subSurface.isRefractionEnabled = true;
  material.subSurface.refractionIntensity = 0.05;
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
  } catch {
    // Optional texture only.
  }

  return material;
}

export type DVEShallowWaterFilmSectionData = ShallowFilmSectionRenderData;

export class DVEShallowWaterFilmRenderer {
  private readonly sections = new Map<string, SectionRecord>();
  private readonly material: PBRMaterial;
  private readonly scene: Scene;
  private disposed = false;
  private time = 0;
  private uvOffsetU = 0;
  private uvOffsetV = 0;
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
      };
      this.sections.set(sectionKey, record);
      return;
    }

    record.data = data;
    record.pendingDispose = false;
    record.dirty = true;
  }

  removeSection(sectionKey: string) {
    const record = this.sections.get(sectionKey);
    if (!record) return;
    record.pendingDispose = true;
    record.mesh.setEnabled(false);
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

    const toDispose: string[] = [];
    for (const [key, record] of this.sections) {
      if (record.pendingDispose || (activeSectionKeys && !activeSectionKeys.has(key))) {
        record.mesh.setEnabled(false);
        toDispose.push(key);
        continue;
      }
      if (!record.dirty && record.initialized) continue;
      this.rebuildSection(record);
      record.dirty = false;
    }

    for (const key of toDispose) {
      const record = this.sections.get(key);
      if (!record) continue;
      record.mesh.dispose();
      this.sections.delete(key);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.sections.values()) {
      record.mesh.dispose();
    }
    this.sections.clear();
    this.material.dispose();
  }

  private rebuildSection(record: SectionRecord) {
    const film = record.data;
    const { sizeX, sizeZ, originX, originZ } = film;
    if (sizeX <= 0 || sizeZ <= 0 || film.activeColumnCount <= 0) {
      record.mesh.setEnabled(false);
      return;
    }

    ensureTopology(record, sizeX, sizeZ);

    const gridX = record.gridX;
    const gridZ = record.gridZ;
    const vertexCount = gridX * gridZ;
    const heights = new Float32Array(vertexCount);
    const supports = new Float32Array(vertexCount);
    const thicknesses = new Float32Array(vertexCount);
    const settledValues = new Float32Array(vertexCount);
    const shoreValues = new Float32Array(vertexCount);
    const foamValues = new Float32Array(vertexCount);
    const wetnessValues = new Float32Array(vertexCount);
    const flowXValues = new Float32Array(vertexCount);
    const flowZValues = new Float32Array(vertexCount);
    const mergeBlendValues = new Float32Array(vertexCount);
    const deepBlendValues = new Float32Array(vertexCount);
    const handoffBlendValues = new Float32Array(vertexCount);

    let activeVertexCount = 0;
    let maxAlpha = 0;

    for (let vz = 0; vz < gridZ; vz++) {
      for (let vx = 0; vx < gridX; vx++) {
        const vertexIndex = vz * gridX + vx;
        const localX = vx / FILM_SUBDIVISION;
        const localZ = vz / FILM_SUBDIVISION;
        const sample = sampleVertex(film, localX, localZ);
        if (!sample) continue;
        const localFluid = sampleLocalFluid(
          this.localFluidContributions,
          originX + localX,
          originZ + localZ,
        );
        const combinedFlowSpeed = Math.max(sample.flowSpeed, localFluid.flowSpeed);

        const stableFlow = Math.min(0.85, combinedFlowSpeed);
        const stableFluidFill = localFluid.fill * 0.55;
        const stableFluidFoam = localFluid.foam * 0.42;
        const ripple =
          Math.sin(
            (originX + localX) * 0.45 +
              (originZ + localZ) * 0.52 +
              this.time * (0.78 + stableFlow * 1.05),
          ) *
            FILM_RIPPLE_SCALE *
            (0.18 +
              sample.microRipple * (0.52 - sample.mergeBlend * 0.1) +
              stableFluidFill * 0.14) +
          Math.cos(
            (originX + localX) * 0.27 - (originZ + localZ) * 0.33 + this.time * 0.44,
          ) *
            FILM_RIPPLE_SCALE *
            0.32 *
            (0.16 + sample.foam * 0.42 + stableFluidFoam * 0.24) *
            (1 - sample.handoffBlend * 0.12);

        const patchLift =
          sample.thickness *
          (sample.mergeBlend * 0.16 + sample.deepBlend * 0.24 + sample.handoffBlend * 0.16);

        const targetHeight =
          sample.surfaceY +
          FILM_SURFACE_OFFSET +
          patchLift +
          stableFluidFill * 0.0016 +
          ripple;
        const targetAlpha =
          clamp01(
          FILM_ALPHA_BIAS +
            sample.filmOpacity * (FILM_ALPHA_WETNESS + sample.wetness * 0.12) +
            Math.max(sample.foam, stableFluidFoam) * FILM_ALPHA_FOAM +
            stableFlow * FILM_ALPHA_FLOW +
            stableFluidFill * 0.045 +
            sample.mergeBlend * 0.032 +
            sample.deepBlend * 0.048 -
            sample.handoffBlend * 0.028,
        ) *
          clamp01(
            sample.coverage * (0.84 + sample.mergeBlend * 0.12 + sample.deepBlend * 0.06),
          );
        const previousHeight =
          record.initialized ? record.positions[vertexIndex * 3 + 1] : targetHeight;
        const previousAlpha =
          record.initialized ? record.colors[vertexIndex * 4 + 3] : targetAlpha;
        const heightBlend = clamp01(
          FILM_TEMPORAL_HEIGHT_BLEND +
            sample.mergeBlend * 0.1 +
            sample.deepBlend * 0.08 +
            Math.min(0.08, combinedFlowSpeed * 0.04),
        );
        const alphaBlend = clamp01(
          FILM_TEMPORAL_ALPHA_BLEND +
            sample.mergeBlend * 0.08 +
            sample.deepBlend * 0.06,
        );
        const height = lerp(previousHeight, targetHeight, heightBlend);
        const alpha = lerp(previousAlpha, targetAlpha, alphaBlend);
        const targetSupport = clamp01(
          sample.coverage +
            sample.mergeBlend * 0.18 +
            sample.deepBlend * 0.12 +
            sample.handoffBlend * 0.06 +
            stableFluidFill * 0.08,
        );

        heights[vertexIndex] = height;
        supports[vertexIndex] = targetSupport;
        thicknesses[vertexIndex] = sample.thickness;
        settledValues[vertexIndex] = sample.settled;
        shoreValues[vertexIndex] = sample.shoreDist;
        foamValues[vertexIndex] = Math.max(sample.foam, localFluid.foam * 0.82);
        wetnessValues[vertexIndex] = clamp01(sample.wetness + localFluid.fill * 0.22);
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
        handoffBlendValues[vertexIndex] = sample.handoffBlend;

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
      return;
    }

    const smoothedSupports = buildSmoothedSupports(supports, gridX, gridZ);
    const topologySupports = buildTopologySupports(smoothedSupports, gridX, gridZ);
    const useSparseSupportField =
      film.activeColumnCount <= FILM_SPARSE_ACTIVE_COLUMN_THRESHOLD;
    const renderSupports = useSparseSupportField ? supports : topologySupports;
    const heightSourceSupports = useSparseSupportField ? supports : smoothedSupports;
    const smoothedHeights = buildSmoothedHeights(
      heights,
      heightSourceSupports,
      gridX,
      gridZ,
    );
    rebuildDynamicIndices(
      record,
      sizeX * FILM_SUBDIVISION,
      sizeZ * FILM_SUBDIVISION,
      gridX,
      renderSupports,
    );

    const getHeight = (vx: number, vz: number, fallback: number) => {
      const clampedX = Math.max(0, Math.min(gridX - 1, vx));
      const clampedZ = Math.max(0, Math.min(gridZ - 1, vz));
      const index = clampedZ * gridX + clampedX;
      return renderSupports[index] > 0.001 ? smoothedHeights[index] : fallback;
    };

    for (let vz = 0; vz < gridZ; vz++) {
      for (let vx = 0; vx < gridX; vx++) {
        const index = vz * gridX + vx;
        const posOffset = index * 3;
        const uvOffset = index * 2;
        const colorOffset = index * 4;
        const support = renderSupports[index];
        const center = smoothedHeights[index];

        if (support > 0.001) {
          const hl = getHeight(vx - 1, vz, center);
          const hr = getHeight(vx + 1, vz, center);
          const hd = getHeight(vx, vz - 1, center);
          const hu = getHeight(vx, vz + 1, center);
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
          const absorption = Math.exp(-thickness * 2.8);
          const mergeBlend = mergeBlendValues[index];
          const deepBlend = deepBlendValues[index];
          const handoffBlend = handoffBlendValues[index];
          const featherHeight = sampleFeatherHeight(
            smoothedHeights,
            renderSupports,
            gridX,
            gridZ,
            vx,
            vz,
            film.terrainY,
          );
          const displayHeight = lerp(
            featherHeight,
            lerp(
              heights[index],
              smoothedHeights[index],
              clamp01(0.52 + mergeBlend * 0.18 + deepBlend * 0.2 + handoffBlend * 0.08),
            ),
            clamp01(support * FILM_FEATHER_BLEND + mergeBlend * 0.08 + deepBlend * 0.06),
          );
          record.positions[posOffset + 1] = displayHeight;
          const waterR = lerp(0.055, 0.14, 1 - absorption);
          const waterG = lerp(0.16, 0.36, 1 - absorption);
          const waterB = lerp(0.24, 0.5, 1 - absorption);
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
        } else {
          const featherInfluence = sampleFeatherInfluence(
            renderSupports,
            gridX,
            gridZ,
            vx,
            vz,
          );
          record.normals[posOffset + 0] = 0;
          record.normals[posOffset + 1] = 1;
          record.normals[posOffset + 2] = 0;
          record.uvs[uvOffset + 0] = (vx / FILM_SUBDIVISION) / Math.max(1, sizeX);
          record.uvs[uvOffset + 1] = (vz / FILM_SUBDIVISION) / Math.max(1, sizeZ);
          record.colors[colorOffset + 0] = lerp(0.03, 0.08, featherInfluence);
          record.colors[colorOffset + 1] = lerp(0.08, 0.18, featherInfluence);
          record.colors[colorOffset + 2] = lerp(0.12, 0.28, featherInfluence);
          record.colors[colorOffset + 3] = 0;
          record.positions[posOffset + 0] = originX + vx / FILM_SUBDIVISION;
          record.positions[posOffset + 1] = sampleFeatherHeight(
            smoothedHeights,
            renderSupports,
            gridX,
            gridZ,
            vx,
            vz,
            film.terrainY,
          );
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
  }
}
