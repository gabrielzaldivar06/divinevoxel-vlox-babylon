import { BoundingBox } from "@babylonjs/core/Culling/boundingBox";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";
import { MeshRegister } from "@divinevoxel/vlox/Renderer/MeshRegister";
import { WorldSpaces } from "@divinevoxel/vlox/World/WorldSpaces";
const min = new Vector3();
const max = new Vector3(16, 16, 16);
const boundingBox = new BoundingBox(min, max);
const addMeshes: Mesh[] = [];
const removedMeshes: Mesh[] = [];

function isTransitionGeometryMesh(mesh: Mesh) {
  return mesh.metadata?.transitionGeometry === true;
}

function exceedsTransitionGeometryDistance(mesh: Mesh, cameraPosition: Vector3) {
  if (!isTransitionGeometryMesh(mesh)) return false;

  const minDistance = EngineSettings.settings.terrain.transitionMeshMinDistance;
  const maxDistance = EngineSettings.settings.terrain.transitionMeshMaxDistance;
  if (
    (!Number.isFinite(maxDistance) || maxDistance <= 0) &&
    (!Number.isFinite(minDistance) || minDistance <= 0)
  ) {
    return false;
  }

  const distance = Vector3.Distance(mesh.getBoundingInfo().boundingBox.centerWorld, cameraPosition);
  if (Number.isFinite(minDistance) && minDistance > 0 && distance < minDistance) {
    return true;
  }
  if (Number.isFinite(maxDistance) && maxDistance > 0 && distance > maxDistance) {
    return true;
  }
  return false;
}

function CullSectors(scene: Scene) {
  const camera = scene.activeCamera;
  if (!camera) return;

  for (const [, dimension] of MeshRegister._dimensions) {
    for (const [, sector] of dimension) {
      min.set(sector.position[0], sector.position[1], sector.position[2]);
      max.set(
        sector.position[0] + WorldSpaces.sector.bounds.x,
        sector.position[1] + WorldSpaces.sector.bounds.y,
        sector.position[2] + WorldSpaces.sector.bounds.z
      );
      boundingBox.reConstruct(min, max);
      const sectorVisible = camera.isInFrustum(boundingBox);
      for (const section of sector.sections) {
        if (!section) continue;
        for (const [key, mesh] of section.meshes as Map<string, Mesh>) {
          if (!sectorVisible) {
            if (mesh.isEnabled()) {
              mesh.setEnabled(false);
              removedMeshes.push(mesh);
            }
            continue;
          }
          if (exceedsTransitionGeometryDistance(mesh, camera.globalPosition)) {
            if (mesh.isEnabled()) {
              mesh.setEnabled(false);
              removedMeshes.push(mesh);
            }
            continue;
          }
          if (camera.isInFrustum(mesh)) {
            if (!mesh.isEnabled()) {
              mesh.setEnabled(true);
              addMeshes.push(mesh);
            }
          } else {
            if (mesh.isEnabled()) {
              mesh.setEnabled(false);
              removedMeshes.push(mesh);
            }
          }
        }
      }
    }
  }

  for (let i = scene.meshes.length - 1; i > -1; i--) {
    if (removedMeshes.includes(scene.meshes[i] as Mesh)) {
      scene.meshes.splice(i, 1);
    }
  }
  for (const mesh of addMeshes) {
    if (!scene.meshes.includes(mesh)) {
      scene.meshes.push(mesh);
    }
  }
  addMeshes.length = 0;
  removedMeshes.length = 0;
}

export class DVEBRMeshCuller {
  init(scene: Scene, bufferMode: "single" | "multi") {
    if (bufferMode === "single") return;
    scene.registerBeforeRender(() => {
      CullSectors(scene);
    });
  }
}
