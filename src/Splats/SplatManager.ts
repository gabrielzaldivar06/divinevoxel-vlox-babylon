/**
 * SplatManager — Fase 3 Entregable 3.4, 3.6 + Fase 5 Entregable 5.4, 5.5, 5.7
 *
 * Coordinates DissolutionSplatEmitter → DVEGaussianSplatRenderer.
 * Hooks into MeshManager via the onSectionUpdated / onSectorRemoved
 * callbacks added to MeshManager. On each section mesh update, checks
 * whether the material is organic, emits splats, and registers them
 * with the renderer keyed by sector.
 *
 * Fase 5: Dynamic fracture splats with physics (gravity, velocity, fade).
 * Fracture events are enqueued via handleVoxelErased() and processed
 * through DynamicSplatPool with rate limiting.
 */

import { Scene } from "@babylonjs/core/scene";
import { DVEGaussianSplatRenderer } from "./DVEGaussianSplatRenderer";
import {
  emitDissolutionSplats,
  SplatPhysics,
  EmitOptions,
} from "./DissolutionSplatEmitter";
import {
  classifyTerrainMaterial,
  TerrainMaterialFamily,
} from "../Matereials/PBR/MaterialFamilyProfiles";
import { getBaseMaterialId } from "@divinevoxel/vlox/Mesher/Voxels/Models/TransitionMaterialIds";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings";
import { DynamicSplatPool } from "./DynamicSplatPool";
import { emitFractureSplats } from "./FractureSplatEmitter";
import {
  emitAtmosphericSplats,
  AtmosphericEmitOptions,
} from "./AtmosphericSplatEmitter";

/** Default physics estimates by material family. */
function defaultPhysics(family: string): SplatPhysics {
  switch (family) {
    case TerrainMaterialFamily.Soil:
      return { adhesion: 0.55, porosity: 0.3, shearStrength: 80 };
    case TerrainMaterialFamily.Flora:
      return { adhesion: 0.3, porosity: 0.4, shearStrength: 40 };
    case TerrainMaterialFamily.Wood:
      return { adhesion: 0.6, porosity: 0.15, shearStrength: 200 };
    case TerrainMaterialFamily.Cultivated:
      return { adhesion: 0.5, porosity: 0.35, shearStrength: 60 };
    case TerrainMaterialFamily.Rock:
      return { adhesion: 0.1, porosity: 0.05, shearStrength: 500 };
    case TerrainMaterialFamily.Exotic:
      return { adhesion: 0.3, porosity: 0.2, shearStrength: 150 };
    default:
      return { adhesion: 0.2, porosity: 0.1, shearStrength: 100 };
  }
}

/**
 * Build a composite sector key from location data.
 * Format: "dim_x_y_z" — unique per section within a sector.
 */
function sectionKey(
  sectionOrigin: [number, number, number],
  materialId: string
): string {
  return `${sectionOrigin[0]}_${sectionOrigin[1]}_${sectionOrigin[2]}_${materialId}`;
}

export interface SplatMeshUpdate {
  materialId: string;
  vertices: Float32Array;
  sectionOrigin: [number, number, number];
}

export class SplatManager {
  private _renderer: DVEGaussianSplatRenderer;
  private _physicsOverrides = new Map<string, SplatPhysics>();
  /** Track which section keys are active so we can clean up on sector remove */
  private _activeSections = new Map<string, Set<string>>();
  /** Track atmospheric splat keys separately */
  private _activeAtmospheric = new Map<string, Set<string>>();
  private _disposed = false;

  /** Fase 5: Dynamic fracture splat pool with physics. */
  private _dynamicPool: DynamicSplatPool;
  private _lastTime = 0;

  constructor(scene: Scene) {
    this._renderer = new DVEGaussianSplatRenderer(scene);
    this._dynamicPool = new DynamicSplatPool(500);
    this._lastTime = performance.now() * 0.001;

    // Per-frame update
    scene.registerBeforeRender(() => {
      if (this._disposed) return;

      // Dynamic pool physics update
      const now = performance.now() * 0.001;
      const dt = Math.min(now - this._lastTime, 0.1); // Cap at 100ms
      this._lastTime = now;

      this._renderer.clearDynamicSplats();
      const aliveSplats = this._dynamicPool.update(dt);
      if (aliveSplats.length > 0) {
        this._renderer.addDynamicSplats(aliveSplats);
      }

      this._renderer.update();
    });
  }

  /** Register exact physics for a material (overrides family default). */
  registerPhysics(materialId: string, physics: SplatPhysics) {
    this._physicsOverrides.set(materialId, physics);
  }

  /**
   * Called when a section mesh is created or updated.
   * Iterates the sub-meshes, emits splats for organic materials,
   * and registers them with the renderer.
   */
  processSectionMeshes(
    sectorKey: string,
    meshUpdates: SplatMeshUpdate[]
  ) {
    if (!EngineSettings.settings.terrain.dissolutionSplats) return;

    // Ensure we have a set for this sector
    if (!this._activeSections.has(sectorKey)) {
      this._activeSections.set(sectorKey, new Set());
    }
    const active = this._activeSections.get(sectorKey)!;

    const newKeys = new Set<string>();

    for (const update of meshUpdates) {
      const baseMat = getBaseMaterialId(update.materialId);
      const classification = classifyTerrainMaterial(baseMat);

      // Skip non-organic materials — no dissolution splats for liquids, transparent
      if (classification.isLiquid || classification.isTransparent) continue;

      const physics =
        this._physicsOverrides.get(baseMat) ??
        defaultPhysics(classification.family);

      const key = sectionKey(update.sectionOrigin, update.materialId);
      newKeys.add(key);

      const options: EmitOptions = {
        sectionOrigin: update.sectionOrigin,
        materialId: baseMat,
        physics,
      };

      const splats = emitDissolutionSplats(update.vertices, options);

      // Remove old splats for this key if any, then add new
      this._renderer.removeStaticSplats(key);
      if (splats.length > 0) {
        this._renderer.addStaticSplats(key, splats);
      }
    }

    // Atmospheric splats (S1): emit ambient particles around dissolution zones
    if (EngineSettings.settings.terrain.atmosphericSplats) {
      if (!this._activeAtmospheric.has(sectorKey)) {
        this._activeAtmospheric.set(sectorKey, new Set());
      }
      const activeAtmo = this._activeAtmospheric.get(sectorKey)!;
      const newAtmoKeys = new Set<string>();

      for (const update of meshUpdates) {
        const baseMat = getBaseMaterialId(update.materialId);
        const atmoKey = `atmo_${sectionKey(update.sectionOrigin, update.materialId)}`;
        newAtmoKeys.add(atmoKey);

        const atmoOptions: AtmosphericEmitOptions = {
          sectionOrigin: update.sectionOrigin,
          materialId: baseMat,
        };

        const atmoSplats = emitAtmosphericSplats(update.vertices, atmoOptions);
        this._renderer.removeStaticSplats(atmoKey);
        if (atmoSplats.length > 0) {
          this._renderer.addStaticSplats(atmoKey, atmoSplats);
        }
      }

      for (const oldKey of activeAtmo) {
        if (!newAtmoKeys.has(oldKey)) {
          this._renderer.removeStaticSplats(oldKey);
        }
      }
      this._activeAtmospheric.set(sectorKey, newAtmoKeys);
    }

    // Clean up old section keys that are no longer present
    for (const oldKey of active) {
      if (!newKeys.has(oldKey)) {
        this._renderer.removeStaticSplats(oldKey);
      }
    }

    // Update tracking
    this._activeSections.set(sectorKey, newKeys);
  }

  /**
   * Called when a sector is removed. Cleans up all splats for that sector.
   */
  removeSector(sectorKey: string) {
    const active = this._activeSections.get(sectorKey);
    if (active) {
      for (const key of active) {
        this._renderer.removeStaticSplats(key);
      }
      this._activeSections.delete(sectorKey);
    }
    const activeAtmo = this._activeAtmospheric.get(sectorKey);
    if (activeAtmo) {
      for (const key of activeAtmo) {
        this._renderer.removeStaticSplats(key);
      }
      this._activeAtmospheric.delete(sectorKey);
    }
  }

  get renderer(): DVEGaussianSplatRenderer {
    return this._renderer;
  }

  /**
   * Fase 5: Handle a voxel erase event.
   * Generates fracture splats based on the material family + physics.
   *
   * @param x World X of destroyed voxel
   * @param y World Y of destroyed voxel
   * @param z World Z of destroyed voxel
   * @param family Material family string
   * @param shearStrength Physics shear strength
   * @param color RGB [0-255] color of the voxel
   */
  handleVoxelErased(
    x: number,
    y: number,
    z: number,
    family: string,
    shearStrength: number,
    color: [number, number, number]
  ) {
    const splats = emitFractureSplats(x, y, z, family, shearStrength, color);
    this._dynamicPool.enqueue(splats);
  }

  dispose() {
    this._disposed = true;
    this._renderer.dispose();
    this._dynamicPool.dispose();
    this._activeSections.clear();
    this._activeAtmospheric.clear();
  }
}
