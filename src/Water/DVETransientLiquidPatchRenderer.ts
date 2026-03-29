import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Observer } from "@babylonjs/core/Misc/observable";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Scene } from "@babylonjs/core/scene";
import { getActiveWaterSurfaceBirthRecords } from "@divinevoxel/vlox/Water/Surface/WaterSurfaceBirthRegistry.js";

const RING_SEGMENTS = 12;
const RADIAL_STEPS = 4;

function isTransientWaterOverlayDisabled() {
  return (globalThis as any).__DVE_DISABLE_TRANSIENT_WATER_OVERLAY__ === true;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / Math.max(0.0001, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export class DVETransientLiquidPatchRenderer {
  private readonly mesh: Mesh;
  private readonly material: PBRMaterial;
  private readonly observer: Observer<Scene>;
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];
  private disposed = false;

  constructor(private readonly scene: Scene) {
    this.mesh = new Mesh("dve_transient_liquid_patches", scene);
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = false;
    this.mesh.renderingGroupId = 1;
    this.mesh.receiveShadows = false;

    this.material = new PBRMaterial("dve_transient_liquid_patch_material", scene);
    this.material.albedoColor = new Color3(0.54, 0.78, 0.96);
    this.material.emissiveColor = new Color3(0.04, 0.09, 0.12);
    this.material.alpha = 0.88;
    this.material.roughness = 0.08;
    this.material.metallic = 0;
    this.material.subSurface.isRefractionEnabled = false;
    this.material.backFaceCulling = false;
    this.material.separateCullingPass = false;
    this.material.disableDepthWrite = true;
    this.material.forceDepthWrite = false;
    this.mesh.material = this.material;
    this.mesh.setEnabled(false);

    this.observer = this.scene.onBeforeRenderObservable.add(() => {
      if (this.disposed) return;
      this.update();
    });
  }

  private pushVertex(
    position: Vector3,
    normal: Vector3,
    u: number,
    v: number,
  ) {
    this.positions.push(position.x, position.y, position.z);
    this.normals.push(normal.x, normal.y, normal.z);
    this.uvs.push(u, v);
  }

  private evaluateMLSHeight(
    tx: number,
    tz: number,
    radius: number,
    ageT: number,
    seed: number,
  ) {
    const supportPoints: [number, number, number][] = [
      [0, 0, 0.08 * (1 - ageT)],
      [0.55, 0, -0.02],
      [-0.55, 0, -0.02],
      [0, 0.55, -0.03],
      [0, -0.55, -0.03],
      [0.38, 0.32, -0.025],
      [-0.42, 0.28, -0.025],
      [0.34, -0.38, -0.025],
      [-0.36, -0.36, -0.025],
    ];
    let a00 = 0;
    let a01 = 0;
    let a02 = 0;
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (const [sx, sz, sy] of supportPoints) {
      const dx = tx - sx;
      const dz = tz - sz;
      const distSq = dx * dx + dz * dz;
      const weight = 1 / (0.04 + distSq * distSq * (1.8 + ageT));
      a00 += weight;
      a01 += weight * dx;
      a02 += weight * dz;
      a11 += weight * dx * dx;
      a12 += weight * dx * dz;
      a22 += weight * dz * dz;
      b0 += weight * sy;
      b1 += weight * sy * dx;
      b2 += weight * sy * dz;
    }
    const det =
      a00 * (a11 * a22 - a12 * a12) -
      a01 * (a01 * a22 - a12 * a02) +
      a02 * (a01 * a12 - a11 * a02);
    const baseRipple =
      Math.sin((tx + seed) * 7 + ageT * 5) * 0.004 +
      Math.cos((tz - seed) * 6 - ageT * 4) * 0.003;
    if (Math.abs(det) <= 1e-5) {
      return baseRipple;
    }
    const detA =
      b0 * (a11 * a22 - a12 * a12) -
      a01 * (b1 * a22 - a12 * b2) +
      a02 * (b1 * a12 - a11 * b2);
    const planeHeight = detA / det;
    return planeHeight * radius + baseRipple;
  }

  private appendPatch(
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
    ageT: number,
    seed: number,
  ) {
    const pulse = Math.sin(ageT * Math.PI * 2.8 + seed * 6.283) * 0.008;
    const normal = new Vector3(0, 1, 0);
    const centerLift = 0.028 * (1 - ageT) + pulse;
    const ringStart = this.positions.length / 3;

    for (let radialStep = 0; radialStep <= RADIAL_STEPS; radialStep++) {
      const radialT = radialStep / RADIAL_STEPS;
      const profileT = smoothstep(0, 1, radialT);
      const ringRadius = radius * (0.12 + profileT * 0.98);
      const crown = (1 - profileT) * centerLift;
      const sink = profileT * (0.03 + ageT * 0.035);
      for (let segment = 0; segment < RING_SEGMENTS; segment++) {
        const t = segment / RING_SEGMENTS;
        const angle = t * Math.PI * 2 + seed * Math.PI * 2;
        const wobble =
          1 +
          Math.sin(angle * 2 + ageT * 6 + seed * 4) * 0.07 +
          Math.cos(angle * 3 - ageT * 3 + seed * 2) * 0.05;
        const radial = ringRadius * wobble;
        const localX = Math.cos(angle) * radial;
        const localZ = Math.sin(angle) * radial;
        const tx = radius > 0.0001 ? localX / radius : 0;
        const tz = radius > 0.0001 ? localZ / radius : 0;
        const mlsY = this.evaluateMLSHeight(tx, tz, radius, ageT, seed);
        const position = new Vector3(
          centerX + localX,
          centerY + crown - sink + mlsY,
          centerZ + localZ,
        );
        this.pushVertex(
          position,
          normal,
          0.5 + tx * 0.5,
          0.5 + tz * 0.5,
        );
      }
    }

    for (let radialStep = 0; radialStep < RADIAL_STEPS; radialStep++) {
      const rowStart = ringStart + radialStep * RING_SEGMENTS;
      const nextRowStart = rowStart + RING_SEGMENTS;
      for (let segment = 0; segment < RING_SEGMENTS; segment++) {
        const next = (segment + 1) % RING_SEGMENTS;
        this.indices.push(rowStart + segment, nextRowStart + next, nextRowStart + segment);
        this.indices.push(rowStart + segment, rowStart + next, nextRowStart + next);
      }
    }
  }

  update() {
    if (isTransientWaterOverlayDisabled()) {
      this.mesh.setEnabled(false);
      return;
    }
    const records = getActiveWaterSurfaceBirthRecords();
    this.positions.length = 0;
    this.normals.length = 0;
    this.uvs.length = 0;
    this.indices.length = 0;

    for (const record of records) {
      const ageT = record.normalizedAge;
      const birthBoost = 1 - smoothstep(0, 0.8, ageT);
      const spread = smoothstep(0, 1, ageT);
      const radius =
        (0.72 + record.radius * 0.5) *
        (0.86 + birthBoost * 0.44 + spread * 0.38 + record.strength * 0.22);
      const centerY = record.y + 0.14 + birthBoost * 0.07 - spread * 0.05;
      const seed = ((record.x * 0.113 + record.z * 0.071) % 1 + 1) % 1;
      this.appendPatch(
        record.x + 0.5,
        centerY,
        record.z + 0.5,
        radius,
        ageT,
        seed,
      );
    }

    if (this.positions.length === 0) {
      this.mesh.setEnabled(false);
      return;
    }

    const vertexData = new VertexData();
    vertexData.positions = this.positions;
    vertexData.normals = this.normals;
    vertexData.uvs = this.uvs;
    vertexData.indices = this.indices;
    vertexData.applyToMesh(this.mesh, true);
    this.mesh.setEnabled(true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.onBeforeRenderObservable.remove(this.observer);
    this.mesh.dispose();
    this.material.dispose();
  }
}
