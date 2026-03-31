import { Color3 } from "@babylonjs/core/Maths/math.color";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { VertexBuffer } from "@babylonjs/core/Meshes/buffer";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";

import type {
  ShallowEdgeFieldSectionRenderData,
  ShallowEdgeSplat,
} from "@divinevoxel/vlox/Water/Shallow/index.js";
import type { DVEShallowWaterLocalFluidContributionState } from "./DVEShallowWaterCompositeController.js";

type SectionRecord = {
  key: string;
  mesh: Mesh;
  data: ShallowEdgeFieldSectionRenderData;
  pendingDispose: boolean;
  dirty: boolean;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  initialized: boolean;
};

const WATER_NORMAL_PATH = "assets/water/water-001-normal.jpg";
const SPLAT_RING_SEGMENTS = 8;
const MAX_SPLATS_PER_SECTION = 96;
const EDGE_CORE_ALPHA = 0.78;
const EDGE_FEATHER_ALPHA = 0.12;
const EDGE_HEIGHT_OFFSET = 0.0016;
const EDGE_FLOW_HEIGHT = 0.0012;
const EDGE_UV_SCROLL = 0.018;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function lerp(start: number, end: number, alpha: number) {
  return start + (end - start) * alpha;
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

function ensureTopology(record: SectionRecord) {
  const vertexCount = MAX_SPLATS_PER_SECTION * (SPLAT_RING_SEGMENTS + 1);
  const indexCount = MAX_SPLATS_PER_SECTION * SPLAT_RING_SEGMENTS * 3;
  if (
    record.positions.length === vertexCount * 3 &&
    record.indices.length === indexCount
  ) {
    return;
  }

  record.positions = new Float32Array(vertexCount * 3);
  record.normals = new Float32Array(vertexCount * 3);
  record.uvs = new Float32Array(vertexCount * 2);
  record.colors = new Float32Array(vertexCount * 4);
  record.indices = new Uint32Array(indexCount);
  record.initialized = false;

  let indexOffset = 0;
  for (let slot = 0; slot < MAX_SPLATS_PER_SECTION; slot++) {
    const base = slot * (SPLAT_RING_SEGMENTS + 1);
    for (let segment = 0; segment < SPLAT_RING_SEGMENTS; segment++) {
      const next = (segment + 1) % SPLAT_RING_SEGMENTS;
      record.indices[indexOffset++] = base;
      record.indices[indexOffset++] = base + 1 + segment;
      record.indices[indexOffset++] = base + 1 + next;
    }
  }
}

function makeMaterial(scene: Scene) {
  const material = new PBRMaterial("dve_shallow_edge_splat_material", scene);
  material.albedoColor = new Color3(0.16, 0.34, 0.42);
  material.emissiveColor = new Color3(0.002, 0.005, 0.008);
  material.roughness = 0.18;
  material.metallic = 0;
  material.indexOfRefraction = 1.33;
  material.alpha = 0.38;
  material.backFaceCulling = true;
  material.forceDepthWrite = false;
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATESTANDBLEND;
  material.alphaCutOff = 0.02;
  material.environmentIntensity = 0.94;
  material.useRadianceOverAlpha = true;
  material.useSpecularOverAlpha = true;
  material.subSurface.isRefractionEnabled = true;
  material.subSurface.refractionIntensity = 0.015;
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
    bump.uScale = 9;
    bump.vScale = 9;
    bump.level = 0.07;
    material.bumpTexture = bump;
  } catch {
    // Optional texture only.
  }

  return material;
}

export type DVEShallowWaterEdgeSplatSectionData = ShallowEdgeFieldSectionRenderData;

export class DVEShallowWaterEdgeSplatRenderer {
  private readonly sections = new Map<string, SectionRecord>();
  private readonly material: PBRMaterial;
  private readonly scene: Scene;
  private disposed = false;
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

  updateSection(sectionKey: string, data: DVEShallowWaterEdgeSplatSectionData) {
    let record = this.sections.get(sectionKey);
    if (!record) {
      const mesh = new Mesh(`dve_shallow_edge_splat_${sectionKey}`, this.scene);
      mesh.isPickable = false;
      mesh.renderingGroupId = 2;
      mesh.receiveShadows = false;
      mesh.material = this.material;
      record = {
        key: sectionKey,
        mesh,
        data,
        pendingDispose: false,
        dirty: true,
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

    let flowX = 0;
    let flowZ = 0;
    let flowWeight = 0;
    for (const [key, record] of this.sections) {
      if (record.pendingDispose || (activeSectionKeys && !activeSectionKeys.has(key))) {
        continue;
      }
      for (const splat of record.data.splats) {
        const weight = Math.max(0.05, splat.alpha * (0.3 + splat.flowSpeed));
        flowX += splat.dirX * weight;
        flowZ += splat.dirZ * weight;
        flowWeight += weight;
      }
    }

    const avgFlowX = flowWeight > 0.0001 ? flowX / flowWeight : 0;
    const avgFlowZ = flowWeight > 0.0001 ? flowZ / flowWeight : 0;
    this.uvOffsetU += (avgFlowX * EDGE_UV_SCROLL + 0.0011) * deltaSeconds;
    this.uvOffsetV += (avgFlowZ * EDGE_UV_SCROLL + 0.0008) * deltaSeconds;

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

  private sampleLocalFluid(worldX: number, worldZ: number) {
    const state = this.localFluidContributions;
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

  private rebuildSection(record: SectionRecord) {
    const edgeField = record.data;
    const activeCount = Math.min(
      MAX_SPLATS_PER_SECTION,
      edgeField.activeSplatCount || edgeField.splats.length,
    );
    if (activeCount <= 0) {
      record.mesh.setEnabled(false);
      return;
    }

    ensureTopology(record);
    record.positions.fill(0);
    record.normals.fill(0);
    record.uvs.fill(0);
    record.colors.fill(0);

    const writeSlot = (slotIndex: number, splat: ShallowEdgeSplat | null) => {
      const vertexBase = slotIndex * (SPLAT_RING_SEGMENTS + 1);
      const centerOffset = vertexBase * 3;
      const uvBase = vertexBase * 2;
      const colorBase = vertexBase * 4;

      const centerX = splat?.x ?? edgeField.originX + 0.5;
      const centerY =
        (splat?.y ?? 0) + EDGE_HEIGHT_OFFSET + (splat?.flowSpeed ?? 0) * EDGE_FLOW_HEIGHT;
      const centerZ = splat?.z ?? edgeField.originZ + 0.5;
      const radius = splat?.radius ?? 0;
      const stretch = splat?.stretch ?? 0;
      const mergeBlend = clamp01(splat?.mergeBlend ?? 0);
      const deepBlend = clamp01(splat?.deepBlend ?? 0);
      const handoffBlend = clamp01(splat?.handoffBlend ?? 0);
      const localFluid = this.sampleLocalFluid(centerX, centerZ);
      const dirX =
        localFluid.flowSpeed > Math.max(0.12, (splat?.flowSpeed ?? 0) * 0.85)
          ? localFluid.flowX / Math.max(0.0001, localFluid.flowSpeed)
          : splat?.dirX ?? 1;
      const dirZ =
        localFluid.flowSpeed > Math.max(0.12, (splat?.flowSpeed ?? 0) * 0.85)
          ? localFluid.flowZ / Math.max(0.0001, localFluid.flowSpeed)
          : splat?.dirZ ?? 0;
      const rotation = Math.atan2(dirZ, dirX);
      const radiusX =
        radius *
        (1 + stretch * (1.08 - handoffBlend * 0.22) + localFluid.flowSpeed * 0.12 + mergeBlend * 0.26);
      const radiusZ =
        radius *
        (1 - stretch * (0.34 - mergeBlend * 0.08) + localFluid.fill * 0.08 + mergeBlend * 0.18);
      const alpha = clamp01(
        ((splat?.alpha ?? 0) * (1 - mergeBlend * 0.28 - handoffBlend * 0.2) +
          localFluid.fill * 0.08 +
          localFluid.foam * 0.1) *
          EDGE_CORE_ALPHA,
      );
      const foam = clamp01(Math.max(splat?.foam ?? 0, localFluid.foam * 0.92));
      const breakup = clamp01(splat?.breakup ?? 0);
      const flowSpeed = Math.max(0, splat?.flowSpeed ?? 0, localFluid.flowSpeed);
      const wetBlend = clamp01(localFluid.fill * 0.45 + foam * 0.35 + deepBlend * 0.16);
      const baseColorR = lerp(0.08, 0.34, wetBlend);
      const baseColorG = lerp(0.2, 0.5, wetBlend);
      const baseColorB = lerp(0.3, 0.62, wetBlend);
      const centerLift =
        breakup * 0.00035 +
        flowSpeed * 0.0003 +
        localFluid.fill * 0.00018 +
        deepBlend * 0.00035 +
        handoffBlend * 0.0002;

      record.positions[centerOffset + 0] = centerX;
      record.positions[centerOffset + 1] = centerY + centerLift;
      record.positions[centerOffset + 2] = centerZ;
      record.normals[centerOffset + 0] = splat?.normalX ?? 0;
      record.normals[centerOffset + 1] = splat?.normalY ?? 1;
      record.normals[centerOffset + 2] = splat?.normalZ ?? 0;
      record.uvs[uvBase + 0] = 0.5 + this.uvOffsetU;
      record.uvs[uvBase + 1] = 0.5 + this.uvOffsetV;
      record.colors[colorBase + 0] = baseColorR;
      record.colors[colorBase + 1] = baseColorG;
      record.colors[colorBase + 2] = baseColorB;
      record.colors[colorBase + 3] = alpha;

      const ringAlpha = alpha * (EDGE_FEATHER_ALPHA + mergeBlend * 0.06 + handoffBlend * 0.05);
      for (let segment = 0; segment < SPLAT_RING_SEGMENTS; segment++) {
        const t = (segment / SPLAT_RING_SEGMENTS) * Math.PI * 2;
        const localX = Math.cos(t) * radiusX;
        const localZ = Math.sin(t) * radiusZ;
        const rotX = localX * Math.cos(rotation) - localZ * Math.sin(rotation);
        const rotZ = localX * Math.sin(rotation) + localZ * Math.cos(rotation);
        const vertexIndex = vertexBase + 1 + segment;
        const posOffset = vertexIndex * 3;
        const nextUvBase = vertexIndex * 2;
        const nextColorBase = vertexIndex * 4;
        const radialFade = 1 - Math.abs(Math.sin(t * 2.0)) * 0.18;
        const lift = Math.sin(t * 2.0) * centerLift * 0.42;
        record.positions[posOffset + 0] = centerX + rotX;
        record.positions[posOffset + 1] = centerY + lift;
        record.positions[posOffset + 2] = centerZ + rotZ;
        record.normals[posOffset + 0] = splat?.normalX ?? 0;
        record.normals[posOffset + 1] = splat?.normalY ?? 1;
        record.normals[posOffset + 2] = splat?.normalZ ?? 0;
        record.uvs[nextUvBase + 0] = 0.5 + Math.cos(t) * 0.5 + this.uvOffsetU;
        record.uvs[nextUvBase + 1] = 0.5 + Math.sin(t) * 0.5 + this.uvOffsetV;
        record.colors[nextColorBase + 0] = baseColorR;
        record.colors[nextColorBase + 1] = baseColorG;
        record.colors[nextColorBase + 2] = baseColorB;
        record.colors[nextColorBase + 3] = ringAlpha * radialFade;
      }
    };

    for (let slot = 0; slot < MAX_SPLATS_PER_SECTION; slot++) {
      writeSlot(slot, slot < activeCount ? edgeField.splats[slot] ?? null : null);
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
    }

    record.mesh.refreshBoundingInfo();
    record.mesh.setEnabled(true);
  }
}
