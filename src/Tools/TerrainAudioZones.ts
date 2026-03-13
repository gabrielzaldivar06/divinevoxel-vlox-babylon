/**
 * TerrainAudioZones — R19
 *
 * Lightweight raycasting API that returns the terrain material family at any
 * world XZ position.  Designed for game-layer code that needs material-aware
 * audio feedback (footstep sounds, ambient loops, reverb zones, etc.) without
 * requiring mesher-side transport changes.
 *
 * Implementation note:
 *   Uses BabylonJS scene.pickWithRay() — a synchronous CPU pick against the
 *   live BVH.  Call once per footstep or at low frequency (≤ 4 Hz); avoid
 *   calling every frame for many entities simultaneously.
 */

import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Ray } from "@babylonjs/core/Culling/ray";
import {
  classifyTerrainMaterial,
  TerrainMaterialFamily,
} from "../Matereials/PBR/MaterialFamilyProfiles";

/**
 * Returns the terrain material family at a world XZ position by firing a
 * downward ray from `fromY` through the scene.
 *
 * @param scene     BabylonJS scene containing terrain meshes.
 * @param worldX    World-space X coordinate.
 * @param worldZ    World-space Z coordinate.
 * @param fromY     Ray origin Y (default 256). Must be above terrain surface.
 * @param maxDepth  Ray length in world units (default 300).
 * @returns The TerrainMaterialFamily of the first hit mesh, or `Default`.
 */
export function getMaterialFamilyAtWorldPos(
  scene: Scene,
  worldX: number,
  worldZ: number,
  fromY = 256,
  maxDepth = 300
): TerrainMaterialFamily {
  const ray = new Ray(
    new Vector3(worldX, fromY, worldZ),
    new Vector3(0, -1, 0),
    maxDepth
  );

  const pick = scene.pickWithRay(ray);
  if (pick?.hit && pick.pickedMesh?.material) {
    const mat = pick.pickedMesh.material;
    const matId: string = mat.id || mat.name || "";
    return classifyTerrainMaterial(matId).family;
  }

  return TerrainMaterialFamily.Default;
}
