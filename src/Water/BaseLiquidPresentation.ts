import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";
import { classifyTerrainMaterial } from "../Matereials/PBR/MaterialFamilyProfiles";

type BaseLiquidShadowGenerator = {
  addShadowCaster: (mesh: Mesh) => void;
  removeShadowCaster: (mesh: Mesh) => void;
};

export type BaseLiquidSectionMeshLike = {
  baseMaterialId?: string;
  metadata?: Record<string, any>;
  allowBaseLiquid?: boolean;
};

export function shouldUseLegacyLiquidBaseMeshes() {
  return (
    EngineSettings.settings.water.largeWaterVisibleMode === "legacy" ||
    (globalThis as any).__DVE_FORCE_LEGACY_LIQUID_GEOMETRY__ === true
  );
}

export function shouldHideBaseLiquidMeshes() {
  return false;
}

export function getBaseLiquidMaterialId(mesh: BaseLiquidSectionMeshLike) {
  return mesh.metadata?.baseMaterialId || mesh.baseMaterialId || "";
}

export function isBaseLiquidMesh(mesh: BaseLiquidSectionMeshLike) {
  return classifyTerrainMaterial(getBaseLiquidMaterialId(mesh)).isLiquid;
}

export function getBaseLiquidAllowance(mesh: BaseLiquidSectionMeshLike) {
  if (mesh.metadata?.allowBaseLiquid !== undefined) {
    return mesh.metadata.allowBaseLiquid === true;
  }
  return mesh.allowBaseLiquid === true;
}

export function setBaseLiquidAllowance(
  mesh: BaseLiquidSectionMeshLike,
  allowBaseLiquid: boolean,
) {
  if (mesh.metadata) {
    mesh.metadata = {
      ...mesh.metadata,
      allowBaseLiquid,
    };
    return;
  }
  mesh.allowBaseLiquid = allowBaseLiquid;
}

export function setBaseLiquidShadowEligibility(
  mesh: Mesh,
  allowBaseLiquid: boolean,
  shadowGenerator?: BaseLiquidShadowGenerator,
) {
  if (allowBaseLiquid) {
    mesh.receiveShadows = true;
    shadowGenerator?.addShadowCaster(mesh);
    return;
  }
  mesh.receiveShadows = false;
  shadowGenerator?.removeShadowCaster(mesh);
}
