import { BoundingBox } from "@babylonjs/core/Culling/boundingBox";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";
import { MeshRegister } from "@divinevoxel/vlox/Renderer/MeshRegister";
import { WorldSpaces } from "@divinevoxel/vlox/World/WorldSpaces";
import { classifyTerrainMaterial } from "../Matereials/PBR/MaterialFamilyProfiles";
const min = new Vector3();
const max = new Vector3(16, 16, 16);
const boundingBox = new BoundingBox(min, max);
const addMeshes: Mesh[] = [];
const removedMeshes: Mesh[] = [];

/** Draw-call budget enforcement — tracks consecutive over-budget frames. */
let _budgetWarningCooldown = 0;
const _BUDGET_WARN_INTERVAL = 300; // frames between warnings
const sectorCenter = new Vector3();
const sectorDirection = new Vector3();
const forwardDirection = new Vector3();
const SECTOR_FRUSTUM_PADDING = 1;
const LIQUID_SECTOR_FRUSTUM_PADDING = 8;
// Lazily-computed squared near-distance below which viewCone culling is skipped.
// Sectors within 2× the sector diagonal are too close for the center-dot test
// to be reliable — the frustum check handles them correctly instead.
let _nearViewConeSq = 0;
function getNearViewConeSq() {
  if (_nearViewConeSq === 0) {
    const bx = WorldSpaces.sector.bounds.x;
    const by = WorldSpaces.sector.bounds.y;
    const bz = WorldSpaces.sector.bounds.z;
    const diag = Math.sqrt(bx * bx + by * by + bz * bz);
    _nearViewConeSq = (diag * 2) * (diag * 2);
  }
  return _nearViewConeSq;
}

function getPremiumResidentSectorDistance() {
  const terrain = EngineSettings.settings.terrain;
  const benchmarkPreset = String(terrain.benchmarkPreset || "");
  if (
    benchmarkPreset !== "pbr-premium" &&
    benchmarkPreset !== "pbr-premium-v2" &&
    benchmarkPreset !== "pbr-surface-lod"
  ) {
    return 0;
  }

  const sectorSize = Math.max(
    WorldSpaces.sector.bounds.x,
    WorldSpaces.sector.bounds.y,
    WorldSpaces.sector.bounds.z
  );
  const transitionMax = Number.isFinite(terrain.transitionMeshMaxDistance)
    ? terrain.transitionMeshMaxDistance
    : 0;
  return Math.max(sectorSize * 2, transitionMax + sectorSize);
}

function isResidentSector(sector: any, cameraPosition: Vector3) {
  const residentDistance = getPremiumResidentSectorDistance();
  if (residentDistance <= 0) return false;

  sectorCenter.set(
    sector.position[0] + WorldSpaces.sector.bounds.x * 0.5,
    sector.position[1] + WorldSpaces.sector.bounds.y * 0.5,
    sector.position[2] + WorldSpaces.sector.bounds.z * 0.5
  );

  return (
    getDistanceSquared(sectorCenter, cameraPosition) <=
    residentDistance * residentDistance
  );
}

function isTransitionGeometryMesh(mesh: Mesh) {
  return mesh.metadata?.transitionGeometry === true;
}

function isLiquidMaterialId(materialId?: string) {
  if (!materialId) return false;
  return classifyTerrainMaterial(materialId).isLiquid;
}

function sectorHasLiquidMeshes(sector: any) {
  for (const section of sector.sections) {
    if (!section) continue;
    for (const [, mesh] of section.meshes as Map<string, Mesh>) {
      if (isLiquidMaterialId(mesh.metadata?.baseMaterialId)) return true;
    }
  }
  return false;
}

function getDistanceSquared(a: Vector3, b: Vector3) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
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

  const distanceSquared = getDistanceSquared(
    mesh.getBoundingInfo().boundingBox.centerWorld,
    cameraPosition
  );
  if (
    Number.isFinite(minDistance) &&
    minDistance > 0 &&
    distanceSquared < minDistance * minDistance
  ) {
    return true;
  }
  if (
    Number.isFinite(maxDistance) &&
    maxDistance > 0 &&
    distanceSquared > maxDistance * maxDistance
  ) {
    return true;
  }
  return false;
}

function disableSectorMeshes(sector: any) {
  for (const section of sector.sections) {
    if (!section) continue;
    for (const [, mesh] of section.meshes as Map<string, Mesh>) {
      if (mesh.isEnabled()) {
        mesh.setEnabled(false);
        removedMeshes.push(mesh);
      }
    }
  }
}

function passesSectorCulling(sector: any, scene: Scene) {
  const camera = scene.activeCamera;
  if (!camera) return true;
  if (isResidentSector(sector, camera.globalPosition)) return true;

  const terrain = EngineSettings.settings.terrain;
  if (terrain.horizonCulling) {
    const sectorTop = sector.position[1] + WorldSpaces.sector.bounds.y;
    if (sectorTop > camera.globalPosition.y + terrain.horizonExtraHeight) {
      return false;
    }
  }

  if (terrain.viewConeCulling) {
    sectorCenter.set(
      sector.position[0] + WorldSpaces.sector.bounds.x * 0.5,
      sector.position[1] + WorldSpaces.sector.bounds.y * 0.5,
      sector.position[2] + WorldSpaces.sector.bounds.z * 0.5
    );
    sectorDirection.copyFrom(sectorCenter).subtractInPlace(camera.globalPosition);
    const sectorLengthSquared = sectorDirection.lengthSquared();
    if (sectorLengthSquared > 0.0001) {
      // Near-sector bypass: when the camera is within 2× the sector diagonal,
      // the sector subtends a large angle and the center-direction test becomes
      // unreliable — skip cone culling and let the frustum check decide.
      if (sectorLengthSquared < getNearViewConeSq()) return true;
      sectorDirection.scaleInPlace(1 / Math.sqrt(sectorLengthSquared));
      const cameraTarget = (camera as any).getTarget?.();
      if (cameraTarget) {
        forwardDirection
          .copyFrom(cameraTarget)
          .subtractInPlace(camera.globalPosition);
      } else {
        forwardDirection.set(0, 0, 1);
      }
      const forwardLengthSquared = forwardDirection.lengthSquared();
      if (forwardLengthSquared <= 0.0001) {
        return true;
      }
      forwardDirection.scaleInPlace(1 / Math.sqrt(forwardLengthSquared));
      if (Vector3.Dot(forwardDirection, sectorDirection) < terrain.viewConeThreshold) {
        return false;
      }
    }
  }

  return true;
}

function CullSectors(scene: Scene) {
  const camera = scene.activeCamera;
  if (!camera) return;
  const disableMeshCulling = scene.metadata?.disableMeshCulling === true;

  for (const [, dimension] of MeshRegister._dimensions) {
    for (const [, sector] of dimension) {
      const residentSector = isResidentSector(sector, camera.globalPosition);
      const sectorPadding = sectorHasLiquidMeshes(sector)
        ? LIQUID_SECTOR_FRUSTUM_PADDING
        : SECTOR_FRUSTUM_PADDING;
      min.set(
        sector.position[0] - sectorPadding,
        sector.position[1] - sectorPadding,
        sector.position[2] - sectorPadding
      );
      max.set(
        sector.position[0] + WorldSpaces.sector.bounds.x + sectorPadding,
        sector.position[1] + WorldSpaces.sector.bounds.y + sectorPadding,
        sector.position[2] + WorldSpaces.sector.bounds.z + sectorPadding
      );
      boundingBox.reConstruct(min, max);
      const sectorVisible =
        disableMeshCulling ||
        residentSector ||
        (camera.isInFrustum(boundingBox) && passesSectorCulling(sector, scene));
      if (!sectorVisible) {
        disableSectorMeshes(sector);
        continue;
      }
      for (const section of sector.sections) {
        if (!section) continue;
        for (const [key, mesh] of section.meshes as Map<string, Mesh>) {
          if (exceedsTransitionGeometryDistance(mesh, camera.globalPosition)) {
            if (mesh.isEnabled()) {
              mesh.setEnabled(false);
              removedMeshes.push(mesh);
            }
            continue;
          }
          if (
            disableMeshCulling ||
            residentSector ||
            camera.isInFrustum(mesh.getBoundingInfo())
          ) {
            if (!mesh.isEnabled()) {
              mesh.computeWorldMatrix(true);
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

  // Draw-call budget enforcement
  const budget = EngineSettings.settings.terrain.maxSceneMeshes;
  const activeMeshCount = scene.meshes.length;
  if (activeMeshCount > budget) {
    if (_budgetWarningCooldown <= 0) {
      console.warn(
        `[DVE] Scene mesh budget exceeded: ${activeMeshCount}/${budget} active meshes. ` +
        `Each mesh = 1+ draw call per render pass. ` +
        `Increase terrain.maxSceneMeshes or reduce visible sections/materials.`
      );
      _budgetWarningCooldown = _BUDGET_WARN_INTERVAL;
    } else {
      _budgetWarningCooldown--;
    }
  } else {
    _budgetWarningCooldown = Math.max(0, _budgetWarningCooldown - 1);
  }
}

export class DVEBRMeshCuller {
  init(scene: Scene, bufferMode: "single" | "multi") {
    if (bufferMode === "single") return;
    scene.registerBeforeRender(() => {
      CullSectors(scene);
    });
  }
}
