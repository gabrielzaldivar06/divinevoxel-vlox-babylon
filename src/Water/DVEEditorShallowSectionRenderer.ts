import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Meshes/buffer";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Observer } from "@babylonjs/core/Misc/observable";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import {
  getEditorShallowSurfaceSectionSnapshots,
  sampleEditorShallowSurfaceInfluence,
  type ActiveEditorShallowSurfaceSectionSnapshot,
} from "@divinevoxel/vlox/Water/Surface/WaterEditorShallowSurfaceRegistry.js";
import {
  SHALLOW_COLUMN_STRIDE,
  decodeShallowColumnMetadata,
} from "@divinevoxel/vlox/Water/Shallow/ShallowWaterGPUDataPacker.js";

type SectionRecord = {
  key: string;
  mesh: Mesh;
  snapshot: ActiveEditorShallowSurfaceSectionSnapshot;
  lastUpdatedAt: number;
  pendingDispose: boolean;
  gridX: number;
  gridZ: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  initialized: boolean;
};

const WATER_NORMAL_PATH = "assets/water/water-001-normal.jpg";
const EDITOR_FILM_BASE_THICKNESS = 0.016;
const EDITOR_FILM_FILL_THICKNESS = 0.044;
const EDITOR_FILM_FLOW_THICKNESS = 0.015;
const EDITOR_FILM_TURB_THICKNESS = 0.011;
const EDITOR_FILM_SHORE_LIFT = 0.006;
const EDITOR_RIPPLE_HEIGHT = 0.008;
const EDITOR_DETAIL_RIPPLE_HEIGHT = 0.0035;
const EDITOR_NORMAL_SCROLL_RATE = 0.014;
const EDITOR_NORMAL_AMBIENT_DRIFT = 0.0035;
const EDITOR_ABSORB_R = 2.8;
const EDITOR_ABSORB_G = 0.9;
const EDITOR_ABSORB_B = 0.4;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function lerp(start: number, end: number, alpha: number) {
  return start + (end - start) * alpha;
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp01((value - edge0) / Math.max(0.0001, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function ensureGridBuffers(record: SectionRecord, gridX: number, gridZ: number) {
  const vertexCount = gridX * gridZ;
  const quadCount = Math.max(0, (gridX - 1) * (gridZ - 1));
  const indexCount = quadCount * 6;
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
  for (let x = 0; x < gridX - 1; x++) {
    for (let z = 0; z < gridZ - 1; z++) {
      const i00 = x * gridZ + z;
      const i10 = (x + 1) * gridZ + z;
      const i01 = x * gridZ + (z + 1);
      const i11 = (x + 1) * gridZ + (z + 1);
      record.indices[indexOffset++] = i00;
      record.indices[indexOffset++] = i11;
      record.indices[indexOffset++] = i01;
      record.indices[indexOffset++] = i00;
      record.indices[indexOffset++] = i10;
      record.indices[indexOffset++] = i11;
    }
  }
}

function applyInitialVertexData(record: SectionRecord) {
  const vertexData = new VertexData();
  vertexData.positions = Array.from(record.positions);
  vertexData.normals = Array.from(record.normals);
  vertexData.uvs = Array.from(record.uvs);
  vertexData.colors = Array.from(record.colors);
  vertexData.indices = Array.from(record.indices);
  vertexData.applyToMesh(record.mesh, true);
  record.initialized = true;
}

type DVEEditorShallowSectionRendererOptions = {
  autoUpdate?: boolean;
};

export class DVEEditorShallowSectionRenderer {
  private readonly sections = new Map<string, SectionRecord>();
  private readonly material: PBRMaterial;
  private readonly observer: Observer<Scene> | null;
  private normalTex: Texture | null = null;
  private detailNormalTex: Texture | null = null;
  private disposed = false;
  private time = 0;
  private normalUOffset = 0;
  private normalVOffset = 0;
  private detailNormalUOffset = 0;
  private detailNormalVOffset = 0;

  constructor(
    private readonly scene: Scene,
    options: DVEEditorShallowSectionRendererOptions = {},
  ) {
    this.material = new PBRMaterial("dve_editor_shallow_section_material", scene);
    this.material.albedoColor = new Color3(1, 1, 1);
    this.material.emissiveColor = new Color3(0.006, 0.02, 0.04);
    this.material.roughness = 0.08;
    this.material.metallic = 0;
    this.material.alpha = 0.72;
    this.material.indexOfRefraction = 1.33;
    this.material.backFaceCulling = false;
    this.material.forceDepthWrite = false;
    this.material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATESTANDBLEND;
    this.material.alphaCutOff = 0.04;
    this.material.useRadianceOverAlpha = true;
    this.material.useSpecularOverAlpha = true;
    this.material.environmentIntensity = 1.05;
    this.material.clearCoat.isEnabled = false;
    this.material.subSurface.isRefractionEnabled = true;
    this.material.subSurface.refractionIntensity = 0.035;
    (this.material as any).useVertexColors = true;
    (this.material as any).hasVertexAlpha = true;

    try {
      const texture = new Texture(
        WATER_NORMAL_PATH,
        scene,
        false,
        true,
        Texture.TRILINEAR_SAMPLINGMODE,
      );
      texture.wrapU = Texture.WRAP_ADDRESSMODE;
      texture.wrapV = Texture.WRAP_ADDRESSMODE;
      texture.uScale = 10;
      texture.vScale = 10;
      this.material.bumpTexture = texture;
      this.material.bumpTexture.level = 0.1;
      this.normalTex = texture;

      const detailTexture = new Texture(
        WATER_NORMAL_PATH,
        scene,
        false,
        true,
        Texture.TRILINEAR_SAMPLINGMODE,
      );
      detailTexture.wrapU = Texture.WRAP_ADDRESSMODE;
      detailTexture.wrapV = Texture.WRAP_ADDRESSMODE;
      detailTexture.uScale = 18;
      detailTexture.vScale = 18;
      this.material.detailMap.texture = detailTexture;
      this.material.detailMap.isEnabled = true;
      this.material.detailMap.bumpLevel = 0.025;
      this.material.detailMap.diffuseBlendLevel = 0;
      this.material.detailMap.roughnessBlendLevel = 0;
      this.detailNormalTex = detailTexture;
    } catch {
      this.normalTex = null;
      this.detailNormalTex = null;
    }

    if (options.autoUpdate === false) {
      this.observer = null;
    } else {
      this.observer = this.scene.onBeforeRenderObservable.add(() => {
        if (this.disposed) return;
        this.update(this.scene.getEngine().getDeltaTime() / 1000);
      });
    }
  }

  updateSection(
    sectorKey: string,
    snapshotOrWaterUpdate:
      | ActiveEditorShallowSurfaceSectionSnapshot
      | {
          originX: number;
          originZ: number;
          boundsX: number;
          boundsZ: number;
          gpuData: ActiveEditorShallowSurfaceSectionSnapshot["gpuData"];
        },
  ) {
    const snapshot: ActiveEditorShallowSurfaceSectionSnapshot =
      "records" in snapshotOrWaterUpdate
        ? snapshotOrWaterUpdate
        : {
            key: sectorKey,
            originX: snapshotOrWaterUpdate.originX,
            originZ: snapshotOrWaterUpdate.originZ,
            boundsX: snapshotOrWaterUpdate.boundsX,
            boundsZ: snapshotOrWaterUpdate.boundsZ,
            gpuData: snapshotOrWaterUpdate.gpuData,
            updatedAt: this.time,
            records: [],
            recordCount: 0,
            totalStrength: 0,
            totalDepth: 0,
            totalRemaining: 0,
            maxHandoff: 0,
          };

    let record = this.sections.get(sectorKey);
    if (!record) {
      const mesh = new Mesh(`dve_editor_shallow_section_${sectorKey}`, this.scene);
      mesh.isPickable = false;
      mesh.renderingGroupId = 1;
      mesh.receiveShadows = false;
      mesh.material = this.material;
      record = {
        key: sectorKey,
        mesh,
        snapshot,
        lastUpdatedAt: performance.now() * 0.001,
        pendingDispose: false,
        gridX: 0,
        gridZ: 0,
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        uvs: new Float32Array(0),
        colors: new Float32Array(0),
        indices: new Uint32Array(0),
        initialized: false,
      };
      this.sections.set(sectorKey, record);
    } else {
      record.snapshot = snapshot;
      record.lastUpdatedAt = performance.now() * 0.001;
      record.pendingDispose = false;
    }
  }

  removeSection(sectorKey: string) {
    const record = this.sections.get(sectorKey);
    if (!record) return;
    record.mesh.setEnabled(false);
    record.pendingDispose = true;
  }

  private sampleColumn(
    snapshot: ActiveEditorShallowSurfaceSectionSnapshot,
    x: number,
    z: number,
  ) {
    const { gpuData, boundsX, boundsZ, originX, originZ } = snapshot;
    if (!gpuData) return null;
    const stride = gpuData.columnStride;
    if (stride !== SHALLOW_COLUMN_STRIDE) {
      throw new Error(
        `Invalid shallow water column stride: expected ${SHALLOW_COLUMN_STRIDE}, received ${String(stride)}`,
      );
    }
    const fx = clamp01(x / Math.max(boundsX, 1)) * Math.max(boundsX - 1, 0);
    const fz = clamp01(z / Math.max(boundsZ, 1)) * Math.max(boundsZ - 1, 0);
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const x1 = Math.min(boundsX - 1, x0 + 1);
    const z1 = Math.min(boundsZ - 1, z0 + 1);
    const tx = fx - x0;
    const tz = fz - z0;
    const i00 = x0 * boundsZ + z0;
    const i10 = x1 * boundsZ + z0;
    const i01 = x0 * boundsZ + z1;
    const i11 = x1 * boundsZ + z1;
    const read = (index: number, offset: number) => gpuData.columnBuffer[index * stride + offset] ?? 0;
    const readMeta = (index: number) => gpuData.columnMetadata[index] ?? 0;

    const dec00 = decodeShallowColumnMetadata(readMeta(i00));
    const dec10 = decodeShallowColumnMetadata(readMeta(i10));
    const dec01 = decodeShallowColumnMetadata(readMeta(i01));
    const dec11 = decodeShallowColumnMetadata(readMeta(i11));
    if (!dec00.active && !dec10.active && !dec01.active && !dec11.active) {
      return null;
    }

    const fill00 = read(i00, 0);
    const fill10 = read(i10, 0);
    const fill01 = read(i01, 0);
    const fill11 = read(i11, 0);
    const bottom00 = read(i00, 2);
    const bottom10 = read(i10, 2);
    const bottom01 = read(i01, 2);
    const bottom11 = read(i11, 2);
    const flowDirX00 = read(i00, 3);
    const flowDirX10 = read(i10, 3);
    const flowDirX01 = read(i01, 3);
    const flowDirX11 = read(i11, 3);
    const flowDirZ00 = read(i00, 4);
    const flowDirZ10 = read(i10, 4);
    const flowDirZ01 = read(i01, 4);
    const flowDirZ11 = read(i11, 4);
    const settled00 = read(i00, 5);
    const settled10 = read(i10, 5);
    const settled01 = read(i01, 5);
    const settled11 = read(i11, 5);
    const adhesion00 = read(i00, 6);
    const adhesion10 = read(i10, 6);
    const adhesion01 = read(i01, 6);
    const adhesion11 = read(i11, 6);
    const age00 = read(i00, 7);
    const age10 = read(i10, 7);
    const age01 = read(i01, 7);
    const age11 = read(i11, 7);
    const shoreDist00 = read(i00, 9);
    const shoreDist10 = read(i10, 9);
    const shoreDist01 = read(i01, 9);
    const shoreDist11 = read(i11, 9);

    const bottomX0 = lerp(bottom00, bottom10, tx);
    const bottomX1 = lerp(bottom01, bottom11, tx);
    const fillX0 = lerp(fill00, fill10, tx);
    const fillX1 = lerp(fill01, fill11, tx);
    const flowDirXX0 = lerp(flowDirX00, flowDirX10, tx);
    const flowDirXX1 = lerp(flowDirX01, flowDirX11, tx);
    const flowDirZX0 = lerp(flowDirZ00, flowDirZ10, tx);
    const flowDirZX1 = lerp(flowDirZ01, flowDirZ11, tx);
    const settledX0 = lerp(settled00, settled10, tx);
    const settledX1 = lerp(settled01, settled11, tx);
    const adhesionX0 = lerp(adhesion00, adhesion10, tx);
    const adhesionX1 = lerp(adhesion01, adhesion11, tx);
    const ageX0 = lerp(age00, age10, tx);
    const ageX1 = lerp(age01, age11, tx);
    const shoreDistX0 = lerp(shoreDist00, shoreDist10, tx);
    const shoreDistX1 = lerp(shoreDist01, shoreDist11, tx);

    const flowDirectionX = lerp(flowDirXX0, flowDirXX1, tz);
    const flowDirectionZ = lerp(flowDirZX0, flowDirZX1, tz);
    const flowStrength = Math.hypot(flowDirectionX, flowDirectionZ);
    const settled = lerp(settledX0, settledX1, tz);
    const adhesion = lerp(adhesionX0, adhesionX1, tz);
    const age = lerp(ageX0, ageX1, tz);
    const turbulence = clamp01(
      (1 - settled) * (0.45 + flowStrength * 0.75) +
        clamp01(age / 6) * (1 - adhesion) * 0.2,
    );

    return {
      worldX: originX + x,
      worldZ: originZ + z,
      bottomHeight: lerp(bottomX0, bottomX1, tz),
      fill: lerp(fillX0, fillX1, tz),
      flowStrength,
      flowX: flowStrength > 0.0001 ? flowDirectionX / flowStrength : 0,
      flowZ: flowStrength > 0.0001 ? flowDirectionZ / flowStrength : 0,
      turbulence,
      shoreDistance: lerp(shoreDistX0, shoreDistX1, tz),
      adhesion,
      settled,
      age,
    };
  }

  private sampleFallbackHeight(
    snapshot: ActiveEditorShallowSurfaceSectionSnapshot,
    worldX: number,
    worldZ: number,
  ) {
    let totalWeight = 0;
    let height = 0;
    let depth = 0;
    for (const record of snapshot.records) {
      const dx = worldX - (record.x + 0.5);
      const dz = worldZ - (record.z + 0.5);
      const distance = Math.hypot(dx, dz);
      const weight = 1 - clamp01(distance / Math.max(1, record.radius * 1.25));
      if (weight <= 0) continue;
      totalWeight += weight;
      height += (record.bottomHeight ?? 0) * weight;
      depth += (record.depth ?? 0.02) * weight;
    }
    if (totalWeight <= 0) return null;
    return {
      bottomHeight: height / totalWeight,
      depth: depth / totalWeight,
    };
  }

  private rebuildSection(record: SectionRecord) {
    const snapshot = record.snapshot;
    const { originX, originZ, boundsX, boundsZ } = snapshot;
    if (snapshot.recordCount <= 0) {
      record.mesh.setEnabled(false);
      return;
    }

    const gridX = boundsX + 1;
    const gridZ = boundsZ + 1;
    ensureGridBuffers(record, gridX, gridZ);

    const heights = new Float32Array(gridX * gridZ);
    const bottoms = new Float32Array(gridX * gridZ);
    const thicknesses = new Float32Array(gridX * gridZ);
    const alphas = new Float32Array(gridX * gridZ);
    const fills = new Float32Array(gridX * gridZ);
    const flows = new Float32Array(gridX * gridZ);
    const turbulences = new Float32Array(gridX * gridZ);
    const shoreFoams = new Float32Array(gridX * gridZ);
    const flowDirsX = new Float32Array(gridX * gridZ);
    const flowDirsZ = new Float32Array(gridX * gridZ);
    let maxAlpha = 0;

    for (let x = 0; x < gridX; x++) {
      for (let z = 0; z < gridZ; z++) {
        const worldX = originX + x;
        const worldZ = originZ + z;
        const influence = sampleEditorShallowSurfaceInfluence(worldX + 0.5, worldZ + 0.5);
        const idx = x * gridZ + z;

        const sample = this.sampleColumn(snapshot, x, z);
        if (sample) {
          const shoreBias = sample.shoreDistance >= 0 ? 1 - clamp01(sample.shoreDistance / 8) : 0.18;
          const flowEnergy = clamp01(sample.flowStrength * 0.72 + sample.turbulence * 0.48);
          const shorelineSheen = smoothstep(0, 1, shoreBias);
          const detailPhase =
            worldX * (0.95 + sample.flowX * 0.14) +
            worldZ * (0.87 + sample.flowZ * 0.14) +
            this.time * (1.8 + flowEnergy * 2.2);
          const ripplePhase =
            worldX * (0.44 + sample.flowX * 0.22) +
            worldZ * (0.39 + sample.flowZ * 0.22) +
            this.time * (0.95 + sample.flowStrength * 1.9 + sample.turbulence * 1.15);
          const ripple =
            Math.sin(ripplePhase) * EDITOR_RIPPLE_HEIGHT * (0.22 + flowEnergy * 0.74) +
            Math.cos(detailPhase) * EDITOR_DETAIL_RIPPLE_HEIGHT * (0.4 + shorelineSheen * 0.35);
          const thickness =
            EDITOR_FILM_BASE_THICKNESS +
            sample.fill * EDITOR_FILM_FILL_THICKNESS +
            sample.flowStrength * EDITOR_FILM_FLOW_THICKNESS +
            sample.turbulence * EDITOR_FILM_TURB_THICKNESS +
            shoreBias * EDITOR_FILM_SHORE_LIFT;
          bottoms[idx] = sample.bottomHeight;
          thicknesses[idx] = thickness;
          heights[idx] = sample.bottomHeight + thickness + ripple;
          fills[idx] = sample.fill;
          flows[idx] = sample.flowStrength;
          turbulences[idx] = sample.turbulence;
          flowDirsX[idx] = sample.flowX;
          flowDirsZ[idx] = sample.flowZ;
          shoreFoams[idx] = clamp01(shorelineSheen * 0.7 + sample.turbulence * 0.22 + sample.flowStrength * 0.12);
          const alpha =
            clamp01(
              influence *
                (0.2 + sample.fill * 0.46 + sample.flowStrength * 0.17 + sample.turbulence * 0.1) *
                (0.92 + shorelineSheen * 0.12),
            ) * clamp01(0.82 + sample.adhesion * 0.18);
          alphas[idx] = alpha;
          if (alpha > maxAlpha) maxAlpha = alpha;
          continue;
        }

        const fallback = this.sampleFallbackHeight(snapshot, worldX, worldZ);
        if (!fallback) {
          heights[idx] = snapshot.records[0]?.y ?? 0;
          alphas[idx] = 0;
          continue;
        }
        heights[idx] =
          fallback.bottomHeight +
          0.014 +
          fallback.depth * 0.04 +
          Math.sin((worldX + worldZ) * 0.42 + this.time * 0.9) * EDITOR_DETAIL_RIPPLE_HEIGHT;
        bottoms[idx] = fallback.bottomHeight;
        thicknesses[idx] = 0.014 + fallback.depth * 0.04;
        fills[idx] = clamp01(fallback.depth * 0.8);
        flows[idx] = 0.08;
        turbulences[idx] = 0.04;
        shoreFoams[idx] = 0.18;
        const alpha = influence * 0.55;
        alphas[idx] = alpha;
        if (alpha > maxAlpha) maxAlpha = alpha;
      }
    }

    if (maxAlpha <= 0.01) {
      record.mesh.setEnabled(false);
      return;
    }

    const localPositions: number[] = [];
    const localNormals: number[] = [];
    const localUvs: number[] = [];
    const localColors: number[] = [];
    const localIndices: number[] = [];
    const remap = new Int32Array(gridX * gridZ);
    remap.fill(-1);
    let nextVertex = 0;

    for (let x = 0; x < gridX; x++) {
      for (let z = 0; z < gridZ; z++) {
        const idx = x * gridZ + z;
        const left = heights[Math.max(0, x - 1) * gridZ + z];
        const right = heights[Math.min(gridX - 1, x + 1) * gridZ + z];
        const down = heights[x * gridZ + Math.max(0, z - 1)];
        const up = heights[x * gridZ + Math.min(gridZ - 1, z + 1)];
        const normal = new Vector3(left - right, 2, down - up);
        normal.normalize();
        const flow = flows[idx];
        const turbulence = turbulences[idx];
        const foam = shoreFoams[idx];
        const fill = fills[idx];
        const alpha = alphas[idx];
        if (alpha <= 0.012) {
          continue;
        }
        remap[idx] = nextVertex++;
        const thickness = Math.max(0.006, thicknesses[idx] + Math.max(0, heights[idx] - bottoms[idx] - thicknesses[idx]));
        const beerR = Math.exp(-EDITOR_ABSORB_R * thickness);
        const beerG = Math.exp(-EDITOR_ABSORB_G * thickness);
        const beerB = Math.exp(-EDITOR_ABSORB_B * thickness);
        const bodyR = 0.14 * beerR;
        const bodyG = 0.42 * beerG;
        const bodyB = 0.88 * beerB;
        const calmDarken = (1 - flow) * 0.05;
        const color = new Color3(
          clamp01(lerp(bodyR - calmDarken * 0.35, 0.92, foam * 0.2)),
          clamp01(lerp(bodyG - calmDarken * 0.18, 0.96, foam * 0.24)),
          clamp01(lerp(bodyB, 1, foam * 0.14)),
        );
        const uvShiftX = flowDirsX[idx] * flow * 0.08 + Math.sin(this.time + x * 0.13 + z * 0.11) * 0.01;
        const uvShiftZ = flowDirsZ[idx] * flow * 0.08 + Math.cos(this.time * 0.9 + x * 0.1 - z * 0.12) * 0.01;
        localPositions.push(originX + x, heights[idx], originZ + z);
        localNormals.push(normal.x, normal.y, normal.z);
        localUvs.push(x / Math.max(1, boundsX) + uvShiftX, z / Math.max(1, boundsZ) + uvShiftZ);
        localColors.push(color.r, color.g, color.b, alpha);
      }
    }

    for (let x = 0; x < boundsX; x++) {
      for (let z = 0; z < boundsZ; z++) {
        const i00 = x * gridZ + z;
        const i10 = (x + 1) * gridZ + z;
        const i01 = x * gridZ + (z + 1);
        const i11 = (x + 1) * gridZ + (z + 1);
        const r00 = remap[i00];
        const r10 = remap[i10];
        const r01 = remap[i01];
        const r11 = remap[i11];
        if (r00 < 0 || r10 < 0 || r01 < 0 || r11 < 0) {
          continue;
        }
        if ((x + z) % 2 === 0) {
          localIndices.push(r00, r11, r01, r00, r10, r11);
        } else {
          localIndices.push(r00, r10, r01, r10, r11, r01);
        }
      }
    }

    if (!localPositions.length || !localIndices.length) {
      record.mesh.setEnabled(false);
      return;
    }

    const vertexData = new VertexData();
    vertexData.positions = localPositions;
    vertexData.normals = localNormals;
    vertexData.uvs = localUvs;
    vertexData.colors = localColors;
    vertexData.indices = localIndices;
    vertexData.applyToMesh(record.mesh, true);
    record.mesh.refreshBoundingInfo();
    record.mesh.setEnabled(true);
  }

  update(deltaSeconds: number) {
    this.time += deltaSeconds;
    const snapshots = getEditorShallowSurfaceSectionSnapshots();
    const seen = new Set<string>();
    let avgFlowX = 0;
    let avgFlowZ = 0;
    let avgFlowWeight = 0;
    for (const snapshot of snapshots) {
      seen.add(snapshot.key);
      const gpuData = snapshot.gpuData;
      if (gpuData) {
        const stride = gpuData.columnStride;
        if (stride !== SHALLOW_COLUMN_STRIDE) {
          throw new Error(
            `Invalid shallow water column stride: expected ${SHALLOW_COLUMN_STRIDE}, received ${String(stride)}`,
          );
        }
        const columnCount = snapshot.boundsX * snapshot.boundsZ;
        for (let i = 0; i < columnCount; i++) {
          const fill = gpuData.columnBuffer[i * stride + 0] ?? 0;
          const flowX = gpuData.columnBuffer[i * stride + 3] ?? 0;
          const flowZ = gpuData.columnBuffer[i * stride + 4] ?? 0;
          const flowStrength = Math.hypot(flowX, flowZ);
          if (fill <= 0.01 || flowStrength <= 0.001) continue;
          avgFlowX += flowX * flowStrength;
          avgFlowZ += flowZ * flowStrength;
          avgFlowWeight += flowStrength;
        }
      }
      this.updateSection(snapshot.key, snapshot);
    }

    const flowX = avgFlowWeight > 0.0001 ? avgFlowX / avgFlowWeight : 0;
    const flowZ = avgFlowWeight > 0.0001 ? avgFlowZ / avgFlowWeight : 0;
    this.normalUOffset += (flowX * EDITOR_NORMAL_SCROLL_RATE + EDITOR_NORMAL_AMBIENT_DRIFT) * deltaSeconds;
    this.normalVOffset += (flowZ * EDITOR_NORMAL_SCROLL_RATE + EDITOR_NORMAL_AMBIENT_DRIFT * 0.65) * deltaSeconds;
    this.detailNormalUOffset -= (flowX * EDITOR_NORMAL_SCROLL_RATE * 0.72 + EDITOR_NORMAL_AMBIENT_DRIFT * 0.85) * deltaSeconds;
    this.detailNormalVOffset += (flowZ * EDITOR_NORMAL_SCROLL_RATE * 0.5 + EDITOR_NORMAL_AMBIENT_DRIFT * 0.4) * deltaSeconds;
    if (this.normalTex) {
      this.normalTex.uOffset = this.normalUOffset;
      this.normalTex.vOffset = this.normalVOffset;
    }
    if (this.detailNormalTex) {
      this.detailNormalTex.uOffset = this.detailNormalUOffset;
      this.detailNormalTex.vOffset = this.detailNormalVOffset;
    }

    const now = performance.now() * 0.001;
    for (const [key, record] of this.sections) {
      if (!seen.has(key) && now - record.lastUpdatedAt > 0.4) {
        record.mesh.setEnabled(false);
        record.pendingDispose = true;
      }
      if (record.pendingDispose) {
        record.mesh.dispose();
        this.sections.delete(key);
        continue;
      }
      this.rebuildSection(record);
    }
    this.material.alpha = 0.72;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer);
    }
    for (const record of this.sections.values()) {
      record.mesh.dispose();
    }
    this.sections.clear();
    this.normalTex?.dispose();
    this.detailNormalTex?.dispose();
    this.material.dispose();
  }
}
