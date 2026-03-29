import type { Scene } from "@babylonjs/core/scene";
import type { Engine } from "@babylonjs/core/Engines/engine";
import { Geometry } from "@babylonjs/core/Meshes/geometry";
import { Vector3 } from "@babylonjs/core/Maths/";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo.js";
import { DVESectionMeshes } from "@divinevoxel/vlox/Renderer";
import { DVEBabylonRenderer } from "../../Renderer/DVEBabylonRenderer";
import { DVEBRVoxelMesh } from "../../Meshes/DVEBRVoxelMesh";
import { SectionMesh } from "@divinevoxel/vlox/Renderer";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";
import {
  CompactedSectionVoxelMesh,
  CompactedMeshData,
} from "@divinevoxel/vlox/Mesher/Voxels/Geometry/CompactedSectionVoxelMesh";
import { LocationData } from "@divinevoxel/vlox/Math";
import {
  getBaseMaterialId,
  isTransitionMaterialId,
} from "@divinevoxel/vlox/Mesher/Voxels/Models/TransitionMaterialIds";
import { classifyTerrainMaterial } from "../../Matereials/PBR/MaterialFamilyProfiles";
const min = Vector3.Zero();
const max = new Vector3(16, 16, 16);
const empty = new Float32Array(1);
const emptyIndice = new Uint16Array(1);
const meshData = new CompactedMeshData();
const location: LocationData = [0, 0, 0, 0];
const found = new Set<string>();
const MESH_BOUND_PADDING = 1;
const LIQUID_MESH_BOUND_PADDING = 6;

function getBoundsPadding(materialId: string) {
  return classifyTerrainMaterial(getBaseMaterialId(materialId)).isLiquid
    ? LIQUID_MESH_BOUND_PADDING
    : MESH_BOUND_PADDING;
}
export class DVEBRSectionMeshesMultiBuffer extends DVESectionMeshes {
  pickable = false;
  checkCollisions = false;
  serialize = false;
  // clearCachedGeometry = false;
  defaultBb: BoundingInfo;

  constructor(
    public scene: Scene,
    public engine: Engine,
    public renderer: DVEBabylonRenderer,
  ) {
    super();
    this.defaultBb = new BoundingInfo(Vector3.Zero(), new Vector3(16, 16, 16));
  }

  returnMesh(mesh: Mesh) {
    DVEBRVoxelMesh.releaseBuffer(mesh);
    mesh.dispose();
  }

  updateVertexData(section: SectionMesh, data: CompactedSectionVoxelMesh) {
    data.getLocation(location);

    // Clear at the start to avoid stale state from a previous failed call.
    found.clear();

    const totalMeshes = data.getTotalMeshes();
    try {
    for (let i = 0; i < totalMeshes; i++) {
      data.getMeshData(i, meshData);
      const subMeshMaterial = meshData.materialId;
      found.add(subMeshMaterial);
      let mesh: Mesh;

      if (section.meshes.has(subMeshMaterial)) {
        mesh = section.meshes.get(subMeshMaterial) as Mesh;
      } else {
        const newMesh = new Mesh("", this.scene);
        newMesh.renderingGroupId = subMeshMaterial.includes("liquid") ? 1 : 0;
        newMesh.isPickable = false;
        newMesh.checkCollisions = false;
        newMesh.doNotSerialize = true;
        newMesh.metadata = {
          section: true,
          buffer: null,
          transitionGeometry: isTransitionMaterialId(subMeshMaterial),
          baseMaterialId: getBaseMaterialId(subMeshMaterial),
        };
        newMesh.alwaysSelectAsActiveMesh = true;
        const geometry = new Geometry(
          Geometry.RandomId(),
          this.scene,
          undefined,
          false,
          newMesh,
        );

        geometry._boundingInfo = new BoundingInfo(
          new Vector3(0, 0, 0),
          new Vector3(0, 0, 0),
        );
        geometry.useBoundingInfoFromGeometry = true;
        newMesh.doNotSyncBoundingInfo = true;
        newMesh.setEnabled(false);
        newMesh.freezeWorldMatrix();
        // Remove from scene.meshes — the culler manages scene membership.
        // Use indexOf for O(1) break instead of backwards scan.
        const idx = this.scene.meshes.indexOf(newMesh);
        if (idx !== -1) {
          this.scene.meshes.splice(idx, 1);
        }
        mesh = newMesh;
      }

      mesh.unfreezeWorldMatrix();
      mesh.position.set(location[1], location[2], location[3]);
      mesh.computeWorldMatrix();

      mesh.metadata.buffer = DVEBRVoxelMesh.UpdateVertexDataBuffers(
        mesh,
        this.engine,
        meshData.verticies,
        meshData.indices,
      );

      const minBounds = meshData.minBounds;
      const maxBounds = meshData.maxBounds;
  const boundsPadding = getBoundsPadding(subMeshMaterial);

  min.x = minBounds[0] - boundsPadding;
  min.y = minBounds[1] - boundsPadding;
  min.z = minBounds[2] - boundsPadding;

  max.x = maxBounds[0] + boundsPadding;
  max.y = maxBounds[1] + boundsPadding;
  max.z = maxBounds[2] + boundsPadding;

      mesh.getBoundingInfo().reConstruct(min, max, mesh.getWorldMatrix());
      mesh.freezeWorldMatrix();

      mesh.material = this.renderer.materials.get(
        getBaseMaterialId(subMeshMaterial)
      )!._material;

      section.meshes.set(subMeshMaterial, mesh);

      if (!EngineSettings.settings.rendererSettings.cpuBound) {
        mesh.geometry!.clearCachedData();
        if (mesh.subMeshes) {
          for (const sm of mesh.subMeshes) {
            sm.setBoundingInfo(this.defaultBb);
          }
        }
      }
    }

    for (const [key, mesh] of section.meshes as Map<string, Mesh>) {
      if (!found.has(key)) {
        this.returnMesh(mesh);
        section.meshes.delete(key);
      }
    }
    } finally {
      found.clear();
    }

    return section;
  }
}
