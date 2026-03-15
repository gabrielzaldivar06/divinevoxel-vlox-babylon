/**
 * BVHTool — BVH debug visualizer.
 *
 * Pure physics live in BVHRaycast.ts (no scene objects).
 * This file imports VoxelMeshIntersect from there and wraps it with
 * BabylonJS debug visualization (InstancedMesh boxes, materials).
 */
import type { Scene } from "@babylonjs/core/scene";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { VoxelMeshBVHStructCursor } from "@divinevoxel/vlox/Mesher/Voxels/Geometry/VoxelMeshBVHStructCursor";
import { VoxelMeshBVHBuilder } from "@divinevoxel/vlox/Mesher/Voxels/Geometry/VoxelMeshBVHBuilder";
import { Vector3 } from "@babylonjs/core/Maths/";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { BoundingBoxIntersect, VoxelMeshIntersect } from "./BVHRaycast";

// Re-export result types for callers who previously imported from BVHTool
export { VoxelGeometryIntersectResult, VoxelMeshIntersectResult } from "./BVHRaycast";

// ─── Debug mesh factory ───────────────────────────────────────────────────────

const makeMesh = (
  struct: VoxelMeshBVHStructCursor,
  hit = false,
  parent = false
) => {
  const mesh = parent
    ? BVHViewer._parentBox.createInstance(crypto.randomUUID())
    : hit
      ? BVHViewer._hitBox.createInstance(crypto.randomUUID())
      : BVHViewer._box.createInstance(crypto.randomUUID());
  mesh.scaling.set(
    struct.maxX - struct.minX,
    struct.maxY - struct.minY,
    struct.maxZ - struct.minZ
  );
  mesh.position.set(
    struct.minX + mesh.scaling.x / 2,
    struct.minY + mesh.scaling.y / 2,
    struct.minZ + mesh.scaling.z / 2
  );
  return mesh;
};

// ─── BVHViewer ────────────────────────────────────────────────────────────────

export class BVHViewer {
  tool = new VoxelMeshBVHBuilder();

  _boxes: InstancedMesh[] = [];
  static _box: Mesh;
  static _hitBox: Mesh;
  static _parentBox: Mesh;
  static _material: StandardMaterial;
  static _hitMaterial: StandardMaterial;
  static _parentMaterial: StandardMaterial;

  static instances = new Set<BVHViewer>();

  constructor(
    public mesh: Mesh,
    public scene: Scene,
    tree: Float32Array<any>,
    treeIndices: Uint32Array<any>,
    public vertices: Float32Array<any>,
    public indices: Uint32Array<any>
  ) {
    this.tool.tree = tree;
    this.tool.indices = treeIndices;
    this.tool.structCursor.data = tree;
    if (!BVHViewer._box) {
      BVHViewer._box = CreateBox("", { size: 1 }, scene);
    }
    if (!BVHViewer._hitBox) {
      BVHViewer._hitBox = CreateBox("", { size: 1 }, scene);
    }
    if (!BVHViewer._parentBox) {
      BVHViewer._parentBox = CreateBox("", { size: 1 }, scene);
    }
    if (!BVHViewer._material) {
      BVHViewer._material = new StandardMaterial("", this.scene);
      BVHViewer._material.diffuseColor.set(0, 0, 1);
      BVHViewer._material.alpha = 0.5;
      BVHViewer._box!.material = BVHViewer._material;
    }
    if (!BVHViewer._hitMaterial) {
      BVHViewer._hitMaterial = new StandardMaterial("", this.scene);
      BVHViewer._hitMaterial.diffuseColor.set(1, 0, 0);
      BVHViewer._hitMaterial.alpha = 0.5;
      BVHViewer._hitBox!.material = BVHViewer._hitMaterial;
    }
    if (!BVHViewer._parentMaterial) {
      BVHViewer._parentMaterial = new StandardMaterial("", this.scene);
      BVHViewer._parentMaterial.diffuseColor.set(0, 1, 0);
      BVHViewer._parentMaterial.alpha = 0.5;
      BVHViewer._parentBox!.material = BVHViewer._parentMaterial;
    }
    BVHViewer.instances.add(this);
  }

  dispose() {
    for (const mesh of this._boxes) {
      mesh.dispose();
    }
    BVHViewer.instances.delete(this);
  }

  testIntersection(rayOrigin: Vector3, rayDirection: Vector3) {
    return VoxelMeshIntersect(
      rayOrigin,
      rayDirection,
      this.tool.tree,
      this.tool.indices,
      this.vertices,
      this.indices
    );
  }

  createBoxes(level: number, ro?: Vector3, rd?: Vector3) {
    for (const mesh of this._boxes) {
      mesh.dispose();
    }
    const minBox = new Vector3();
    const maxBox = new Vector3();

    const struct = this.tool.structCursor;
    const meshes: InstancedMesh[] = [];
    if (level == 0) {
      struct.setIndex(0);
      const mesh = BVHViewer._box.createInstance(`${0}`);
      mesh.scaling.set(
        struct.maxX - struct.minX,
        struct.maxY - struct.minY,
        struct.maxZ - struct.minZ
      );
      mesh.position.set(
        struct.minX + mesh.scaling.x / 2,
        struct.minY + mesh.scaling.y / 2,
        struct.minZ + mesh.scaling.z / 2
      );
      meshes.push(mesh);
    } else {
      const levelSize = this.tool.treeIndex.getLevelSize(level);
      const invDir = rd
        ? new Vector3(
            rd.x !== 0 ? 1 / rd.x : 0,
            rd.y !== 0 ? 1 / rd.y : 0,
            rd.z !== 0 ? 1 / rd.z : 0
          )
        : null;

      for (let i = 0; i < levelSize; i++) {
        const nodeIndex = this.tool.treeIndex.getIndexAtLevel(level, i);
        struct.setIndex(nodeIndex);

        let mesh: InstancedMesh;
        if (ro && invDir) {
          minBox.set(struct.minX, struct.minY, struct.minZ);
          maxBox.set(struct.maxX, struct.maxY, struct.maxZ);
          const t = BoundingBoxIntersect(minBox, maxBox, ro, invDir);
          mesh = t !== Infinity
            ? BVHViewer._hitBox.createInstance(`${i}`)
            : BVHViewer._box.createInstance(`${i}`);
        } else {
          mesh = BVHViewer._box.createInstance(`${i}`);
        }
        mesh.scaling.set(
          struct.maxX - struct.minX,
          struct.maxY - struct.minY,
          struct.maxZ - struct.minZ
        );
        mesh.position.set(
          struct.minX + mesh.scaling.x / 2,
          struct.minY + mesh.scaling.y / 2,
          struct.minZ + mesh.scaling.z / 2
        );
        meshes.push(mesh);
      }
    }

    this._boxes = meshes;
  }
}
